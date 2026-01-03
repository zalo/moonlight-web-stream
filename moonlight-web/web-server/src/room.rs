use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use actix_ws::Session;
use common::{
    api_bindings::{PlayerSlot, RoomInfo, RoomParticipant, RoomPlayer, RoomRole, RtcIceServer, StreamCapabilities, StreamServerMessage},
    ipc::{PeerId, ServerIpcMessage},
    serialize_json,
};
use log::{debug, info, warn};
use tokio::sync::{Mutex, RwLock};

/// Stored stream state so late-joining clients can get connection info
#[derive(Clone)]
pub struct StreamState {
    pub capabilities: StreamCapabilities,
    pub format: u32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub audio_sample_rate: u32,
    pub audio_channel_count: u32,
    pub audio_streams: u32,
    pub audio_coupled_streams: u32,
    pub audio_samples_per_frame: u32,
    pub audio_mapping: [u8; 8],
}

/// Global counter for generating unique peer IDs
static PEER_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

fn generate_peer_id() -> PeerId {
    PeerId(PEER_ID_COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Generate a short room ID for sharing
fn generate_room_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let chars: String = (0..6)
        .map(|_| {
            let idx = rng.gen_range(0..36);
            if idx < 10 {
                (b'0' + idx) as char
            } else {
                (b'A' + idx - 10) as char
            }
        })
        .collect();
    chars
}

/// Represents a connected participant in a room (player or spectator)
pub struct RoomClient {
    pub peer_id: PeerId,
    /// Player slot if this is a player, None if spectator
    pub player_slot: Option<PlayerSlot>,
    /// Role in the room
    pub role: RoomRole,
    pub player_name: Option<String>,
    /// Discord user ID for Discord Activity integration
    pub discord_user_id: Option<String>,
    /// Discord avatar URL
    pub discord_avatar: Option<String>,
    pub session: Session,
    #[allow(dead_code)]
    pub video_frame_queue_size: usize,
    #[allow(dead_code)]
    pub audio_sample_queue_size: usize,
}

impl RoomClient {
    pub fn to_room_player(&self) -> Option<RoomPlayer> {
        self.player_slot.map(|slot| RoomPlayer {
            slot,
            name: self.player_name.clone(),
            is_host: self.role.is_host(),
        })
    }

    pub fn to_participant(&self) -> RoomParticipant {
        RoomParticipant {
            slot: self.player_slot,
            role: self.role,
            name: self.player_name.clone(),
            discord_user_id: self.discord_user_id.clone(),
            discord_avatar: self.discord_avatar.clone(),
        }
    }

    pub fn is_spectator(&self) -> bool {
        self.role.is_spectator()
    }

    pub fn is_player(&self) -> bool {
        self.role.can_input()
    }
}

/// Represents an active streaming room
pub struct Room {
    pub room_id: String,
    pub host_id: u32,
    pub app_id: u32,
    pub app_name: String,
    pub max_players: u8,
    /// Connected clients indexed by peer_id
    pub clients: HashMap<PeerId, RoomClient>,
    /// IPC sender to the streamer process
    pub ipc_sender: Option<common::ipc::IpcSender<ServerIpcMessage>>,
    /// Track which player slots are occupied
    occupied_slots: [bool; PlayerSlot::MAX_PLAYERS],
    /// Whether guests (non-host players) can use keyboard/mouse
    pub guests_keyboard_mouse_enabled: bool,
    /// ICE servers for WebRTC - stored so late-joining clients can get them
    pub ice_servers: Option<Vec<RtcIceServer>>,
    /// Stream state - stored when ConnectionComplete is received so late joiners can get it
    pub stream_state: Option<StreamState>,
}

impl Room {
    pub fn new(room_id: String, host_id: u32, app_id: u32, app_name: String) -> Self {
        Self {
            room_id,
            host_id,
            app_id,
            app_name,
            max_players: PlayerSlot::MAX_PLAYERS as u8,
            clients: HashMap::new(),
            ipc_sender: None,
            occupied_slots: [false; PlayerSlot::MAX_PLAYERS],
            guests_keyboard_mouse_enabled: false, // Default: guests cannot use KB/mouse
            ice_servers: None,
            stream_state: None,
        }
    }

    /// Set whether guests can use keyboard/mouse and notify the streamer
    pub async fn set_guests_keyboard_mouse_enabled(&mut self, enabled: bool) {
        self.guests_keyboard_mouse_enabled = enabled;

        // Notify the streamer
        if let Some(mut ipc_sender) = self.ipc_sender.clone() {
            ipc_sender
                .send(ServerIpcMessage::SetGuestsKeyboardMouseEnabled { enabled })
                .await;
        }
    }

    pub fn to_room_info(&self) -> RoomInfo {
        RoomInfo {
            room_id: self.room_id.clone(),
            host_id: self.host_id,
            app_id: self.app_id,
            app_name: self.app_name.clone(),
            players: self.clients.values().filter_map(|c| c.to_room_player()).collect(),
            max_players: self.max_players,
            participants: self.clients.values().map(|c| c.to_participant()).collect(),
            spectator_count: self.spectator_count(),
        }
    }

    /// Count the number of spectators
    pub fn spectator_count(&self) -> usize {
        self.clients.values().filter(|c| c.is_spectator()).count()
    }

    /// Count the number of players (non-spectators)
    pub fn player_count(&self) -> usize {
        self.clients.values().filter(|c| c.is_player()).count()
    }

    /// Get the next available player slot
    pub fn next_available_slot(&self) -> Option<PlayerSlot> {
        for (i, occupied) in self.occupied_slots.iter().enumerate() {
            if !occupied {
                return Some(PlayerSlot(i as u8));
            }
        }
        None
    }

    /// Add a client (player or spectator) to the room
    pub fn add_client(&mut self, client: RoomClient) -> bool {
        // If client has a player slot, check and mark it as occupied
        if let Some(slot) = client.player_slot {
            let slot_idx = slot.0 as usize;
            if slot_idx >= PlayerSlot::MAX_PLAYERS || self.occupied_slots[slot_idx] {
                return false;
            }
            self.occupied_slots[slot_idx] = true;
        }
        // Spectators don't need a slot - unlimited spectators allowed

        self.clients.insert(client.peer_id, client);
        true
    }

    /// Add a spectator to the room
    pub fn add_spectator(&mut self, client: RoomClient) -> bool {
        // Spectators should not have a player slot
        if client.player_slot.is_some() || !client.is_spectator() {
            return false;
        }
        self.clients.insert(client.peer_id, client);
        true
    }

    /// Remove a client from the room
    pub fn remove_client(&mut self, peer_id: PeerId) -> Option<RoomClient> {
        if let Some(client) = self.clients.remove(&peer_id) {
            // Free up the player slot if this was a player
            if let Some(slot) = client.player_slot {
                let slot_idx = slot.0 as usize;
                if slot_idx < PlayerSlot::MAX_PLAYERS {
                    self.occupied_slots[slot_idx] = false;
                }
            }
            Some(client)
        } else {
            None
        }
    }

    /// Promote a spectator to player
    pub fn promote_to_player(&mut self, peer_id: PeerId) -> Option<PlayerSlot> {
        // Get next available slot
        let slot = self.next_available_slot()?;

        // Update the client
        let client = self.clients.get_mut(&peer_id)?;
        if !client.is_spectator() {
            return None; // Already a player
        }

        client.role = RoomRole::Player;
        client.player_slot = Some(slot);
        self.occupied_slots[slot.0 as usize] = true;

        Some(slot)
    }

    /// Demote a player to spectator
    pub fn demote_to_spectator(&mut self, peer_id: PeerId) -> bool {
        let client = self.clients.get_mut(&peer_id);
        let Some(client) = client else {
            return false;
        };

        // Don't demote the host
        if client.role.is_host() {
            return false;
        }

        // Free up the player slot
        if let Some(slot) = client.player_slot.take() {
            let slot_idx = slot.0 as usize;
            if slot_idx < PlayerSlot::MAX_PLAYERS {
                self.occupied_slots[slot_idx] = false;
            }
        }

        client.role = RoomRole::Spectator;
        true
    }

    /// Find a client by Discord user ID
    pub fn find_by_discord_id(&self, discord_user_id: &str) -> Option<PeerId> {
        self.clients
            .iter()
            .find(|(_, c)| c.discord_user_id.as_deref() == Some(discord_user_id))
            .map(|(pid, _)| *pid)
    }

    /// Check if the room is empty
    pub fn is_empty(&self) -> bool {
        self.clients.is_empty()
    }

    /// Check if the host is still connected
    #[allow(dead_code)]
    pub fn has_host(&self) -> bool {
        self.clients
            .values()
            .any(|c| c.role.is_host())
    }

    /// Get a client by peer ID
    #[allow(dead_code)]
    pub fn get_client(&self, peer_id: PeerId) -> Option<&RoomClient> {
        self.clients.get(&peer_id)
    }

    /// Get a mutable client by peer ID
    #[allow(dead_code)]
    pub fn get_client_mut(&mut self, peer_id: PeerId) -> Option<&mut RoomClient> {
        self.clients.get_mut(&peer_id)
    }

    /// Broadcast a message to all clients
    pub async fn broadcast(&self, message: StreamServerMessage) {
        let Some(json) = serialize_json(&message) else {
            return;
        };

        for client in self.clients.values() {
            let mut session = client.session.clone();
            if let Err(err) = session.text(json.clone()).await {
                warn!(
                    "Failed to send message to peer {:?}: {:?}",
                    client.peer_id, err
                );
            }
        }
    }

    /// Send a message to a specific peer
    pub async fn send_to_peer(&self, peer_id: PeerId, message: StreamServerMessage) {
        let Some(json) = serialize_json(&message) else {
            return;
        };

        if let Some(client) = self.clients.get(&peer_id) {
            let mut session = client.session.clone();
            if let Err(err) = session.text(json).await {
                warn!(
                    "Failed to send message to peer {:?}: {:?}",
                    peer_id, err
                );
            }
        }
    }
}

/// Manager for all active rooms
pub struct RoomManager {
    /// Active rooms indexed by room_id
    rooms: RwLock<HashMap<String, Arc<Mutex<Room>>>>,
    /// Map peer_id to room_id for quick lookup
    peer_to_room: RwLock<HashMap<PeerId, String>>,
}

impl RoomManager {
    pub fn new() -> Self {
        Self {
            rooms: RwLock::new(HashMap::new()),
            peer_to_room: RwLock::new(HashMap::new()),
        }
    }

    /// Create a new room and return it
    pub async fn create_room(
        &self,
        host_id: u32,
        app_id: u32,
        app_name: String,
    ) -> Arc<Mutex<Room>> {
        let room_id = generate_room_id();
        let room = Arc::new(Mutex::new(Room::new(
            room_id.clone(),
            host_id,
            app_id,
            app_name,
        )));

        let mut rooms = self.rooms.write().await;
        rooms.insert(room_id.clone(), room.clone());

        info!("Created room {}", room_id);
        room
    }

    /// Get a room by ID
    pub async fn get_room(&self, room_id: &str) -> Option<Arc<Mutex<Room>>> {
        let rooms = self.rooms.read().await;
        rooms.get(room_id).cloned()
    }

    /// Register a peer with a room
    pub async fn register_peer(&self, peer_id: PeerId, room_id: &str) {
        let mut peer_to_room = self.peer_to_room.write().await;
        peer_to_room.insert(peer_id, room_id.to_string());
    }

    /// Get the room a peer belongs to
    #[allow(dead_code)]
    pub async fn get_peer_room(&self, peer_id: PeerId) -> Option<Arc<Mutex<Room>>> {
        let peer_to_room = self.peer_to_room.read().await;
        if let Some(room_id) = peer_to_room.get(&peer_id) {
            let rooms = self.rooms.read().await;
            rooms.get(room_id).cloned()
        } else {
            None
        }
    }

    /// Remove a peer from their room
    pub async fn remove_peer(&self, peer_id: PeerId) -> Option<(Arc<Mutex<Room>>, RoomClient)> {
        let room_id = {
            let mut peer_to_room = self.peer_to_room.write().await;
            peer_to_room.remove(&peer_id)
        };

        if let Some(room_id) = room_id {
            let rooms = self.rooms.read().await;
            if let Some(room) = rooms.get(&room_id) {
                let mut room_guard = room.lock().await;
                if let Some(client) = room_guard.remove_client(peer_id) {
                    debug!("Removed peer {:?} from room {}", peer_id, room_id);
                    return Some((room.clone(), client));
                }
            }
        }

        None
    }

    /// Delete a room
    pub async fn delete_room(&self, room_id: &str) {
        let mut rooms = self.rooms.write().await;
        if rooms.remove(room_id).is_some() {
            info!("Deleted room {}", room_id);
        }

        // Clean up peer mappings
        let mut peer_to_room = self.peer_to_room.write().await;
        peer_to_room.retain(|_, rid| rid != room_id);
    }

    /// Generate a new unique peer ID
    pub fn generate_peer_id(&self) -> PeerId {
        generate_peer_id()
    }

    /// List all active rooms (for admin/debugging)
    pub async fn list_rooms(&self) -> Vec<RoomInfo> {
        let rooms = self.rooms.read().await;
        let mut result = Vec::new();

        for room in rooms.values() {
            let room_guard = room.lock().await;
            result.push(room_guard.to_room_info());
        }

        result
    }
}

impl Default for RoomManager {
    fn default() -> Self {
        Self::new()
    }
}
