/**
 * Discord Activity Integration for Cloud Gaming
 *
 * This module handles:
 * - Discord Embedded App SDK initialization
 * - Automatic room joining as spectator
 * - Player promotion/demotion
 * - Participant list management
 * - WebRTC video/audio streaming
 */

import { DiscordSDK, DiscordSDKMock } from "@discord/embedded-app-sdk";
import type { Types } from "@discord/embedded-app-sdk";
import {
    RoomInfo,
    RoomParticipant,
    RoomRole,
    StreamClientMessage,
    StreamServerMessage,
    PlayerSlot,
    RtcIceServer,
    StreamCapabilities,
} from "./api_bindings.js";

// Configuration - these would typically come from environment or config endpoint
const DISCORD_CLIENT_ID = "YOUR_DISCORD_CLIENT_ID"; // Replace with actual client ID
const API_BASE = window.location.origin;

// Discord SDK instance
let discordSdk: DiscordSDK | DiscordSDKMock;

// Activity state
interface ActivityState {
    isConnected: boolean;
    roomId: string | null;
    role: RoomRole;
    playerSlot: PlayerSlot | null;
    participants: RoomParticipant[];
    discordUser: Types.GetActivityInstanceConnectedParticipantsResponse["participants"][0] | null;
    ws: WebSocket | null;
    peerConnection: RTCPeerConnection | null;
    iceServers: RtcIceServer[];
    videoElement: HTMLVideoElement | null;
    capabilities: StreamCapabilities | null;
}

const state: ActivityState = {
    isConnected: false,
    roomId: null,
    role: "Spectator",
    playerSlot: null,
    participants: [],
    discordUser: null,
    ws: null,
    peerConnection: null,
    iceServers: [],
    videoElement: null,
    capabilities: null,
};

// DOM Elements
function getElements() {
    return {
        loadingOverlay: document.getElementById("loading-overlay") as HTMLDivElement,
        loadingText: document.getElementById("loading-text") as HTMLDivElement,
        streamVideo: document.getElementById("stream-video") as HTMLVideoElement,
        streamCanvas: document.getElementById("stream-canvas") as HTMLCanvasElement,
        joinPlayerBtn: document.getElementById("join-player-btn") as HTMLButtonElement,
        leaveBtn: document.getElementById("leave-btn") as HTMLButtonElement,
        participantsBtn: document.getElementById("participants-btn") as HTMLButtonElement,
        participantsPanel: document.getElementById("participants-panel") as HTMLDivElement,
        participantsList: document.getElementById("participants-list") as HTMLDivElement,
        participantCount: document.getElementById("participant-count") as HTMLDivElement,
        participantsCountBadge: document.getElementById("participants-count-badge") as HTMLSpanElement,
        fullscreenBtn: document.getElementById("fullscreen-btn") as HTMLButtonElement,
        activityContainer: document.getElementById("activity-container") as HTMLDivElement,
    };
}

let elements: ReturnType<typeof getElements>;

/**
 * Initialize the Discord SDK and Activity
 */
async function initializeDiscord(): Promise<void> {
    elements = getElements();
    state.videoElement = elements.streamVideo;

    updateLoadingState("Initializing Discord SDK...");

    try {
        // Check if we're in an iframe (Discord Activity) or standalone
        const isInIframe = window.self !== window.top;

        if (isInIframe) {
            // Initialize real Discord SDK
            discordSdk = new DiscordSDK(DISCORD_CLIENT_ID);
            await discordSdk.ready();
            console.log("Discord SDK ready");
        } else {
            // Development mode - use mock SDK
            console.warn("Not in Discord Activity, using mock SDK for development");
            discordSdk = new DiscordSDKMock(DISCORD_CLIENT_ID, "guild_id", "channel_id", "user_id");
        }

        // Get activity instance info
        const instanceId = discordSdk.instanceId;
        console.log("Activity instance ID:", instanceId);

        // Authenticate with Discord
        await authenticateWithDiscord();

        // Get the room ID (either from instance or create new)
        const roomId = await getOrCreateRoom(instanceId);
        state.roomId = roomId;

        // Join the room as a spectator
        await joinRoomAsSpectator(roomId);

    } catch (error) {
        console.error("Failed to initialize Discord:", error);
        updateLoadingState("Failed to connect to Discord");
    }
}

