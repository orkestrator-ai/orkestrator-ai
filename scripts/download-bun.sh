#!/bin/bash
# Download Bun binary for bundling with the app

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/binaries"

# Bun version to download
BUN_VERSION="1.3.6"

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        BUN_ARCH="x64"
        ;;
    arm64|aarch64)
        BUN_ARCH="aarch64"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# Platform
PLATFORM="darwin"

# Download URL
BUN_FILENAME="bun-${PLATFORM}-${BUN_ARCH}"
BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_FILENAME}.zip"

echo "Downloading Bun v${BUN_VERSION} for ${PLATFORM}-${BUN_ARCH}..."

# Create binaries directory if it doesn't exist
mkdir -p "$BINARIES_DIR"

# Download and extract
TEMP_DIR=$(mktemp -d)
curl -fsSL "$BUN_URL" -o "$TEMP_DIR/bun.zip"
unzip -q "$TEMP_DIR/bun.zip" -d "$TEMP_DIR"

# Copy the binary
cp "$TEMP_DIR/${BUN_FILENAME}/bun" "$BINARIES_DIR/bun"
chmod +x "$BINARIES_DIR/bun"

# Cleanup
rm -rf "$TEMP_DIR"

echo "Bun binary downloaded to $BINARIES_DIR/bun"

# Verify it works
"$BINARIES_DIR/bun" --version
