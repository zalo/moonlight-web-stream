#![feature(if_let_guard)]
#![feature(async_fn_traits)]

use std::{
    collections::HashMap,
    panic,
    process::exit,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

use common::{
    StreamSettings,
    api_bindings::{GeneralServerMessage, LogMessageType, StreamClientMessage, TransportType},
    ipc::{
        IpcReceiver, IpcSender, ServerIpcMessage, StreamerConfig, StreamerIpcMessage,
        create_process_ipc,
    },
};
use log::{LevelFilter, debug, error, info, trace, warn};
use moonlight_common::{
    MoonlightError,
    high::{HostError, MoonlightHost},
    network::backend::reqwest::ReqwestClient,
    pair::ClientAuth,
    stream::{
        MoonlightInstance, MoonlightStream,
        bindings::{
            ActiveGamepads, ColorRange, ConnectionStatus, ControllerButtons, EncryptionFlags,
            HostFeatures, OpusMultistreamConfig, Stage, VideoFormat,
        },
        connection::ConnectionListener,
        video::VideoSetup,
    },
};
use simplelog::{ColorChoice, TermLogger, TerminalMode};
use tokio::{
    io::{stdin, stdout},
    runtime::Handle,
    spawn,
    sync::{Mutex, Notify, RwLock},
    task::spawn_blocking,
};

use common::api_bindings::{StreamCapabilities, StreamServerMessage};

use crate::{
    audio::StreamAudioDecoder,
    peer_manager::PeerManager,
    transport::{
        InboundPacket, OutboundPacket, TransportError, TransportEvent, TransportEvents,
        TransportSender, web_socket, webrtc,
    },
    video::StreamVideoDecoder,
};
use common::ipc::PeerId;

/// Holds transport sender and events for a peer
struct PeerTransport {
    sender: Box<dyn TransportSender + Send + Sync + 'static>,
    // The events task handle - kept alive while transport is active
    _events_task: tokio::task::JoinHandle<()>,
}

pub type RequestClient = ReqwestClient;

mod audio;
mod buffer;
mod convert;
mod peer_manager;
mod transport;
mod video;

#[tokio::main]
async fn main() {
    let default_panic = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        default_panic(info);
        exit(0);
    }));

    // At this point we're authenticated
    let (mut ipc_sender, mut ipc_receiver) =
        create_process_ipc::<ServerIpcMessage, StreamerIpcMessage>(stdin(), stdout()).await;

    // Send stage
    ipc_sender
        .send(StreamerIpcMessage::WebSocket(
            StreamServerMessage::DebugLog {
                message: "Completed Stage: Launch Streamer".to_string(),
                ty: None,
            },
        ))
        .await;

    let (
        config,
        host_address,
        host_http_port,
        client_unique_id,
        client_private_key,
        client_certificate,
        server_certificate,
        app_id,
        video_frame_queue_size,
        audio_sample_queue_size,
    ) = loop {
        match ipc_receiver.recv().await {
            Some(ServerIpcMessage::Init {
                config,
                host_address,
                host_http_port,
                client_unique_id,
                client_private_key,
                client_certificate,
                server_certificate,
                app_id,
                video_frame_queue_size,
                audio_sample_queue_size,
            }) => {
                break (
                    config,
                    host_address,
                    host_http_port,
                    client_unique_id,
                    client_private_key,
                    client_certificate,
                    server_certificate,
                    app_id,
                    video_frame_queue_size,
                    audio_sample_queue_size,
                );
            }
            _ => continue,
        }
    };

    TermLogger::init(
        config.log_level,
        simplelog::ConfigBuilder::new()
            .add_filter_ignore_str("webrtc_sctp")
            .set_time_level(LevelFilter::Off)
            .build(),
        TerminalMode::Stderr,
        ColorChoice::Never,
    )
    .expect("failed to init logger");

    // Send stage
    ipc_sender
        .send(StreamerIpcMessage::WebSocket(
            StreamServerMessage::DebugLog {
                message: "Waiting for Transport to negotiate".to_string(),
                ty: None,
            },
        ))
        .await;

    // -- Create the host and pair it
    let mut host = MoonlightHost::new(host_address, host_http_port, client_unique_id)
        .expect("failed to create host");

    host.set_pairing_info(
        &ClientAuth {
            certificate: client_certificate,
            private_key: client_private_key,
        },
        &server_certificate,
    )
    .expect("failed to set pairing info");

    // -- Configure moonlight
    let moonlight = MoonlightInstance::global().expect("failed to find moonlight");

    // -- Create and Configure Peer
    let connection = StreamConnection::new(
        moonlight,
        StreamInfo {
            host: Mutex::new(host),
            app_id,
        },
        ipc_sender.clone(),
        ipc_receiver,
        config,
        video_frame_queue_size,
        audio_sample_queue_size,
    )
    .await
    .expect("failed to create connection");

    // Send Info for streamer
    ipc_sender
        .send(StreamerIpcMessage::WebSocket(StreamServerMessage::Setup {
            ice_servers: connection.config.webrtc.ice_servers.clone(),
        }))
        .await;

    // Wait for termination
    connection.terminate.notified().await;

    // Exit streamer
    exit(0);
}

