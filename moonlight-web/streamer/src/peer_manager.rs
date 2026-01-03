use std::collections::HashMap;

use common::{
    api_bindings::PlayerSlot,
    ipc::PeerId,
};
use log::{debug, warn};

/// Manages the mapping between peers and their player slots
#[derive(Debug, Default)]
pub struct PeerManager {
    /// Map from peer ID to player slot
    peers: HashMap<PeerId, PeerInfo>,
    /// Whether guests (non-host players) can use keyboard/mouse
    guests_keyboard_mouse_enabled: bool,
}

#[derive(Debug, Clone)]
pub struct PeerInfo {
    pub player_slot: PlayerSlot,
    pub video_frame_queue_size: usize,
    pub audio_sample_queue_size: usize,
}

impl PeerManager {
    pub fn new() -> Self {
        Self {
            peers: HashMap::new(),
            guests_keyboard_mouse_enabled: false,
        }
    }

    /// Set whether guests can use keyboard/mouse
    pub fn set_guests_keyboard_mouse_enabled(&mut self, enabled: bool) {
        debug!("Setting guests keyboard/mouse enabled: {}", enabled);
        self.guests_keyboard_mouse_enabled = enabled;
    }

    /// Get whether guests can use keyboard/mouse
    pub fn guests_keyboard_mouse_enabled(&self) -> bool {
        self.guests_keyboard_mouse_enabled
    }

    /// Add a new peer with their assigned player slot
    pub fn add_peer(
        &mut self,
        peer_id: PeerId,
        player_slot: PlayerSlot,
        video_frame_queue_size: usize,
        audio_sample_queue_size: usize,
    ) {
        debug!(
            "Adding peer {:?} as player slot {}",
            peer_id, player_slot.0
        );
        self.peers.insert(
            peer_id,
            PeerInfo {
                player_slot,
                video_frame_queue_size,
                audio_sample_queue_size,
            },
        );
    }

    /// Remove a peer
    pub fn remove_peer(&mut self, peer_id: PeerId) -> Option<PeerInfo> {
        debug!("Removing peer {:?}", peer_id);
        self.peers.remove(&peer_id)
    }

    /// Get peer info
    pub fn get_peer(&self, peer_id: PeerId) -> Option<&PeerInfo> {
        self.peers.get(&peer_id)
    }

    /// Get the player slot for a peer
    pub fn get_player_slot(&self, peer_id: PeerId) -> Option<PlayerSlot> {
        self.peers.get(&peer_id).map(|info| info.player_slot)
    }

    /// Check if a peer can use keyboard/mouse
    /// Player 1 (host) can always use it; guests can only if explicitly enabled
    pub fn can_use_keyboard_mouse(&self, peer_id: PeerId) -> bool {
        self.peers
            .get(&peer_id)
            .map(|info| {
                if info.player_slot.is_host() {
                    true // Host can always use keyboard/mouse
                } else {
                    self.guests_keyboard_mouse_enabled
                }
            })
            .unwrap_or(false)
    }

    /// Map a gamepad ID from a peer to the actual gamepad slot
    ///
    /// When a browser sends gamepad input, it uses local gamepad IDs (0-15).
    /// We need to map this to the actual gamepad slot based on the player's slot.
    ///
    /// For now, we use a simple mapping:
    /// - Player 1's gamepad 0 -> slot 0
    /// - Player 2's gamepad 0 -> slot 1
    /// - Player 3's gamepad 0 -> slot 2
    /// - Player 4's gamepad 0 -> slot 3
    ///
    /// Each player only gets one gamepad slot.
    pub fn map_gamepad_id(&self, peer_id: PeerId, browser_gamepad_id: u8) -> Option<u8> {
        let info = self.peers.get(&peer_id)?;

        // Only the first gamepad from each player is used
        if browser_gamepad_id != 0 {
            warn!(
                "Peer {:?} tried to use gamepad {} but only gamepad 0 is supported per player",
                peer_id, browser_gamepad_id
            );
            return None;
        }

        Some(info.player_slot.gamepad_slot())
    }

    /// Get all peer IDs
    pub fn peer_ids(&self) -> impl Iterator<Item = PeerId> + '_ {
        self.peers.keys().copied()
    }

    /// Get the number of connected peers
    pub fn peer_count(&self) -> usize {
        self.peers.len()
    }

    /// Check if any peers are connected
    pub fn has_peers(&self) -> bool {
        !self.peers.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gamepad_mapping() {
        let mut manager = PeerManager::new();

        let peer1 = PeerId(1);
        let peer2 = PeerId(2);
        let peer3 = PeerId(3);

        manager.add_peer(peer1, PlayerSlot::PLAYER_1, 10, 10);
        manager.add_peer(peer2, PlayerSlot::PLAYER_2, 10, 10);
        manager.add_peer(peer3, PlayerSlot::PLAYER_3, 10, 10);

        // Each player's gamepad 0 maps to their player slot
        assert_eq!(manager.map_gamepad_id(peer1, 0), Some(0));
        assert_eq!(manager.map_gamepad_id(peer2, 0), Some(1));
        assert_eq!(manager.map_gamepad_id(peer3, 0), Some(2));

        // Non-zero gamepad IDs are rejected
        assert_eq!(manager.map_gamepad_id(peer1, 1), None);
    }

    #[test]
    fn test_keyboard_mouse_access() {
        let mut manager = PeerManager::new();

        let peer1 = PeerId(1);
        let peer2 = PeerId(2);

        manager.add_peer(peer1, PlayerSlot::PLAYER_1, 10, 10);
        manager.add_peer(peer2, PlayerSlot::PLAYER_2, 10, 10);

        // By default, only Player 1 can use keyboard/mouse
        assert!(manager.can_use_keyboard_mouse(peer1));
        assert!(!manager.can_use_keyboard_mouse(peer2));

        // Enable guests keyboard/mouse
        manager.set_guests_keyboard_mouse_enabled(true);
        assert!(manager.can_use_keyboard_mouse(peer1));
        assert!(manager.can_use_keyboard_mouse(peer2));

        // Disable again
        manager.set_guests_keyboard_mouse_enabled(false);
        assert!(manager.can_use_keyboard_mouse(peer1));
        assert!(!manager.can_use_keyboard_mouse(peer2));
    }
}
