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
3. [Cloudflare account](https://dash.cloudflare.com) (free) for TURN server

## Setup

### 1. Create Cloudflare TURN Key (Recommended)

Cloudflare TURN provides reliable NAT traversal with global anycast distribution. The Modal app automatically fetches fresh credentials at startup.

**Why Cloudflare TURN?**
| Feature | Benefit |
|---------|---------|
| **Anycast network** | Users connect to nearest of 300+ global datacenters |
| **Auto credentials** | No manual credential rotation needed |
| **Low latency** | 95% of internet users within 50ms of a server |
| **Encrypted** | End-to-end DTLS encryption (Cloudflare can't see your stream) |
| **Cost** | $0.05/GB (typically a few cents per gaming session) |

**Setup Steps:**
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **Calls** → **TURN Keys**
2. Click **Create TURN Key**
3. Give it a name (e.g., "discord-cloud-gaming")
4. Copy the **Key ID** and **API Token** - you'll need these for Modal secrets

### 2. Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Under "OAuth2" > "General":
   - Add redirect URI: `https://your-modal-url.modal.run/api/discord/callback`
4. Under "Activities":
   - Enable Activities
   - Set the Activity URL Root to your Modal deployment URL
5. Copy the Client ID and Client Secret

### 3. Configure Modal Secrets

Create a Modal secret named `discord-cloud-gaming` with your credentials:

```bash
modal secret create discord-cloud-gaming \
  DISCORD_CLIENT_ID="your-discord-client-id" \
  DISCORD_CLIENT_SECRET="your-discord-client-secret" \
  CLOUDFLARE_TURN_KEY_ID="your-cloudflare-turn-key-id" \
  CLOUDFLARE_TURN_API_TOKEN="your-cloudflare-turn-api-token"
```

| Secret | Description | Where to get it |
|--------|-------------|-----------------|
| `DISCORD_CLIENT_ID` | Discord app client ID | Discord Developer Portal → Your App → OAuth2 |
| `DISCORD_CLIENT_SECRET` | Discord app secret | Discord Developer Portal → Your App → OAuth2 |
| `CLOUDFLARE_TURN_KEY_ID` | Cloudflare TURN key ID | Cloudflare Dashboard → Calls → TURN Keys |
| `CLOUDFLARE_TURN_API_TOKEN` | Cloudflare TURN API token | Cloudflare Dashboard → Calls → TURN Keys |

**Alternative: Manual TURN Server** (if you have your own coturn server):
```bash
modal secret create discord-cloud-gaming \
  DISCORD_CLIENT_ID="..." \
  DISCORD_CLIENT_SECRET="..." \
  TURN_SERVER_URL="turn:your-turn-server.com:3478" \
  TURN_USERNAME="your-turn-username" \
  TURN_CREDENTIAL="your-turn-credential"
```

### 4. Deploy to Modal

```bash
cd discord-cloud-gaming
modal deploy modal_app.py
```

### 5. Configure Discord Activity URL

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

The server configuration is stored at `/data/server/config.json` inside the container. This is **auto-generated** at startup with your Modal secrets.

**Automatic TURN Configuration:**
When you provide `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`, the app will:
1. Fetch fresh TURN credentials from Cloudflare's API at startup
2. Configure WebRTC with the Cloudflare TURN servers automatically
3. Credentials are valid for 24 hours and refresh each new session

**Manual Configuration** (only if not using Cloudflare):
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
- **Cloudflare TURN** credentials auto-rotate each session (recommended)
- If using manual TURN, rotate credentials regularly
- All WebRTC media is encrypted end-to-end via DTLS