struct StreamInfo {
    host: Mutex<MoonlightHost<RequestClient>>,
    app_id: u32,
}

struct StreamSetup {
    video: Option<VideoSetup>,
    audio: Option<OpusMultistreamConfig>,
}

struct StreamConnection {
    pub runtime: Handle,
    pub moonlight: MoonlightInstance,
    pub config: StreamerConfig,
    pub info: StreamInfo,
    pub ipc_sender: IpcSender<StreamerIpcMessage>,
    // Video
    pub video_frame_queue_size: usize,
    pub audio_sample_queue_size: usize,
    pub stream_setup: Mutex<StreamSetup>,
    // Stream
    pub stream: RwLock<Option<MoonlightStream>>,
    pub active_gamepads: RwLock<ActiveGamepads>,
    /// Per-peer transports - each peer can have their own WebRTC or WebSocket transport
    pub peer_transports: RwLock<HashMap<PeerId, PeerTransport>>,
    pub terminate: Notify,
    is_terminating: AtomicBool,
    // Multi-peer support
    pub peer_manager: RwLock<PeerManager>,
    /// Current peer context for input handling (set during packet processing)
    pub current_peer_id: RwLock<Option<PeerId>>,
}

impl StreamConnection {
    pub async fn new(
        moonlight: MoonlightInstance,
        info: StreamInfo,
        ipc_sender: IpcSender<StreamerIpcMessage>,
        mut ipc_receiver: IpcReceiver<ServerIpcMessage>,
        config: StreamerConfig,
        video_frame_queue_size: usize,
        audio_sample_queue_size: usize,
    ) -> Result<Arc<Self>, anyhow::Error> {
        let this = Arc::new(Self {
            runtime: Handle::current(),
            moonlight,
            config,
            info,
            ipc_sender,
            stream_setup: Mutex::new(StreamSetup {
                video: None,
                audio: None,
            }),
            video_frame_queue_size,
            audio_sample_queue_size,
            stream: RwLock::new(None),
            active_gamepads: RwLock::new(ActiveGamepads::empty()),
            peer_transports: RwLock::new(HashMap::new()),
            terminate: Notify::default(),
            is_terminating: AtomicBool::new(false),
            peer_manager: RwLock::new(PeerManager::new()),
            current_peer_id: RwLock::new(None),
        });

        spawn({
            let this = Arc::downgrade(&this);

            async move {
                while let Some(message) = ipc_receiver.recv().await {
                    let Some(this) = this.upgrade() else {
                        debug!("Received ipc message while the main type is already deallocated");
                        return;
                    };

                    if let ServerIpcMessage::Stop = &message {
                        this.on_ipc_message(ServerIpcMessage::Stop).await;
                        return;
                    }

                    this.on_ipc_message(message).await;
                }
            }
        });

        Ok(this)
    }

