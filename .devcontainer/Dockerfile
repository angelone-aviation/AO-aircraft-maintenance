# Responsibility: The local development container's image: Node with git and
#   the system libraries Playwright's Chromium needs, run as the node user.
# Layer: Config (development only). Neither CI nor production builds it.
# Dependencies: the node:22-bookworm-slim base image and Debian packages.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git openssh-client python3 make g++ \
        libglib2.0-0 libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
        libdbus-1-3 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
        libxrandr2 libgbm1 libxcb1 libxkbcommon0 libasound2 libatspi2.0-0 \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Seed named volumes with directories owned by the development user.
RUN mkdir -p /workspace/node_modules /home/node/.npm \
    && chown -R node:node /workspace /home/node/.npm

USER node
WORKDIR /workspace

# The host's user ID may differ from the container's on bind mounts.
RUN git config --global --add safe.directory /workspace

CMD ["sleep", "infinity"]
