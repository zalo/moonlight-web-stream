#!/bin/bash
# Start all services for Discord Cloud Gaming

set -e

echo "Starting Discord Cloud Gaming services..."

# Create required directories
mkdir -p /tmp/runtime
mkdir -p /tmp/pulse
mkdir -p /data/sunshine
mkdir -p /data/server
chmod 700 /tmp/runtime

# Export environment
export DISPLAY=:99
export PULSE_SERVER=unix:/tmp/pulse/native
export XDG_RUNTIME_DIR=/tmp/runtime
export HOME=/root

# Start Xvfb (virtual display)
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 2

# Verify X is running
if ! xdpyinfo -display :99 >/dev/null 2>&1; then
    echo "ERROR: Xvfb failed to start"
    exit 1
fi
echo "Xvfb started successfully"

# Start D-Bus
echo "Starting D-Bus..."
if [ ! -S /tmp/dbus-session.sock ]; then
    dbus-daemon --session --fork --print-address > /tmp/dbus-address
fi
export DBUS_SESSION_BUS_ADDRESS=$(cat /tmp/dbus-address 2>/dev/null || echo "")

# Start PulseAudio
echo "Starting PulseAudio..."
pulseaudio --daemonize=no --exit-idle-time=-1 --disable-shm \
    --load="module-native-protocol-unix auth-anonymous=1 socket=/tmp/pulse/native" \
    --load="module-always-sink" \
    --load="module-null-sink sink_name=game_audio sink_properties=device.description=GameAudio" &
PULSE_PID=$!
sleep 2
echo "PulseAudio started"

# Configure default audio sink
pactl set-default-sink game_audio 2>/dev/null || true

# Start Sunshine if it exists
if command -v sunshine &> /dev/null; then
    echo "Starting Sunshine..."

    # Create Sunshine config directory
    mkdir -p /data/sunshine

    # Check if Sunshine needs initial setup
    if [ ! -f /data/sunshine/sunshine.conf ]; then
        echo "Creating initial Sunshine configuration..."
        cat > /data/sunshine/sunshine.conf << 'EOF'
origin_web_ui_allowed = wan
encoder = nvenc
min_log_level = info
EOF
    fi

    # Start Sunshine with config from data volume
    sunshine /data/sunshine/sunshine.conf &
    SUNSHINE_PID=$!
    sleep 3
    echo "Sunshine started (PID: $SUNSHINE_PID)"
else
    echo "WARNING: Sunshine not found, skipping..."
fi

# Signal handler for cleanup
cleanup() {
    echo "Shutting down services..."
    kill $SUNSHINE_PID 2>/dev/null || true
    kill $PULSE_PID 2>/dev/null || true
    kill $XVFB_PID 2>/dev/null || true
    exit 0
}

trap cleanup SIGTERM SIGINT

echo "All services started successfully"
echo "Display: $DISPLAY"
echo "Audio: $PULSE_SERVER"

# Keep script running
wait