    /// Set transport for a specific peer
    async fn set_peer_transport(
        self: &Arc<Self>,
        peer_id: PeerId,
        new_sender: Box<dyn TransportSender + Send + Sync + 'static>,
        mut events: Box<dyn TransportEvents + Send + Sync + 'static>,
    ) {
        let this = self.clone();

        // Remove old transport for this peer if exists
        let old_transport = {
            let mut transports = this.peer_transports.write().await;
            transports.remove(&peer_id).map(|pt| pt.sender)
        };

        // Spawn task to handle events from this peer's transport
        let events_task = spawn({
            let mut ipc_sender = this.ipc_sender.clone();
            let this = Arc::downgrade(&this);
            let peer_id = peer_id;

            async move {
                loop {
                    trace!("Polling transport event for peer {:?}", peer_id);
                    let event = events.poll_event().await;
                    trace!("Polled transport event for peer {:?}: {:?}", peer_id, event);

                    match event {
                        Ok(TransportEvent::SendIpc(message)) => {
                            // Route IPC message through peer-specific channel
                            let peer_message = match message {
                                StreamerIpcMessage::WebSocket(msg) => {
                                    StreamerIpcMessage::PeerWebSocket { peer_id, message: msg }
                                }
                                StreamerIpcMessage::WebSocketTransport(data) => {
                                    StreamerIpcMessage::PeerWebSocketTransport { peer_id, data }
                                }
                                other => other,
                            };
                            ipc_sender.send(peer_message).await;
                        }
                        Ok(TransportEvent::StartStream { settings }) => {
                            let Some(this) = this.upgrade() else {
                                warn!(
                                    "Failed to get stream connection, stopping listening to events"
                                );
                                return;
                            };

                            let this = this.clone();
                            spawn(async move {
                                if let Err(err) = this.start_stream(settings).await {
                                    error!("Failed to start stream, stopping: {err}");

                                    this.stop().await;
                                }
                            });
                        }
                        Ok(TransportEvent::RecvPacket(packet)) => {
                            let Some(this) = this.upgrade() else {
                                warn!(
                                    "Failed to get stream connection, stopping listening to events"
                                );
                                return;
                            };

                            // Set current peer context before processing packet
                            {
                                let mut current = this.current_peer_id.write().await;
                                *current = Some(peer_id);
                            }

                            this.on_packet(packet).await;
                        }
                        Err(TransportError::Closed) | Ok(TransportEvent::Closed) => {
                            info!("Transport closed for peer {:?}", peer_id);
                            break;
                        }
                        // It wouldn't make sense to return this
                        Err(TransportError::ChannelClosed) => unreachable!(),
                        Err(TransportError::Implementation(err)) => {
                            let Some(this) = this.upgrade() else {
                                warn!(
                                    "Failed to get stream connection, stopping listening to events"
                                );
                                return;
                            };

                            info!(
                                "Transport error for peer {:?}: {err}",
                                peer_id
                            );

                            // Remove this peer's transport on error
                            {
                                let mut transports = this.peer_transports.write().await;
                                transports.remove(&peer_id);
                            }
                            break;
                        }
                    }
                }
            }
        });

        // Store the new transport
        {
            let mut transports = this.peer_transports.write().await;
            transports.insert(peer_id, PeerTransport {
                sender: new_sender,
                _events_task: events_task,
            });
        }

        if let Some(old_transport) = old_transport {
            spawn(async move {
                if let Err(err) = old_transport.close().await {
                    warn!("Failed to close old transport for peer: {err:?}");
                }
            });
        }
    }

    /// Remove transport for a peer (called when peer disconnects)
    async fn remove_peer_transport(&self, peer_id: PeerId) {
        let transport = {
            let mut transports = self.peer_transports.write().await;
            transports.remove(&peer_id)
        };

        if let Some(transport) = transport {
            if let Err(err) = transport.sender.close().await {
                warn!("Failed to close transport for peer {:?}: {err:?}", peer_id);
            }
        }
    }
    /// Send packet to all connected peer transports
    async fn try_send_packet(&self, packet: OutboundPacket, packet_ty: &str, should_warn: bool) {
        let transports = self.peer_transports.read().await;

        if transports.is_empty() {
            debug!("Dropping packet {packet:?} because no transports are connected!");
            return;
        }

        // Serialize packet once, send to all transports
        for (peer_id, transport) in transports.iter() {
            // Clone the packet for each transport (OutboundPacket is small/cheap to clone)
            let packet_clone = match &packet {
                OutboundPacket::General { message } => OutboundPacket::General { message: message.clone() },
                OutboundPacket::Stats(stats) => OutboundPacket::Stats(stats.clone()),
                OutboundPacket::ControllerRumble { controller_number, low_frequency_motor, high_frequency_motor } => {
                    OutboundPacket::ControllerRumble {
                        controller_number: *controller_number,
                        low_frequency_motor: *low_frequency_motor,
                        high_frequency_motor: *high_frequency_motor,
                    }
                }
                OutboundPacket::ControllerTriggerRumble { controller_number, left_trigger_motor, right_trigger_motor } => {
                    OutboundPacket::ControllerTriggerRumble {
                        controller_number: *controller_number,
                        left_trigger_motor: *left_trigger_motor,
                        right_trigger_motor: *right_trigger_motor,
                    }
                }
            };

            if let Err(err) = transport.sender.send(packet_clone).await {
                if should_warn {
                    warn!("Failed to send outbound packet to peer {:?}: {packet_ty}, {err:?}", peer_id);
                } else {
                    debug!("Failed to send outbound packet to peer {:?}: {packet_ty}, {err:?}", peer_id);
                }
            }
        }
    }