/**
 * Authenticate with Discord OAuth2
 */
async function authenticateWithDiscord(): Promise<void> {
    updateLoadingState("Authenticating with Discord...");

    try {
        // Get the authorization code from Discord SDK
        const { code } = await discordSdk.commands.authorize({
            client_id: DISCORD_CLIENT_ID,
            response_type: "code",
            state: "",
            prompt: "none",
            scope: ["identify", "guilds"],
        });

        // Exchange the code for an access token via our backend
        const response = await fetch(`${API_BASE}/api/discord/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
        });

        if (!response.ok) {
            throw new Error("Failed to exchange Discord code for token");
        }

        const { access_token } = await response.json();

        // Authenticate with Discord SDK
        await discordSdk.commands.authenticate({ access_token });

        // Get current user info
        const participants = await discordSdk.commands.getInstanceConnectedParticipants();
        state.discordUser = participants.participants[0] ?? null;

        console.log("Authenticated as:", state.discordUser);
    } catch (error) {
        console.warn("Discord auth failed, continuing with limited features:", error);
    }
}

/**
 * Get an existing room for this activity instance or create one
 */
async function getOrCreateRoom(instanceId: string): Promise<string> {
    updateLoadingState("Finding gaming session...");

    // Check if there's already a room for this activity instance
    const response = await fetch(`${API_BASE}/api/discord/room?instance_id=${encodeURIComponent(instanceId)}`);

    if (response.ok) {
        const data = await response.json();
        if (data.room_id) {
            console.log("Found existing room:", data.room_id);
            return data.room_id;
        }
    }

    // No room exists - this shouldn't happen in normal use
    // The host should have created the room before sharing the activity
    throw new Error("No gaming session found for this activity");
}

/**
 * Join the room as a spectator
 */
async function joinRoomAsSpectator(roomId: string): Promise<void> {
    updateLoadingState("Joining as spectator...");

    // Connect via WebSocket to the guest stream endpoint
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/guest/stream?room=${encodeURIComponent(roomId)}`;

    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
        console.log("WebSocket connected");

        // Send join as spectator message
        const message: StreamClientMessage = {
            JoinAsSpectator: {
                room_id: roomId,
                player_name: state.discordUser?.username ?? "Guest",
                discord_user_id: state.discordUser?.id ?? null,
                discord_avatar: state.discordUser?.avatar
                    ? `https://cdn.discordapp.com/avatars/${state.discordUser.id}/${state.discordUser.avatar}.png`
                    : null,
                video_frame_queue_size: 4,
                audio_sample_queue_size: 4,
            },
        };
        sendWsMessage(message);
    };

    state.ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data) as StreamServerMessage;
            handleServerMessage(message);
        } catch (error) {
            console.error("Failed to parse server message:", error);
        }
    };

    state.ws.onclose = () => {
        console.log("WebSocket closed");
        state.isConnected = false;
        updateLoadingState("Disconnected from server");
        elements.loadingOverlay.classList.remove("hidden");
    };

    state.ws.onerror = (error) => {
        console.error("WebSocket error:", error);
    };
}

/**
 * Send a message over WebSocket
 */
function sendWsMessage(message: StreamClientMessage): void {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(message));
    }
}

/**
 * Handle messages from the server
 */
