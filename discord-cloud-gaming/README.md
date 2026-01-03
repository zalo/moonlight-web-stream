# Discord Cloud Gaming

Cloud gaming system that runs on Modal with an L4 GPU, streams via Sunshine/Moonlight Web, and integrates with Discord Activities for multiplayer couch gaming with friends.

## Features

- **Cloud GPU**: L4 GPU for rendering games at high quality
- **Sunshine Streaming**: Hardware-accelerated video encoding
- **WebRTC Delivery**: Low-latency streaming to browsers
- **Discord Activity**: Join directly from Discord voice channels
- **Multiplayer**: Up to 4 players with gamepad support
- **Spectators**: Unlimited spectators can watch

## Prerequisites

1. [Modal](https://modal.com) account
2. [Discord Developer Application](https://discord.com/developers/applications)
3. (Optional) TURN server for reliable NAT traversal

## Setup

### 1. Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Under "OAuth2" > "General":
   - Add redirect URI: `https://your-modal-url.modal.run/api/discord/callback`
4. Under "Activities":
   - Enable Activities
   - Set the Activity URL Root to your Modal deployment URL
5. Copy the Client ID and Client Secret

### 2. Configure Modal Secrets

Create a Modal secret named `discord-cloud-gaming`:

```bash
modal secret create discord-cloud-gaming \
  DISCORD_CLIENT_ID="your-client-id" \
  DISCORD_CLIENT_SECRET="your-client-secret" \
  TURN_SERVER_URL="turn:your-turn-server.com:3478" \
  TURN_USERNAME="your-turn-username" \
  TURN_CREDENTIAL="your-turn-credential"
```

TURN server credentials are optional but recommended for reliable connectivity through restrictive NATs.

### 3. Deploy to Modal

```bash
cd discord-cloud-gaming
modal deploy modal_app.py
```

### 4. Configure Discord Activity URL

After deployment, Modal will give you a URL like `https://your-app--cloud-gaming-server.modal.run`.

1. Go back to Discord Developer Portal
2. Under "Activities", set the Activity URL Root to your Modal URL
3. Add OAuth2 redirect: `https://your-modal-url.modal.run`

## Usage

### Starting a Gaming Session

1. As the host, navigate to your Modal URL
2. Log in and start a streaming session
3. The session automatically creates a room

### Inviting Friends via Discord

1. In a Discord voice channel, start the Activity
2. Friends in the voice channel will see the Activity and can join
3. New joiners start as spectators
4. Click "Join as Player" to take a player slot (up to 4 players)

### Controls

- **Players 1-4**: Each gets a dedicated gamepad slot
- **Keyboard/Mouse**: Host (Player 1) has keyboard/mouse by default
- **Spectators**: Watch-only, no input

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Modal Container                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────────┐  │
│  │  Xvfb    │  │PulseAudio│  │       Sunshine           │  │
│  │ (Display)│  │ (Audio)  │  │ (Game Streaming Server)  │  │
│  └────┬─────┘  └────┬─────┘  └────────────┬─────────────┘  │
│       │             │                      │                │
│       └─────────────┼──────────────────────┘                │
│                     │                                       │
│              ┌──────┴──────┐                                │
│              │ Web Server  │                                │
│              │ (Rust/Actix)│                                │
│              └──────┬──────┘                                │
└─────────────────────┼───────────────────────────────────────┘
                      │ WebSocket/WebRTC
                      │
         ┌────────────┴────────────┐
         │                         │
    ┌────┴────┐              ┌────┴────┐
    │ Player  │              │Spectator│
    │(Browser)│              │(Browser)│
    └─────────┘              └─────────┘
```

## Configuration

The server configuration is stored at `/data/server/config.json` inside the container.

Key settings:

```json
{
  "webrtc": {
    "ice_servers": [
      {
        "urls": ["stun:stun.l.google.com:19302"]
      },
      {
        "urls": ["turn:your-turn-server.com:3478"],
        "username": "...",
        "credential": "..."
      }
    ]
  },
  "discord": {
    "client_id": "...",
    "client_secret": "..."
  }
}
```

## Persistent Storage

The Modal volume `discord-cloud-gaming-data` stores:
- Server configuration
- User data
- Sunshine configuration
- Game saves (mount additional paths as needed)

## Troubleshooting

### "No gaming session found"
- The host must start the session before sharing the Discord Activity
- Check that the room was created successfully

### Video not loading
- Check browser console for WebRTC errors
- Ensure STUN/TURN servers are accessible
- Try disabling VPN or firewall

### High latency
- Use a TURN server closer to your users
- Check network conditions
- Lower video quality settings

### Authentication failed
- Verify Discord credentials in Modal secrets
- Check OAuth2 redirect URIs match your deployment URL

## Development

### Local Testing

```bash
# Run Modal in serve mode for hot reloading
modal serve modal_app.py
```

### Building Manually

```bash
# Build Rust backend
cd moonlight-web-stream
cargo build --release

# Build frontend
cd moonlight-web/web-server
npm install
npm run build
```

## Security Notes

- Discord credentials should only be stored in Modal secrets
- TURN credentials should be rotated regularly if using static credentials
- Consider using TURN with time-limited credentials for production