    async fn on_packet(&self, packet: InboundPacket) {
        let stream = self.stream.read().await;
        let Some(stream) = stream.as_ref() else {
            warn!("Failed to send packet {packet:?} because of missing stream");
            return;
        };

        // Get current peer ID for input filtering/mapping
        let current_peer = *self.current_peer_id.read().await;
        let peer_manager = self.peer_manager.read().await;

        // Helper to check if current peer can use keyboard/mouse
        let can_use_keyboard_mouse = current_peer
            .map(|pid| peer_manager.can_use_keyboard_mouse(pid))
            .unwrap_or(true); // Allow if no peer context (backwards compat)

        let err = match packet {
            InboundPacket::General { message } => {
                // currently there are no packets associated with that
                match message {}
            }
            InboundPacket::MousePosition {
                x,
                y,
                reference_width,
                reference_height,
            } => {
                if !can_use_keyboard_mouse {
                    debug!("Ignoring mouse position from non-Player 1");
                    return;
                }
                stream
                    .send_mouse_position(x, y, reference_width, reference_height)
                    .err()
            }
            InboundPacket::MouseButton { action, button } => {
                if !can_use_keyboard_mouse {
                    debug!("Ignoring mouse button from non-Player 1");
                    return;
                }
                stream.send_mouse_button(action, button).err()
            }
            InboundPacket::MouseMove { delta_x, delta_y } => {
                if !can_use_keyboard_mouse {
                    debug!("Ignoring mouse move from non-Player 1");
                    return;
                }
                stream.send_mouse_move(delta_x, delta_y).err()
            }
            InboundPacket::HighResScroll { delta_x, delta_y } => {
                if !can_use_keyboard_mouse {
                    debug!("Ignoring scroll from non-Player 1");
                    return;
                }
                let mut err = None;
                if delta_y != 0 {
                    err = stream.send_high_res_scroll(delta_y).err()
                }
                if delta_x != 0 {
                    err = stream.send_high_res_horizontal_scroll(delta_x).err()
                }
                err
            }
            InboundPacket::Scroll { delta_x, delta_y } => {
                if !can_use_keyboard_mouse {
                    debug!("Ignoring scroll from non-Player 1");
                    return;
                }
                let mut err = None;
                if delta_y != 0 {
                    err = stream.send_scroll(delta_y).err();
                }
                if delta_x != 0 {
                    err = stream.send_horizontal_scroll(delta_x).err();
                }
                err
            }
            InboundPacket::Key {
                action,
                modifiers,
                key,
                flags,
            } => {
                if !can_use_keyboard_mouse {
                    debug!("Ignoring keyboard from non-Player 1");
                    return;
                }
                stream
                    .send_keyboard_event_non_standard(key as i16, action, modifiers, flags)
                    .err()
            }
            InboundPacket::Text { text } => {
                if !can_use_keyboard_mouse {
                    debug!("Ignoring text input from non-Player 1");
                    return;
                }
                stream.send_text(&text).err()
            }
            InboundPacket::Touch {
                pointer_id,
                x,
                y,
                pressure_or_distance,
                contact_area_major,
                contact_area_minor,
                rotation,
                event_type,
            } => {
                if !can_use_keyboard_mouse {
                    debug!("Ignoring touch from non-Player 1");
                    return;
                }
                stream
                    .send_touch(
                        pointer_id,
                        x,
                        y,
                        pressure_or_distance,
                        contact_area_major,
                        contact_area_minor,
                        rotation,
                        event_type,
                    )
                    .err()
            }
            InboundPacket::ControllerConnected {
                id,
                ty,
                supported_buttons,
                capabilities,
            } => {
                // Map the browser's gamepad ID to the actual slot based on player
                let mapped_id = if let Some(peer_id) = current_peer {
                    match peer_manager.map_gamepad_id(peer_id, id) {
                        Some(mapped) => mapped,
                        None => {
                            debug!("Ignoring gamepad {} from peer {:?}", id, peer_id);
                            return;
                        }
                    }
                } else {
                    id // No peer context, use original ID
                };

                let Some(gamepad) = ActiveGamepads::from_id(mapped_id) else {
                    warn!("Failed to add gamepad because it is out of range: {mapped_id}");
                    return;
                };

                let mut active_gamepads = self.active_gamepads.write().await;

                active_gamepads.insert(gamepad);

                stream
                    .send_controller_arrival(
                        mapped_id,
                        *active_gamepads,
                        ty,
                        supported_buttons,
                        capabilities,
                    )
                    .err()
            }
            InboundPacket::ControllerDisconnected { id } => {
                // Map the browser's gamepad ID to the actual slot based on player
                let mapped_id = if let Some(peer_id) = current_peer {
                    match peer_manager.map_gamepad_id(peer_id, id) {
                        Some(mapped) => mapped,
                        None => {
                            debug!("Ignoring gamepad disconnect {} from peer {:?}", id, peer_id);
                            return;
                        }
                    }
                } else {
                    id
                };

                let Some(gamepad) = ActiveGamepads::from_id(mapped_id) else {
                    warn!("Failed to remove gamepad because it is out of range: {mapped_id}");
                    return;
                };

                let mut active_gamepads = self.active_gamepads.write().await;
                active_gamepads.remove(gamepad);

                stream
                    .send_multi_controller(
                        mapped_id,
                        *active_gamepads,
                        ControllerButtons::empty(),
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                    )
                    .err()
            }
            InboundPacket::ControllerState {
                id,
                buttons,
                left_trigger,
                right_trigger,
                left_stick_x,
                left_stick_y,
                right_stick_x,
                right_stick_y,
            } => {
                // Map the browser's gamepad ID to the actual slot based on player
                let mapped_id = if let Some(peer_id) = current_peer {
                    match peer_manager.map_gamepad_id(peer_id, id) {
                        Some(mapped) => mapped,
                        None => {
                            // Silently drop - this is frequent during gameplay
                            return;
                        }
                    }
                } else {
                    id
                };

                let Some(gamepad) = ActiveGamepads::from_id(mapped_id) else {
                    warn!("Failed to update gamepad state because it is out of range: {mapped_id}");
                    return;
                };

                let active_gamepads = self.active_gamepads.read().await;
                if !active_gamepads.contains(gamepad) {
                    warn!(
                        "Failed to send gamepad event for not registered gamepad, gamepad: {mapped_id}, currently active: {:?}",
                        *active_gamepads
                    );
                    return;
                }

                stream
                    .send_multi_controller(
                        mapped_id,
                        *active_gamepads,
                        buttons,
                        left_trigger,
                        right_trigger,
                        left_stick_x,
                        left_stick_y,
                        right_stick_x,
                        right_stick_y,
                    )
                    .err()
            }
        };

        if let Some(err) = err {
            warn!("Failed to handle packet: {err:?}");
        }
    }