function handleServerMessage(message: StreamServerMessage): void {
    console.log("Server message:", message);

    if (typeof message === "object" && "SpectatorJoined" in message) {
        const { room } = message.SpectatorJoined;
        state.isConnected = true;
        state.role = "Spectator";
        state.participants = room.participants;

        updateUI();
        hideLoading();

        console.log("Joined as spectator:", room);
    } else if (typeof message === "object" && "RoomJoined" in message) {
        const { room, player_slot } = message.RoomJoined;
        state.isConnected = true;
        state.role = "Player";
        state.playerSlot = player_slot;
        state.participants = room.participants;

        updateUI();
        hideLoading();

        console.log("Joined as player:", room, "slot:", player_slot);
    } else if (typeof message === "object" && "Setup" in message) {
        // ICE servers received - initialize WebRTC
        state.iceServers = message.Setup.ice_servers;
        console.log("Received ICE servers:", state.iceServers);
        initializeWebRTC();
    } else if (typeof message === "object" && "WebRtc" in message) {
        handleWebRtcSignaling(message.WebRtc);
    } else if (typeof message === "object" && "PromotedToPlayer" in message) {
        const { player_slot, room } = message.PromotedToPlayer;
        state.role = "Player";
        state.playerSlot = player_slot;
        state.participants = room.participants;

        updateUI();
        enableInput();

        console.log("Promoted to player:", player_slot);
    } else if (typeof message === "object" && "DemotedToSpectator" in message) {
        const { room } = message.DemotedToSpectator;
        state.role = "Spectator";
        state.playerSlot = null;
        state.participants = room.participants;

        updateUI();
        disableInput();

        console.log("Demoted to spectator");
    } else if (typeof message === "object" && "PlayerSlotRequestResult" in message) {
        const { granted, player_slot, reason } = message.PlayerSlotRequestResult;
        if (granted && player_slot) {
            state.role = "Player";
            state.playerSlot = player_slot;
            enableInput();
        } else {
            console.log("Player slot request denied:", reason);
            // Could show a toast notification here
        }
        updateUI();
    } else if (typeof message === "object" && "ParticipantsUpdated" in message) {
        const { participants } = message.ParticipantsUpdated;
        state.participants = participants;
        updateParticipantsList();
    } else if (typeof message === "object" && "RoomUpdated" in message) {
        const { room } = message.RoomUpdated;
        state.participants = room.participants;
        updateParticipantsList();
    } else if (typeof message === "object" && "ConnectionComplete" in message) {
        state.capabilities = message.ConnectionComplete.capabilities;
        console.log("Stream connection complete:", message.ConnectionComplete);
    } else if (message === "RoomClosed") {
        state.isConnected = false;
        updateLoadingState("Gaming session ended");
        elements.loadingOverlay.classList.remove("hidden");
    }
}

/**
 * Initialize WebRTC peer connection
 */
function initializeWebRTC(): void {
    const iceServers: RTCIceServer[] = state.iceServers.map(server => ({
        urls: server.urls,
        username: server.username || undefined,
        credential: server.credential || undefined,
    }));

    state.peerConnection = new RTCPeerConnection({
        iceServers: iceServers,
    });

    state.peerConnection.ontrack = (event) => {
        console.log("Received track:", event.track.kind);
        if (event.track.kind === "video" && state.videoElement) {
            state.videoElement.srcObject = event.streams[0];
            state.videoElement.play().catch(console.error);
        }
    };

    state.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            sendWsMessage({
                WebRtc: {
                    AddIceCandidate: {
                        candidate: event.candidate.candidate,
                        sdp_mid: event.candidate.sdpMid ?? null,
                        sdp_mline_index: event.candidate.sdpMLineIndex ?? null,
                        username_fragment: event.candidate.usernameFragment ?? null,
                    },
                },
            });
        }
    };

    state.peerConnection.onconnectionstatechange = () => {
        console.log("Connection state:", state.peerConnection?.connectionState);
    };

    // Request to set transport to WebRTC
    sendWsMessage({ SetTransport: "WebRTC" });
}

/**
 * Handle WebRTC signaling messages
 */
async function handleWebRtcSignaling(signaling: any): Promise<void> {
    if (!state.peerConnection) return;

    if ("Description" in signaling) {
        const desc = signaling.Description;
        await state.peerConnection.setRemoteDescription({
            type: desc.ty.toLowerCase(),
            sdp: desc.sdp,
        });

        if (desc.ty === "offer") {
            const answer = await state.peerConnection.createAnswer();
            await state.peerConnection.setLocalDescription(answer);

            sendWsMessage({
                WebRtc: {
                    Description: {
                        ty: "answer",
                        sdp: answer.sdp!,
                    },
                },
            });
        }
    } else if ("AddIceCandidate" in signaling) {
        const candidate = signaling.AddIceCandidate;
        await state.peerConnection.addIceCandidate({
            candidate: candidate.candidate,
            sdpMid: candidate.sdp_mid ?? undefined,
            sdpMLineIndex: candidate.sdp_mline_index ?? undefined,
        });
    }
}

