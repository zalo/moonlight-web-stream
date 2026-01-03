use std::{process::Stdio, sync::Arc};

use actix_web::{
    Error, HttpRequest, HttpResponse, get, post, rt as actix_rt,
    web::{Data, Json, Payload},
};
use actix_ws::{Closed, Message, MessageStream, Session};
use common::{
    api_bindings::{
        LogMessageType, PlayerSlot, PostCancelRequest, PostCancelResponse, RoomInfo,
        StreamClientMessage, StreamServerMessage,
    },
    ipc::{PeerId, ServerIpcMessage, StreamerConfig, StreamerIpcMessage, create_child_ipc},
    serialize_json,
};
use log::{debug, error, info, warn};
use tokio::{
    process::{Child, Command},
    spawn,
    sync::Mutex,
};

use crate::{
    app::{
        App, AppError,
        host::{AppId, HostId},
        user::AuthenticatedUser,
    },
    room::{Room, RoomClient},
};

/// Handle the initial WebSocket connection for streaming
/// This can either create a new room (host/Player 1) or join an existing room (Players 2-4)
#[get("/host/stream")]
pub async fn start_host(
    web_app: Data<App>,
    mut user: AuthenticatedUser,
    request: HttpRequest,
    payload: Payload,
) -> Result<HttpResponse, Error> {
    let (response, session, stream) = actix_ws::handle(&request, payload)?;

    let client_unique_id = match user.host_unique_id().await {
        Ok(id) => id,
        Err(err) => {
            warn!("Failed to get client unique id: {:?}", err);
            return Ok(response);
        }
    };

    let web_app = web_app.clone();
    actix_rt::spawn(async move {
        handle_stream_connection(web_app, user, session, stream, client_unique_id).await;
    });

    Ok(response)
}

async fn handle_stream_connection(
    web_app: Data<App>,
    mut user: AuthenticatedUser,
    session: Session,
    mut stream: MessageStream,
    client_unique_id: String,
) {
    // Wait for the first message to determine if this is an Init or JoinRoom
    let message = loop {
        match stream.recv().await {
            Some(Ok(Message::Text(text))) => break text,
            Some(Ok(Message::Binary(_))) => return,
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return,
        }
    };

    let message = match serde_json::from_str::<StreamClientMessage>(&message) {
        Ok(value) => value,
        Err(_) => return,
    };

    match message {
        StreamClientMessage::Init {
            host_id,
            app_id,
            video_frame_queue_size,
            audio_sample_queue_size,
        } => {
            handle_init_room(
                web_app,
                &mut user,
                session,
                stream,
                client_unique_id,
                HostId(host_id),
                AppId(app_id),
                video_frame_queue_size,
                audio_sample_queue_size,
            )
            .await;
        }
        StreamClientMessage::JoinRoom {
            room_id,
            player_name,
            video_frame_queue_size,
            audio_sample_queue_size,
        } => {
            handle_join_room(
                web_app,
                session,
                stream,
                room_id,
                player_name,
                video_frame_queue_size,
                audio_sample_queue_size,
            )
            .await;
        }
        _ => {
            let _ = session.close(None).await;
            warn!("WebSocket didn't send Init or JoinRoom as first message, closing");
        }
    }
}