    async fn on_ipc_message(self: &Arc<StreamConnection>, message: ServerIpcMessage) {
        // Handle peer management messages and transform peer-specific messages
        // to their base versions (avoiding recursion)
        let (message, current_peer_id) = match message {
            ServerIpcMessage::PeerConnected {
                peer_id,
                player_slot,
                role,
                video_frame_queue_size,
                audio_sample_queue_size,
            } => {
                info!(
                    "Peer {:?} connected as {:?} (slot: {:?})",
                    peer_id, role, player_slot
                );
                let mut peer_manager = self.peer_manager.write().await;
                peer_manager.add_peer(
                    peer_id,
                    player_slot,
                    role,
                    video_frame_queue_size,
                    audio_sample_queue_size,
                );
                return;
            }
            ServerIpcMessage::PeerRoleChanged {
                peer_id,
                new_role,
                player_slot,
            } => {
                info!(
                    "Peer {:?} role changed to {:?} (slot: {:?})",
                    peer_id, new_role, player_slot
                );
                let mut peer_manager = self.peer_manager.write().await;
                peer_manager.update_peer_role(peer_id, new_role, player_slot);
                return;
            }
            ServerIpcMessage::PeerDisconnected { peer_id } => {
                info!("Peer {:?} disconnected", peer_id);
                let mut peer_manager = self.peer_manager.write().await;
                peer_manager.remove_peer(peer_id);
                // Also remove their transport
                self.remove_peer_transport(peer_id).await;
                return;
            }
            ServerIpcMessage::PeerWebSocket { peer_id, message } => {
                // Set current peer context for input handling
                {
                    let mut current = self.current_peer_id.write().await;
                    *current = Some(peer_id);
                }
                // Return message with peer context
                (ServerIpcMessage::WebSocket(message), Some(peer_id))
            }
            ServerIpcMessage::PeerWebSocketTransport { peer_id, data } => {
                // Set current peer context for input handling
                {
                    let mut current = self.current_peer_id.write().await;
                    *current = Some(peer_id);
                }
                // Return message with peer context
                (ServerIpcMessage::WebSocketTransport(data), Some(peer_id))
            }
            ServerIpcMessage::SetGuestsKeyboardMouseEnabled { enabled } => {
                info!("Setting guests keyboard/mouse enabled: {}", enabled);
                let mut peer_manager = self.peer_manager.write().await;
                peer_manager.set_guests_keyboard_mouse_enabled(enabled);
                return;
            }
            other => (other, None),
        };

        // Handle SetTransport per peer
        if let ServerIpcMessage::WebSocket(StreamClientMessage::SetTransport(transport_type)) =
            &message
        {
            let peer_id = current_peer_id.unwrap_or(PeerId(0)); // Default to peer 0 for backwards compat

            match transport_type {
                TransportType::WebRTC => {
                    info!("Peer {:?} trying WebRTC transport", peer_id);

                    // Get peer info for queue sizes
                    let (video_queue, audio_queue) = {
                        let peer_manager = self.peer_manager.read().await;
                        peer_manager.get_peer_queue_sizes(peer_id)
                            .unwrap_or((self.video_frame_queue_size, self.audio_sample_queue_size))
                    };

                    let (sender, events) = match webrtc::new(
                        &self.config.webrtc,
                        video_queue,
                        audio_queue,
                    )
                    .await
                    {
                        Ok(value) => value,
                        Err(err) => {
                            error!("Failed to start webrtc transport for peer {:?}: {err}", peer_id);
                            return;
                        }
                    };
                    self.set_peer_transport(peer_id, Box::new(sender), Box::new(events)).await;
                }
                TransportType::WebSocket => {
                    info!("Peer {:?} trying Web Socket transport", peer_id);

                    let (sender, events) = match web_socket::new().await {
                        Ok(value) => value,
                        Err(err) => {
                            error!("Failed to start web socket transport for peer {:?}: {err}", peer_id);
                            return;
                        }
                    };
                    self.set_peer_transport(peer_id, Box::new(sender), Box::new(events)).await;
                }
            }
            return; // SetTransport handled, don't forward to transport
        }

        // Forward message to the appropriate peer's transport
        if let Some(peer_id) = current_peer_id {
            let transports = self.peer_transports.read().await;
            if let Some(transport) = transports.get(&peer_id) {
                if let Err(err) = transport.sender.on_ipc_message(message).await {
                    warn!("Failed to send ipc message to peer {:?}: {err}", peer_id);
                }
            } else {
                debug!("No transport found for peer {:?}, message: {:?}", peer_id, message);
            }
        } else {
            // Broadcast to all transports (for messages without peer context)
            let transports = self.peer_transports.read().await;
            for (peer_id, transport) in transports.iter() {
                if let Err(err) = transport.sender.on_ipc_message(message.clone()).await {
                    warn!("Failed to send ipc message to peer {:?}: {err}", peer_id);
                }
            }
        }
    }