/**
 * Enable input for players
 */
function enableInput(): void {
    // TODO: Add keyboard/mouse/gamepad input handling for players
    console.log("Input enabled for player");
}

/**
 * Disable input for spectators
 */
function disableInput(): void {
    // TODO: Remove input handling for spectators
    console.log("Input disabled for spectator");
}

/**
 * Request to become a player
 */
function requestPlayerSlot(): void {
    if (!state.ws || state.role !== "Spectator") return;

    sendWsMessage("RequestPlayerSlot");
}

/**
 * Release player slot and become spectator
 */
function releasePlayerSlot(): void {
    if (!state.ws || state.role === "Spectator") return;

    sendWsMessage("ReleasePlayerSlot");
}

/**
 * Update the UI based on current state
 */
function updateUI(): void {
    // Update join/leave buttons
    if (state.role === "Spectator") {
        elements.joinPlayerBtn.style.display = "flex";
        elements.leaveBtn.style.display = "none";
    } else {
        elements.joinPlayerBtn.style.display = "none";
        elements.leaveBtn.style.display = "flex";
    }

    // Update participant counts
    updateParticipantsList();
}

/**
 * Update the participants list UI
 */
function updateParticipantsList(): void {
    const list = elements.participantsList;
    list.innerHTML = "";

    // Sort: Host first, then players, then spectators
    const roleOrder: Record<RoomRole, number> = { Host: 0, Player: 1, Spectator: 2 };
    const sorted = [...state.participants].sort((a, b) => {
        return roleOrder[a.role] - roleOrder[b.role];
    });

    for (const participant of sorted) {
        const el = document.createElement("div");
        el.className = "participant";

        const roleClass = participant.role.toLowerCase();
        const roleText = participant.role === "Host" ? "Host (Player 1)"
            : participant.role === "Player" ? `Player ${((participant.slot as any)?.valueOf?.() || 0) + 1}`
            : "Spectator";

        const avatarContent = participant.discord_avatar
            ? `<img src="${participant.discord_avatar}" alt="" />`
            : (participant.name || "?").charAt(0).toUpperCase();

        el.innerHTML = `
            <div class="participant-avatar">
                ${avatarContent}
            </div>
            <div class="participant-info">
                <div class="participant-name">${participant.name || "Anonymous"}</div>
                <div class="participant-role ${roleClass}">${roleText}</div>
            </div>
        `;

        list.appendChild(el);
    }

    // Update counts
    const total = state.participants.length;

    elements.participantCount.textContent = `${total} ${total === 1 ? "person" : "people"}`;
    elements.participantsCountBadge.textContent = String(total);
}

/**
 * Update loading state text
 */
function updateLoadingState(text: string): void {
    if (elements?.loadingText) {
        elements.loadingText.textContent = text;
    }
}

/**
 * Hide loading overlay
 */
function hideLoading(): void {
    elements.loadingOverlay.classList.add("hidden");
}

/**
 * Toggle participants panel
 */
function toggleParticipantsPanel(): void {
    elements.participantsPanel.classList.toggle("open");
}

/**
 * Toggle fullscreen
 */
function toggleFullscreen(): void {
    if (document.fullscreenElement) {
        document.exitFullscreen();
        elements.activityContainer.classList.remove("fullscreen");
    } else {
        elements.activityContainer.requestFullscreen();
        elements.activityContainer.classList.add("fullscreen");
    }
}

// Initialize on load
document.addEventListener("DOMContentLoaded", () => {
    elements = getElements();

    // Event listeners
    elements.joinPlayerBtn.addEventListener("click", requestPlayerSlot);
    elements.leaveBtn.addEventListener("click", releasePlayerSlot);
    elements.participantsBtn.addEventListener("click", toggleParticipantsPanel);
    elements.fullscreenBtn.addEventListener("click", toggleFullscreen);

    // Handle fullscreen changes
    document.addEventListener("fullscreenchange", () => {
        if (!document.fullscreenElement) {
            elements.activityContainer.classList.remove("fullscreen");
        }
    });

    // Start initialization
    initializeDiscord();
});

// Export for debugging
(window as any).activityState = state;
