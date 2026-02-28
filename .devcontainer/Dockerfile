FROM ubuntu:24.04

# Install base tools available in every project container
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    shellcheck \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yq (YAML processor)
RUN curl -fsSL https://github.com/mikefarah/yq/releases/download/v4.52.4/yq_linux_amd64 \
    -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq
