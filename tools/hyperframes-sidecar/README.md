# HyperFrames SFX Sidecar & Node 22 Configuration

This directory contains standalone diagnostics for verifying HyperFrames integration with the application.

## Node.js Isolation & Requirements

The main desktop application runs on **Electron 30 (Node ~20)**.
HyperFrames requires **Node.js >= 22**.

To maintain zero runtime conflicts, the main application **never** bundles or imports HyperFrames packages. Instead, HyperFrames is executed strictly as an **external child process** within an isolated workspace.

## Configuration

If your system's global `node` is version 22 or higher, HyperFrames is auto-detected.

If your system's default `node` is older (e.g. Node 20), specify a Node 22+ binary via environment variables:

```bash
# Set path to Node 22+ binary
export HYPERFRAMES_NODE_BIN=/path/to/node22/bin/node

# Optional: set path to npx if not co-located with node
export HYPERFRAMES_NPX_BIN=/path/to/node22/bin/npx
```

On Windows (PowerShell):
```powershell
$env:HYPERFRAMES_NODE_BIN = "C:\Program Files\nodejs\node.exe"
```

## Zero API & Deterministic Fallback

HyperFrames is entirely **optional**:
- If Node >= 22 or HyperFrames is absent, the application automatically falls back to **Local Procedural FFmpeg Synthesis** (using `ffmpeg-static`).
- Local procedural synthesis produces 48kHz WAV audio with zero external APIs, zero network calls, and zero tokens.
- Production **never** fails due to SFX resolution.

## Verification

Run the doctor script to inspect your environment:

```bash
node tools/hyperframes-sidecar/doctor.mjs
```