/// Handle creating a new room as host/Player 1
async fn handle_init_room(
    web_app: Data<App>,
    user: &mut AuthenticatedUser,
    mut session: Session,
    mut stream: MessageStream,
    client_unique_id: String,
    host_id: HostId,
    app_id: AppId,
    video_frame_queue_size: usize,
    audio_sample_queue_size: usize,
) {
    // Collect host data
    let mut host = match user.host(host_id).await {
        Ok(host) => host,
        Err(AppError::HostNotFound) => {
            let _ = send_ws_message(
                &mut session,
                StreamServerMessage::DebugLog {
                    message: "Failed to start stream because the host was not found".to_string(),
                    ty: Some(LogMessageType::FatalDescription),
                },
            )
            .await;
            let _ = session.close(None).await;
            return;
        }
        Err(err) => {
            warn!("failed to start stream for host {host_id:?} (at host): {err}");
            let _ = send_ws_message(
                &mut session,
                StreamServerMessage::DebugLog {
                    message: "Failed to start stream because of a server error".to_string(),
                    ty: Some(LogMessageType::FatalDescription),
                },
            )
            .await;
            let _ = session.close(None).await;
            return;
        }
    };

    let apps = match host.list_apps(user).await {
        Ok(apps) => apps,
        Err(err) => {
            warn!("failed to start stream for host {host_id:?} (at list_apps): {err}");
            let _ = send_ws_message(
                &mut session,
                StreamServerMessage::DebugLog {
                    message: "Failed to start stream because of a server error".to_string(),
                    ty: Some(LogMessageType::FatalDescription),
                },
            )
            .await;
            let _ = session.close(None).await;
            return;
        }
    };

    let Some(app) = apps.iter().find(|app| app.id == app_id).cloned() else {
        warn!("failed to start stream for host {host_id:?} because the app couldn't be found!");
        let _ = send_ws_message(
            &mut session,
            StreamServerMessage::DebugLog {
                message: "Failed to start stream because the app was not found".to_string(),
                ty: Some(LogMessageType::FatalDescription),
            },
        )
        .await;
        let _ = session.close(None).await;
        return;
    };

    let (address, http_port) = match host.address_port(user).await {
        Ok(address_port) => address_port,
        Err(err) => {
            warn!("failed to start stream for host {host_id:?} (at get address_port): {err}");
            let _ = send_ws_message(
                &mut session,
                StreamServerMessage::DebugLog {
                    message: "Failed to start stream because of a server error".to_string(),
                    ty: Some(LogMessageType::FatalDescription),
                },
            )
            .await;
            let _ = session.close(None).await;
            return;
        }
    };

    let pair_info = match host.pair_info(user).await {
        Ok(pair_info) => pair_info,
        Err(err) => {
            warn!("failed to start stream for host {host_id:?} (at get pair_info): {err}");
            let _ = send_ws_message(
                &mut session,
                StreamServerMessage::DebugLog {
                    message: "Failed to start stream because the host is not paired".to_string(),
                    ty: Some(LogMessageType::FatalDescription),
                },
            )
            .await;
            let _ = session.close(None).await;
            return;
        }
    };

    // Send App info
    let _ = send_ws_message(
        &mut session,
        StreamServerMessage::UpdateApp { app: app.clone().into() },
    )
    .await;

    // Create the room
    let room = web_app
        .room_manager()
        .create_room(host_id.0, app_id.0, app.title.clone())
        .await;

    // Generate peer ID for the host
    let peer_id = web_app.room_manager().generate_peer_id();
    let player_slot = PlayerSlot::PLAYER_1;

    // Add host as Player 1
    {
        let mut room_guard = room.lock().await;
        let client = RoomClient {
            peer_id,
            player_slot,
            player_name: Some("Host".to_string()),
            session: session.clone(),
            video_frame_queue_size,
            audio_sample_queue_size,
        };
        room_guard.add_client(client);
    }

    // Register peer with room manager
    let room_id = room.lock().await.room_id.clone();
    web_app.room_manager().register_peer(peer_id, &room_id).await;

    // Send room created message
    let room_info = room.lock().await.to_room_info();
    let _ = send_ws_message(
        &mut session,
        StreamServerMessage::RoomCreated {
            room: room_info,
            player_slot,
        },
    )
    .await;

    // Launching streamer
    let _ = send_ws_message(
        &mut session,
        StreamServerMessage::DebugLog {
            message: "Launching streamer".to_string(),
            ty: None,
        },
    )
    .await;

    // Spawn child process
    let (mut child, stdin, stdout) = match Command::new(&web_app.config().streamer_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(mut child) => {
            if let Some(stdin) = child.stdin.take()
                && let Some(stdout) = child.stdout.take()
            {
                (child, stdin, stdout)
            } else {
                error!("[Stream]: streamer process didn't include a stdin or stdout");
                let _ = send_ws_message(
                    &mut session,
                    StreamServerMessage::DebugLog {
                        message: "Failed to start stream because of a server error".to_string(),
                        ty: Some(LogMessageType::FatalDescription),
                    },
                )
                .await;
                let _ = session.close(None).await;
                if let Err(err) = child.kill().await {
                    warn!("[Stream]: failed to kill child: {err}");
                }
                return;
            }
        }
        Err(err) => {
            error!("[Stream]: failed to spawn streamer process: {err}");
            let _ = send_ws_message(
                &mut session,
                StreamServerMessage::DebugLog {
                    message: "Failed to start stream because of a server error".to_string(),
                    ty: Some(LogMessageType::FatalDescription),
                },
            )
            .await;
            let _ = session.close(None).await;
            return;
        }
    };

    // Create IPC
    let (mut ipc_sender, mut ipc_receiver) =
        create_child_ipc::<ServerIpcMessage, StreamerIpcMessage>(
            "Streamer",
            stdin,
            stdout,
            child.stderr.take(),
        )
        .await;

    // Store IPC sender in room
    {
        let mut room_guard = room.lock().await;
        room_guard.ipc_sender = Some(ipc_sender.clone());
    }

    // Spawn task to handle IPC messages from streamer
    let room_for_ipc = room.clone();
    let web_app_for_ipc = web_app.clone();
    let room_id_for_ipc = room_id.clone();
    spawn(async move {
        handle_streamer_ipc(
            &mut ipc_receiver,
            room_for_ipc,
            &mut child,
            web_app_for_ipc,
            room_id_for_ipc,
        )
        .await;
    });

    // Send init to IPC
    ipc_sender
        .send(ServerIpcMessage::Init {
            config: StreamerConfig {
                webrtc: web_app.config().webrtc.clone(),
                log_level: web_app.config().log.level_filter,
            },
            host_address: address,
            host_http_port: http_port,
            client_unique_id: Some(client_unique_id),
            client_private_key: pair_info.client_private_key,
            client_certificate: pair_info.client_certificate,
            server_certificate: pair_info.server_certificate,
            app_id: app_id.0,
            video_frame_queue_size,
            audio_sample_queue_size,
        })
        .await;

    // Handle WebSocket messages from this client
    handle_client_websocket(
        web_app,
        room,
        peer_id,
        player_slot,
        &mut stream,
        ipc_sender,
    )
    .await;
}

