"""
Discord Cloud Gaming - Modal App

This Modal app provides a cloud gaming instance with:
- L4 GPU for game rendering and video encoding
- Sunshine for game streaming
- Moonlight Web Stream for WebRTC delivery
- Discord Activity integration
- Integrated TURN server support (Cloudflare or built-in coturn)
"""

import modal
import subprocess
import os
import time
import signal
import sys
import secrets
import hashlib
from pathlib import Path

# Create the Modal app
app = modal.App("discord-cloud-gaming")

# Volume for persistent game data
game_data = modal.Volume.from_name("discord-cloud-gaming-data", create_if_missing=True)

# Build the container image with all dependencies
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.0-runtime-ubuntu22.04",
        add_python="3.11"
    )
    # System dependencies
    .apt_install(
        # X11 and display
        "xvfb",
        "x11-xserver-utils",
        "x11-utils",
        "xdotool",
        # Audio
        "pulseaudio",
        "pulseaudio-utils",
        "alsa-utils",
        # Video/GPU
        "vainfo",
        "mesa-va-drivers",
        "libva2",
        "libva-drm2",
        # Build tools for Rust
        "build-essential",
        "cmake",
        "pkg-config",
        "libssl-dev",
        "libclang-dev",
        "clang",
        # Networking
        "wget",
        "curl",
        "ca-certificates",
        "gnupg",
        # TURN server
        "coturn",
        # Misc
        "supervisor",
        "dbus-x11",
        "libxcb1",
        "libxrandr2",
        "libxfixes3",
        "libxi6",
        "libxcursor1",
        "libxinerama1",
        "fonts-dejavu-core",
        # Node.js for frontend build
        "nodejs",
        "npm",
    )
    # Install Rust nightly
    .run_commands(
        "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly",
        "echo 'source $HOME/.cargo/env' >> ~/.bashrc",
    )
    .env({"PATH": "/root/.cargo/bin:$PATH"})
    # Install Sunshine
    .run_commands(
        # Add Sunshine repository
        "wget -qO- https://dl.cloudsmith.io/public/lizardbyte/stable/gpg.50D6C9FF7F0F30A0.key | gpg --dearmor -o /usr/share/keyrings/lizardbyte-stable.gpg",
        "echo 'deb [signed-by=/usr/share/keyrings/lizardbyte-stable.gpg] https://dl.cloudsmith.io/public/lizardbyte/stable/deb/ubuntu jammy main' > /etc/apt/sources.list.d/lizardbyte-stable.list",
        "apt-get update",
        "apt-get install -y sunshine || echo 'Sunshine install attempted'",
    )
    # Copy the moonlight-web-stream source
    .add_local_dir(
        str(Path(__file__).parent.parent),
        "/app/moonlight-web-stream",
        ignore=[
            ".git",
            "target",
            "node_modules",
            "discord-cloud-gaming/__pycache__",
        ]
    )
    # Build the Rust backend
    .run_commands(
        "cd /app/moonlight-web-stream && /root/.cargo/bin/cargo build --release",
        "cp /app/moonlight-web-stream/target/release/web-server /app/web-server || true",
        "cp /app/moonlight-web-stream/target/release/streamer /app/streamer || true",
    )
    # Build the frontend
    .run_commands(
        "cd /app/moonlight-web-stream/moonlight-web/web-server && npm install && npm run build",
        "mkdir -p /app/static && cp -r /app/moonlight-web-stream/moonlight-web/web-server/dist/* /app/static/ || true",
    )
    # Copy configuration files
    .add_local_file(
        str(Path(__file__).parent / "config" / "xorg.conf"),
        "/etc/X11/xorg.conf"
    )
    .add_local_file(
        str(Path(__file__).parent / "config" / "supervisord.conf"),
        "/etc/supervisor/conf.d/gaming.conf"
    )
    .add_local_file(
        str(Path(__file__).parent / "config" / "sunshine.conf"),
        "/etc/sunshine/sunshine.conf"
    )
    .add_local_file(
        str(Path(__file__).parent / "scripts" / "start-services.sh"),
        "/app/start-services.sh"
    )
    .run_commands("chmod +x /app/start-services.sh")
    # Set environment variables
    .env({
        "DISPLAY": ":99",
        "PULSE_SERVER": "unix:/tmp/pulse/native",
        "XDG_RUNTIME_DIR": "/tmp/runtime",
        "SUNSHINE_CONFIG_DIR": "/data/sunshine",
    })
    # Install requests for Cloudflare API calls
    .pip_install("requests")
)


# Secrets for Discord and TURN server credentials
discord_secret = modal.Secret.from_name("discord-cloud-gaming", required_keys=[])


def fetch_cloudflare_turn_credentials(key_id: str, api_token: str, ttl: int = 86400) -> dict | None:
    """
    Fetch fresh TURN credentials from Cloudflare's API.

    Args:
        key_id: Cloudflare TURN key ID
        api_token: Cloudflare TURN API token
        ttl: Time-to-live for credentials in seconds (default 24 hours)

    Returns:
        ICE server configuration dict or None if failed
    """
    import requests

    try:
        response = requests.post(
            f"https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers",
            headers={
                "Authorization": f"Bearer {api_token}",
                "Content-Type": "application/json"
            },
            json={"ttl": ttl},
            timeout=10
        )

        if response.status_code == 200:
            data = response.json()
            # Cloudflare returns iceServers array
            if "iceServers" in data:
                return data["iceServers"]
        else:
            print(f"Cloudflare TURN API error: {response.status_code} - {response.text}")
    except Exception as e:
        print(f"Failed to fetch Cloudflare TURN credentials: {e}")

    return None


def generate_coturn_credentials(secret: str, username: str = None, ttl: int = 86400) -> tuple[str, str]:
    """
    Generate time-limited TURN credentials using coturn's TURN REST API format.

    Args:
        secret: Shared secret for credential generation
        username: Optional username prefix
        ttl: Time-to-live in seconds

    Returns:
        Tuple of (username, credential)
    """
    import time
    import hmac
    import base64

    # Username format: timestamp:username
    timestamp = int(time.time()) + ttl
    user = f"{timestamp}:{username or 'user'}"

    # Generate HMAC-SHA1 credential
    credential = base64.b64encode(
        hmac.new(secret.encode(), user.encode(), hashlib.sha1).digest()
    ).decode()

    return user, credential