    // Start Moonlight Stream
    async fn start_stream(self: &Arc<Self>, settings: StreamSettings) -> Result<(), anyhow::Error> {
        // We might already be streaming -> remove and wait for connection close firstly
        {
            let mut stream = self.stream.write().await;
            if let Some(stream) = stream.take() {
                spawn_blocking(move || {
                    stream.stop();
                });
            }
        }
        info!("Starting Moonlight stream with settings: {settings}");

        // Send stage
        let mut ipc_sender = self.ipc_sender.clone();
        ipc_sender
            .send(StreamerIpcMessage::WebSocket(
                StreamServerMessage::DebugLog {
                    message: "Moonlight Stream".to_string(),
                    ty: None,
                },
            ))
            .await;

        let mut host = self.info.host.lock().await;

        let video_decoder = StreamVideoDecoder {
            stream: Arc::downgrade(self),
            supported_formats: settings.video_supported_formats,
            stats: Default::default(),
        };

        let audio_decoder = StreamAudioDecoder {
            stream: Arc::downgrade(self),
        };

        let connection_listener = StreamConnectionListener {
            stream: Arc::downgrade(self),
        };

        let stream = match host
            .start_stream(
                &self.moonlight,
                self.info.app_id,
                settings.width,
                settings.height,
                settings.fps,
                false,
                true,
                settings.play_audio_local,
                ActiveGamepads::empty(),
                false,
                settings.video_colorspace,
                if settings.video_color_range_full {
                    ColorRange::Full
                } else {
                    ColorRange::Limited
                },
                settings.bitrate,
                settings.packet_size,
                EncryptionFlags::all(),
                connection_listener,
                video_decoder,
                audio_decoder,
            )
            .await
        {
            Ok(value) => value,
            Err(err) => {
                warn!("[Stream]: failed to start moonlight stream: {err:?}");

                #[allow(clippy::single_match)]
                match err {
                    HostError::Moonlight(MoonlightError::ConnectionAlreadyExists) => {
                        ipc_sender
                            .send(StreamerIpcMessage::WebSocket(
                                StreamServerMessage::DebugLog { message: "Failed to start stream because this streamer is already streaming".to_string(), ty: None },
                            ))
                            .await;
                    }
                    _ => {}
                }

                return Err(err.into());
            }
        };

        let host_features = stream.host_features().unwrap_or_else(|err| {
            warn!("[Stream]: failed to get host features: {err:?}");
            HostFeatures::empty()
        });

        let capabilities = StreamCapabilities {
            touch: host_features.contains(HostFeatures::PEN_TOUCH_EVENTS),
        };

        let (video_setup, audio_setup) = {
            let setup = self.stream_setup.lock().await;

            let video = setup.video.unwrap_or_else(|| {
                warn!("failed to query video setup information. Giving the browser guessed information");
                VideoSetup { format: VideoFormat::H264, width: settings.width, height: settings.height, redraw_rate: settings.fps, flags: 0 }
            });

            let audio = setup.audio.clone().unwrap_or(OpusMultistreamConfig::STEREO);

            (video, audio)
        };

        info!(
            "Stream uses these settings: {:?} with {}x{}x{}",
            video_setup.format, video_setup.width, video_setup.height, video_setup.redraw_rate
        );

        spawn(async move {
            ipc_sender
                .send(StreamerIpcMessage::WebSocket(
                    StreamServerMessage::ConnectionComplete {
                        capabilities,
                        format: video_setup.format as u32,
                        width: video_setup.width,
                        height: video_setup.height,
                        fps: video_setup.redraw_rate,
                        audio_sample_rate: audio_setup.sample_rate,
                        audio_channel_count: audio_setup.channel_count,
                        audio_streams: audio_setup.streams,
                        audio_coupled_streams: audio_setup.coupled_streams,
                        audio_samples_per_frame: audio_setup.samples_per_frame,
                        audio_mapping: audio_setup.mapping,
                    },
                ))
                .await;
        });

        let mut stream_guard = self.stream.write().await;
        stream_guard.replace(stream);

        Ok(())
    }

