# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Moonlight Web Stream is an unofficial Moonlight client that streams PC games from Sunshine to web browsers via WebRTC. It consists of a Rust web server that hosts the UI and spawns streamer subprocesses to handle individual streaming sessions.

## Build Commands

### Prerequisites
- Rust nightly toolchain
- CMake (for moonlight-common-c bindings)
- clang (for bindgen)
- Node.js/npm

### Build the Rust Backend
```bash
cargo build --release
```

### Build the Web Frontend
```bash
cd moonlight-web/web-server
npm install
npm run build
mv dist static  # The web server expects 'static' directory
```

### Full Build (Backend + Frontend)
```bash
cargo build --release
cd moonlight-web/web-server && npm install && npm run build && mv dist static
```

### Frontend Development (Watch Mode)
```bash
cd moonlight-web/web-server
npm run dev
```

### Generate TypeScript Bindings
```bash
cargo test export_bindings --package common
```

### Cross-Compile
```bash
cross build --release --target YOUR_TARGET
```
Windows uses the GNU target: `x86_64-pc-windows-gnu`

## Architecture

### Crate Structure
```
moonlight-common-sys/     # C FFI bindings to moonlight-common-c (submodule)
moonlight-common/         # Rust wrapper around moonlight-common-sys
moonlight-web/
  common/                 # Shared types between web-server and streamer
  web-server/             # Actix-web server (main entry point)
  streamer/               # Subprocess for handling WebRTC streams
```

### Process Model
The **web-server** is the main process that:
1. Serves the static web frontend
2. Manages user authentication and host configuration
3. Spawns **streamer** subprocesses for each active streaming session
4. Communicates with streamers via JSON-over-stdio IPC (`moonlight-web/common/src/ipc.rs`)

### Key Data Flows
- Browser <-> Web Server: HTTP/WebSocket (Actix-web)
- Web Server <-> Streamer: JSON IPC over stdin/stdout
- Streamer <-> Sunshine: Moonlight protocol (via moonlight-common)
- Streamer <-> Browser: WebRTC (video/audio) or WebSocket fallback

### Transport Layer
The streamer supports two transport modes (`moonlight-web/streamer/src/transport/`):
- **WebRTC**: Primary transport using `webrtc-rs`, handles video (H.264/H.265/AV1), audio (Opus), and input
- **WebSocket**: Fallback transport for restricted networks

### Frontend Structure
TypeScript frontend in `moonlight-web/web-server/web/`:
- `stream/` - Core streaming logic (video/audio pipelines, input handling)
- `component/` - UI components (host list, settings, modals)
- `stream/transport/` - WebRTC and WebSocket client implementations

### Configuration
- Config file: `server/config.json` (created on first run)
- Full config structure: `moonlight-web/common/src/config.rs`
- CLI options override config: `./web-server help`

## Key Files

- `moonlight-web/web-server/src/main.rs` - Web server entry point
- `moonlight-web/streamer/src/main.rs` - Streamer subprocess entry point
- `moonlight-web/common/src/ipc.rs` - IPC protocol between server and streamer
- `moonlight-web/common/src/config.rs` - Configuration schema
- `moonlight-web/common/src/api_bindings.rs` - Shared types (auto-exported to TypeScript)

## Workspace Lints

The workspace enables `clippy::unwrap_used = "warn"` - prefer `expect()` with context or proper error handling over `unwrap()`.