/// Handle joining an existing room as Player 2-4
async fn handle_join_room(
    web_app: Data<App>,
    mut session: Session,
    mut stream: MessageStream,
    room_id: String,
    player_name: Option<String>,
    video_frame_queue_size: usize,
    audio_sample_queue_size: usize,
) {
    // Find the room
    let Some(room) = web_app.room_manager().get_room(&room_id).await else {
        let _ = send_ws_message(
            &mut session,
            StreamServerMessage::RoomJoinFailed {
                reason: "Room not found".to_string(),
            },
        )
        .await;
        let _ = session.close(None).await;
        return;
    };

    // Get the next available player slot
    let (peer_id, player_slot, room_info, ipc_sender) = {
        let mut room_guard = room.lock().await;

        let Some(player_slot) = room_guard.next_available_slot() else {
            drop(room_guard);
            let _ = send_ws_message(
                &mut session,
                StreamServerMessage::RoomJoinFailed {
                    reason: "Room is full".to_string(),
                },
            )
            .await;
            let _ = session.close(None).await;
            return;
        };

        let peer_id = web_app.room_manager().generate_peer_id();

        // Add client to room
        let client = RoomClient {
            peer_id,
            player_slot,
            player_name: player_name.clone(),
            session: session.clone(),
            video_frame_queue_size,
            audio_sample_queue_size,
        };

        if !room_guard.add_client(client) {
            drop(room_guard);
            let _ = send_ws_message(
                &mut session,
                StreamServerMessage::RoomJoinFailed {
                    reason: "Failed to join room".to_string(),
                },
            )
            .await;
            let _ = session.close(None).await;
            return;
        }

        let room_info = room_guard.to_room_info();
        let ipc_sender = room_guard.ipc_sender.clone();

        (peer_id, player_slot, room_info, ipc_sender)
    };

    // Register peer with room manager
    web_app.room_manager().register_peer(peer_id, &room_id).await;

    // Send join success to the joining player
    let _ = send_ws_message(
        &mut session,
        StreamServerMessage::RoomJoined {
            room: room_info.clone(),
            player_slot,
        },
    )
    .await;

    // Broadcast room update to all existing players
    {
        let room_guard = room.lock().await;
        room_guard
            .broadcast(StreamServerMessage::RoomUpdated {
                room: room_info,
            })
            .await;
    }

    // Notify streamer about new peer
    if let Some(mut ipc_sender) = ipc_sender.clone() {
        ipc_sender
            .send(ServerIpcMessage::PeerConnected {
                peer_id,
                player_slot,
                video_frame_queue_size,
                audio_sample_queue_size,
            })
            .await;
    }

    // Handle WebSocket messages from this client
    if let Some(ipc_sender) = ipc_sender {
        handle_client_websocket(web_app, room, peer_id, player_slot, &mut stream, ipc_sender)
            .await;
    }
}