    async fn stop(&self) {
        if self
            .is_terminating
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            debug!("[Stream]: stream is already terminating, won't stop twice");
            return;
        }

        debug!("[Stream]: Stopping...");

        {
            let mut stream = self.stream.write().await;
            if let Some(stream) = stream.take() {
                spawn_blocking(move || {
                    stream.stop();
                });
            }
        }

        // Close all peer transports
        {
            let mut transports = self.peer_transports.write().await;
            for (peer_id, transport) in transports.drain() {
                if let Err(err) = transport.sender.close().await {
                    warn!("Error whilst closing transport for peer {:?}: {err}", peer_id);
                }
            }
        }

        let mut ipc_sender = self.ipc_sender.clone();
        ipc_sender.send(StreamerIpcMessage::Stop).await;

        // TODO: should we terminate or wait for a new retry?
        info!("Terminating Self");
        self.terminate.notify_waiters();
    }
}

struct StreamConnectionListener {
    stream: Weak<StreamConnection>,
}

impl ConnectionListener for StreamConnectionListener {
    fn stage_starting(&mut self, stage: Stage) {
        let Some(stream) = self.stream.upgrade() else {
            warn!("Failed to get stream because it is already deallocated");
            return;
        };

        let mut ipc_sender = stream.ipc_sender.clone();

        stream.runtime.spawn(async move {
            ipc_sender
                .send(StreamerIpcMessage::WebSocket(
                    StreamServerMessage::DebugLog {
                        message: format!("Starting Stage: {}", stage.name()),
                        ty: None,
                    },
                ))
                .await;
        });
    }