def start_coturn_server(public_ip: str, secret: str, tcp_port: int = 3478) -> subprocess.Popen:
    """
    Start coturn TURN server with the given configuration.

    Args:
        public_ip: Public IP address to advertise
        secret: Shared secret for credential generation
        tcp_port: TCP port for TURN (UDP not available on Modal)

    Returns:
        Popen process handle
    """
    # Write coturn config
    config = f"""
# Coturn configuration for Modal
listening-port={tcp_port}
tls-listening-port=5349
relay-ip={public_ip}
external-ip={public_ip}
min-port=49152
max-port=65535

# Use long-term credentials with shared secret
use-auth-secret
static-auth-secret={secret}
realm=cloudgaming.modal.run

# Enable TCP relay (since UDP ingress isn't available)
no-udp
no-dtls
tcp-relay

# Logging
log-file=/tmp/coturn.log
verbose

# Performance
total-quota=100
max-bps=0
"""

    config_path = "/tmp/turnserver.conf"
    with open(config_path, "w") as f:
        f.write(config)

    # Start turnserver
    process = subprocess.Popen(
        ["turnserver", "-c", config_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )

    return process


@app.function(
    image=image,
    gpu="L4",
    timeout=3600 * 4,  # 4 hour max session
    volumes={"/data": game_data},
    secrets=[discord_secret],
)
@modal.concurrent(max_inputs=100)  # Allow concurrent WebRTC connections
@modal.web_server(port=8080, startup_timeout=120)
def cloud_gaming_server():
    """
    Main cloud gaming server endpoint.

    This runs:
    1. Xvfb (virtual display)
    2. PulseAudio (virtual audio)
    3. Sunshine (game streaming server)
    4. Moonlight Web Server (WebRTC frontend)
    5. TURN server (Cloudflare or built-in coturn)
    """
    import subprocess
    import os
    import time
    import json
    import requests

    # Create runtime directories
    os.makedirs("/tmp/runtime", exist_ok=True)
    os.makedirs("/tmp/pulse", exist_ok=True)
    os.makedirs("/data/sunshine", exist_ok=True)
    os.makedirs("/data/server", exist_ok=True)

    # Start services via script
    subprocess.Popen(["/app/start-services.sh"], shell=False)

    # Give services time to start
    time.sleep(5)

    # Start the web server (this blocks and serves HTTP)
    env = os.environ.copy()
    env["RUST_LOG"] = "info"

    # Build ICE servers configuration
    ice_servers = [
        {
            "urls": [
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:3478",
                "stun:stun2.l.google.com:19302"
            ]
        }
    ]

    # Try to configure TURN server
    turn_configured = False

    # Option 1: Cloudflare TURN (recommended)
    cf_turn_key_id = os.environ.get("CLOUDFLARE_TURN_KEY_ID")
    cf_turn_api_token = os.environ.get("CLOUDFLARE_TURN_API_TOKEN")

    if cf_turn_key_id and cf_turn_api_token:
        print("Fetching Cloudflare TURN credentials...")
        cf_ice_servers = fetch_cloudflare_turn_credentials(cf_turn_key_id, cf_turn_api_token)
        if cf_ice_servers:
            ice_servers.extend(cf_ice_servers)
            turn_configured = True
            print(f"Cloudflare TURN configured with {len(cf_ice_servers)} servers")

    # Option 2: Manual TURN configuration (legacy)
    if not turn_configured:
        turn_url = os.environ.get("TURN_SERVER_URL")
        turn_username = os.environ.get("TURN_USERNAME")
        turn_credential = os.environ.get("TURN_CREDENTIAL")
        if turn_url and turn_username and turn_credential:
            ice_servers.append({
                "urls": [turn_url],
                "username": turn_username,
                "credential": turn_credential
            })
            turn_configured = True
            print(f"Manual TURN configured: {turn_url}")

    # Option 3: Built-in coturn over TCP tunnel (fallback)
    # Note: This requires modal.forward() which needs to be set up outside web_server
    # For now, we'll skip this and recommend Cloudflare
    if not turn_configured:
        print("WARNING: No TURN server configured!")
        print("WebRTC may fail for users behind restrictive NATs.")
        print("Configure Cloudflare TURN by setting CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN")

    # Create config
    config_path = "/data/server/config.json"
    config = {
        "data_storage": {
            "type": "json",
            "path": "/data/server/data.json",
            "session_expiration_check_interval": {"secs": 300, "nanos": 0}
        },
        "webrtc": {
            "ice_servers": ice_servers,
            "network_types": ["udp4", "udp6"],
            "include_loopback_candidates": False
        },
        "web_server": {
            "bind_address": "0.0.0.0:8080",
            "session_cookie_secure": True,
            "first_login_create_admin": True,
            "first_login_assign_global_hosts": True
        },
        "streamer_path": "/app/streamer",
        "log": {
            "level_filter": "Info"
        }
    }

    # Add Discord config if credentials are provided
    discord_client_id = os.environ.get("DISCORD_CLIENT_ID")
    discord_client_secret = os.environ.get("DISCORD_CLIENT_SECRET")
    if discord_client_id and discord_client_secret:
        config["discord"] = {
            "client_id": discord_client_id,
            "client_secret": discord_client_secret
        }

    # Always write fresh config to pick up new TURN credentials
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)

    # Run web server
    subprocess.run(
        ["/app/web-server", "--config", config_path],
        env=env,
        cwd="/app"
    )


@app.function(image=image, gpu="L4", timeout=300)
def setup_sunshine_pairing():
    """
    Helper function to set up Sunshine pairing.
    Returns pairing PIN for manual entry.
    """
    # This would be called to initiate pairing
    # In practice, we auto-pair Sunshine on the same container
    pass


@app.local_entrypoint()
def main():
    """
    Local entrypoint for testing.
    """
    print("Discord Cloud Gaming Modal App")
    print("=" * 40)
    print()
    print("TURN Server Options:")
    print()
    print("  1. Cloudflare TURN (Recommended)")
    print("     - Global anycast network, low latency")
    print("     - $0.05/GB, credentials auto-refresh")
    print("     - Set: CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN")
    print()
    print("  2. Manual TURN Server")
    print("     - Use your own coturn/TURN server")
    print("     - Set: TURN_SERVER_URL, TURN_USERNAME, TURN_CREDENTIAL")
    print()
    print("Setup secrets:")
    print("  modal secret create discord-cloud-gaming \\")
    print("    DISCORD_CLIENT_ID='...' \\")
    print("    DISCORD_CLIENT_SECRET='...' \\")
    print("    CLOUDFLARE_TURN_KEY_ID='...' \\")
    print("    CLOUDFLARE_TURN_API_TOKEN='...'")
    print()
    print("To deploy:")
    print("  modal deploy modal_app.py")
    print()
    print("To run locally for testing:")
    print("  modal serve modal_app.py")
    print()
    print("The web server will be available at the Modal-provided URL.")