/// Handle WebSocket messages from a client
async fn handle_client_websocket(
    web_app: Data<App>,
    room: Arc<Mutex<Room>>,
    peer_id: PeerId,
    player_slot: PlayerSlot,
    stream: &mut MessageStream,
    mut ipc_sender: common::ipc::IpcSender<ServerIpcMessage>,
) {
    while let Some(Ok(message)) = stream.recv().await {
        match message {
            Message::Text(text) => {
                let Ok(client_message) = serde_json::from_str::<StreamClientMessage>(&text)
                else {
                    warn!("[Stream]: failed to deserialize from json");
                    continue;
                };

                // Handle leave room
                if matches!(client_message, StreamClientMessage::LeaveRoom) {
                    break;
                }

                // Handle host-only keyboard/mouse permission setting
                if let StreamClientMessage::SetGuestsKeyboardMouseEnabled { enabled } = &client_message {
                    // Only the host (Player 1) can change this setting
                    if player_slot.is_host() {
                        let mut room_guard = room.lock().await;
                        room_guard.set_guests_keyboard_mouse_enabled(*enabled).await;

                        // Broadcast the change to all clients
                        room_guard
                            .broadcast(StreamServerMessage::GuestsKeyboardMouseEnabled {
                                enabled: *enabled,
                            })
                            .await;
                    } else {
                        warn!("Non-host player {:?} tried to change keyboard/mouse permission", peer_id);
                    }
                    continue;
                }

                // Send message to streamer with peer ID
                ipc_sender
                    .send(ServerIpcMessage::PeerWebSocket {
                        peer_id,
                        message: client_message,
                    })
                    .await;
            }
            Message::Binary(binary) => {
                // Binary messages are input data - send with peer ID
                ipc_sender
                    .send(ServerIpcMessage::PeerWebSocketTransport {
                        peer_id,
                        data: binary,
                    })
                    .await;
            }
            Message::Close(_) => {
                break;
            }
            _ => {}
        }
    }

    // Client disconnected - remove from room
    handle_client_disconnect(web_app, room, peer_id, player_slot, ipc_sender).await;
}

/// Handle client disconnection
async fn handle_client_disconnect(
    web_app: Data<App>,
    room: Arc<Mutex<Room>>,
    peer_id: PeerId,
    player_slot: PlayerSlot,
    mut ipc_sender: common::ipc::IpcSender<ServerIpcMessage>,
) {
    // Remove peer from room manager
    web_app.room_manager().remove_peer(peer_id).await;

    // Notify streamer
    ipc_sender
        .send(ServerIpcMessage::PeerDisconnected { peer_id })
        .await;

    let (should_close_room, room_id) = {
        let mut room_guard = room.lock().await;
        let room_id = room_guard.room_id.clone();

        room_guard.remove_client(peer_id);

        // If host left, close the room
        if player_slot.is_host() {
            // Broadcast room closed to remaining players
            room_guard.broadcast(StreamServerMessage::RoomClosed).await;
            (true, room_id)
        } else {
            // Broadcast player left to remaining players
            room_guard
                .broadcast(StreamServerMessage::PlayerLeft { slot: player_slot })
                .await;
            room_guard
                .broadcast(StreamServerMessage::RoomUpdated {
                    room: room_guard.to_room_info(),
                })
                .await;
            (room_guard.is_empty(), room_id)
        }
    };

    if should_close_room {
        web_app.room_manager().delete_room(&room_id).await;
        // Stop the streamer
        ipc_sender.send(ServerIpcMessage::Stop).await;
    }
}

