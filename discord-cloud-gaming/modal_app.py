"""
Discord Cloud Gaming - Modal App

This Modal app provides a cloud gaming instance with:
- L4 GPU for game rendering and video encoding
- Sunshine for game streaming
- Moonlight Web Stream for WebRTC delivery
- Discord Activity integration
"""

import modal
import subprocess
import os
import time
import signal
import sys
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
    .copy_local_dir(
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
    .copy_local_file(
        str(Path(__file__).parent / "config" / "xorg.conf"),
        "/etc/X11/xorg.conf"
    )
    .copy_local_file(
        str(Path(__file__).parent / "config" / "supervisord.conf"),
        "/etc/supervisor/conf.d/gaming.conf"
    )
    .copy_local_file(
        str(Path(__file__).parent / "config" / "sunshine.conf"),
        "/etc/sunshine/sunshine.conf"
    )
    .copy_local_file(
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
)


# Secrets for Discord and TURN server credentials
discord_secret = modal.Secret.from_name("discord-cloud-gaming", required_keys=[])


@app.function(
    image=image,
    gpu="L4",
    timeout=3600 * 4,  # 4 hour max session
    volumes={"/data": game_data},
    secrets=[discord_secret],
    # Allow WebRTC traffic
    allow_concurrent_inputs=100,
)
@modal.web_server(port=8080, startup_timeout=120)
def cloud_gaming_server():
    """
    Main cloud gaming server endpoint.

    This runs:
    1. Xvfb (virtual display)
    2. PulseAudio (virtual audio)
    3. Sunshine (game streaming server)
    4. Moonlight Web Server (WebRTC frontend)
    """
    import subprocess
    import os
    import time

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

    # Create config if it doesn't exist
    config_path = "/data/server/config.json"
    if not os.path.exists(config_path):
        import json

        # Build ICE servers list - STUN servers first
        ice_servers = [
            {
                "urls": [
                    "stun:stun.l.google.com:19302",
                    "stun:stun1.l.google.com:3478",
                    "stun:stun2.l.google.com:19302"
                ]
            }
        ]

        # Add TURN server if configured via secrets
        turn_url = os.environ.get("TURN_SERVER_URL")
        turn_username = os.environ.get("TURN_USERNAME")
        turn_credential = os.environ.get("TURN_CREDENTIAL")
        if turn_url and turn_username and turn_credential:
            ice_servers.append({
                "urls": [turn_url],
                "username": turn_username,
                "credential": turn_credential
            })

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
    print("To deploy:")
    print("  modal deploy modal_app.py")
    print()
    print("To run locally for testing:")
    print("  modal serve modal_app.py")
    print()
    print("The web server will be available at the Modal-provided URL.")