    fn stage_complete(&mut self, stage: Stage) {
        let Some(stream) = self.stream.upgrade() else {
            warn!("Failed to get stream because it is already deallocated");
            return;
        };

        let mut ipc_sender = stream.ipc_sender.clone();
        ipc_sender.blocking_send(StreamerIpcMessage::WebSocket(
            StreamServerMessage::DebugLog {
                message: format!("Completed Stage: {}", stage.name()),
                ty: None,
            },
        ));
    }

    fn stage_failed(&mut self, stage: Stage, error_code: i32) {
        let Some(stream) = self.stream.upgrade() else {
            warn!("Failed to get stream because it is already deallocated");
            return;
        };

        let mut ipc_sender = stream.ipc_sender.clone();
        ipc_sender.blocking_send(StreamerIpcMessage::WebSocket(
            StreamServerMessage::DebugLog {
                message: format!(
                    "Failed Stage: {} with error code {}",
                    stage.name(),
                    error_code
                ),
                ty: Some(LogMessageType::Fatal),
            },
        ));
    }

    fn connection_started(&mut self) {}

    fn connection_terminated(&mut self, error_code: i32) {
        let Some(stream) = self.stream.upgrade() else {
            warn!("Failed to get stream because it is already deallocated");
            return;
        };

        let mut ipc_sender = stream.ipc_sender.clone();
        ipc_sender.blocking_send(StreamerIpcMessage::WebSocket(
            StreamServerMessage::ConnectionTerminated { error_code },
        ));

        stream.runtime.clone().block_on(async move {
            stream.stop().await;
        });
    }

    fn log_message(&mut self, message: &str) {
        info!(target: "moonlight", "{}", message.trim());
    }

    fn connection_status_update(&mut self, status: ConnectionStatus) {
        let Some(stream) = self.stream.upgrade() else {
            warn!("Failed to get stream because it is already deallocated");
            return;
        };

        stream.clone().runtime.block_on(async move {
            stream
                .try_send_packet(
                    OutboundPacket::General {
                        message: GeneralServerMessage::ConnectionStatusUpdate {
                            status: status.into(),
                        },
                    },
                    "connection status update",
                    true,
                )
                .await
        })
    }

    fn set_hdr_mode(&mut self, _hdr_enabled: bool) {}

    fn controller_rumble(
        &mut self,
        controller_number: u16,
        low_frequency_motor: u16,
        high_frequency_motor: u16,
    ) {
        let Some(stream) = self.stream.upgrade() else {
            warn!("Failed to get stream because it is already deallocated");
            return;
        };

        stream.runtime.clone().block_on(async move {
            stream
                .try_send_packet(
                    OutboundPacket::ControllerRumble {
                        controller_number: controller_number as u8,
                        low_frequency_motor,
                        high_frequency_motor,
                    },
                    "controller rumble",
                    true,
                )
                .await;
        });
    }

    fn controller_rumble_triggers(
        &mut self,
        controller_number: u16,
        left_trigger_motor: u16,
        right_trigger_motor: u16,
    ) {
        let Some(stream) = self.stream.upgrade() else {
            warn!("Failed to get stream because it is already deallocated");
            return;
        };

        stream.runtime.clone().block_on(async move {
            stream
                .try_send_packet(
                    OutboundPacket::ControllerTriggerRumble {
                        controller_number: controller_number as u8,
                        left_trigger_motor,
                        right_trigger_motor,
                    },
                    "controller rumble triggers",
                    true,
                )
                .await;
        });
    }

    fn controller_set_motion_event_state(
        &mut self,
        _controller_number: u16,
        _motion_type: u8,
        _report_rate_hz: u16,
    ) {
        // unsupported: https://github.com/w3c/gamepad/issues/211
    }

    fn controller_set_adaptive_triggers(
        &mut self,
        _controller_number: u16,
        _event_flags: u8,
        _type_left: u8,
        _type_right: u8,
        _left: &mut u8,
        _right: &mut u8,
    ) {
        // unsupported
    }

    fn controller_set_led(&mut self, _controller_number: u16, _r: u8, _g: u8, _b: u8) {
        // unsupported
    }
}