/// Handle IPC messages from the streamer
async fn handle_streamer_ipc(
    ipc_receiver: &mut common::ipc::IpcReceiver<StreamerIpcMessage>,
    room: Arc<Mutex<Room>>,
    child: &mut Child,
    web_app: Data<App>,
    room_id: String,
) {
    while let Some(message) = ipc_receiver.recv().await {
        match message {
            StreamerIpcMessage::WebSocket(server_message) => {
                // Broadcast to all clients in the room
                let room_guard = room.lock().await;
                room_guard.broadcast(server_message).await;
            }
            StreamerIpcMessage::PeerWebSocket { peer_id, message } => {
                // Send to specific peer
                let room_guard = room.lock().await;
                room_guard.send_to_peer(peer_id, message).await;
            }
            StreamerIpcMessage::WebSocketTransport(data) => {
                // Broadcast binary to all clients
                let room_guard = room.lock().await;
                for client in room_guard.clients.values() {
                    let mut session = client.session.clone();
                    if let Err(err) = session.binary(data.clone()).await {
                        warn!(
                            "Failed to send binary to peer {:?}: {:?}",
                            client.peer_id, err
                        );
                    }
                }
            }
            StreamerIpcMessage::PeerWebSocketTransport { peer_id, data } => {
                // Send binary to specific peer
                let room_guard = room.lock().await;
                if let Some(client) = room_guard.clients.get(&peer_id) {
                    let mut session = client.session.clone();
                    if let Err(err) = session.binary(data).await {
                        warn!(
                            "Failed to send binary to peer {:?}: {:?}",
                            peer_id, err
                        );
                    }
                }
            }
            StreamerIpcMessage::PeerReady { peer_id } => {
                debug!("Peer {:?} is ready", peer_id);
            }
            StreamerIpcMessage::Stop => {
                debug!("[Ipc]: ipc receiver stopped by streamer");
                break;
            }
        }
    }

    info!("[Ipc]: ipc receiver is closed");

    // Close all client sessions
    {
        let room_guard = room.lock().await;
        for client in room_guard.clients.values() {
            let session = client.session.clone();
            if let Err(err) = session.close(None).await {
                warn!("Failed to close session for peer {:?}: {:?}", client.peer_id, err);
            }
        }
    }

    // Delete the room
    web_app.room_manager().delete_room(&room_id).await;

    // Kill the streamer
    if let Err(err) = child.kill().await {
        warn!("Failed to kill streamer child: {err}");
    }
}

async fn send_ws_message(sender: &mut Session, message: StreamServerMessage) -> Result<(), Closed> {
    let Some(json) = serialize_json(&message) else {
        return Ok(());
    };
    sender.text(json).await
}

#[post("/host/cancel")]
pub async fn cancel_host(
    mut user: AuthenticatedUser,
    Json(request): Json<PostCancelRequest>,
) -> Result<Json<PostCancelResponse>, AppError> {
    let host_id = HostId(request.host_id);
    let mut host = user.host(host_id).await?;
    host.cancel_app(&mut user).await?;
    Ok(Json(PostCancelResponse { success: true }))
}

/// Get list of active rooms (for joining)
#[get("/rooms")]
pub async fn list_rooms(web_app: Data<App>) -> Json<Vec<RoomInfo>> {
    let rooms = web_app.room_manager().list_rooms().await;
    Json(rooms)
}
