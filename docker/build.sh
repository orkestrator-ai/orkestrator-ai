#!/bin/bash
# Build the Claude Orchestrator base image
# Run this script from the docker directory

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="orkestrator-ai"
IMAGE_TAG="latest"

echo "Building ${IMAGE_NAME}:${IMAGE_TAG}..."

docker build \
    --tag "${IMAGE_NAME}:${IMAGE_TAG}" \
    --file Dockerfile \
    .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "To test the image:"
echo "  docker run -it --rm ${IMAGE_NAME}:${IMAGE_TAG}"
