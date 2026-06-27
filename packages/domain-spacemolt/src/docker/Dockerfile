FROM node:20

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=latest

# Install basic development tools and iptables/ipset
RUN apt-get update && apt-get install -y --no-install-recommends \
    less \
    git \
    procps \
    sudo \
    fzf \
    zsh \
    man-db \
    unzip \
    gnupg2 \
    gh \
    iptables \
    ipset \
    iproute2 \
    dnsutils \
    aggregate \
    jq \
    python3 \
    nano \
    vim \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Ensure default node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
    chown -R node:node /usr/local/share

ARG USERNAME=node

# Persist bash history.
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
    && mkdir /commandhistory \
    && touch /commandhistory/.bash_history \
    && chown -R $USERNAME /commandhistory

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true

# Create workspace and config directories and set permissions
RUN mkdir -p /work /home/node/.claude && \
    chown -R node:node /work /home/node/.claude

WORKDIR /work

ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
    wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
    sudo dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
    rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# Set up non-root user
USER node

# Install global packages
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Set the default shell to zsh rather than sh
ENV SHELL=/bin/zsh

# Set the default editor and visual
ENV EDITOR=nano
ENV VISUAL=nano

# Default powerline10k theme
ARG ZSH_IN_DOCKER_VERSION=1.2.0
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh)" -- \
    -p git \
    -p fzf \
    -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
    -a "source /usr/share/doc/fzf/examples/completion.zsh" \
    -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
    -x

# Install bun (for TypeScript harness)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/node/.bun/bin:${PATH}"

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Install OpenCode
ARG OPENCODE_VERSION=latest
RUN npm install -g opencode-ai@${OPENCODE_VERSION}

# Install the pinned, unpublished SpaceMolt client-v2 CLI (`spacemolt` bin) from a
# VENDORED tarball. This build (@spacemolt/client-v2, ws variant b1facd8) is NOT on
# npm, so it is committed into the docker build context and installed from disk.
# Still USER node with NPM_CONFIG_PREFIX=/usr/local/share/npm-global in effect, so
# the bin lands on PATH at /usr/local/share/npm-global/bin.
COPY --chown=node:node spacemolt-client-v2-ws-b1facd8-20260627150735.tgz /tmp/spacemolt-client-v2.tgz
RUN npm install -g /tmp/spacemolt-client-v2.tgz && rm /tmp/spacemolt-client-v2.tgz
# Verify the bin is on PATH WITHOUT hitting the network (`spacemolt --version` calls
# the game API, so use a PATH lookup instead).
RUN command -v spacemolt

# Config for the `spacemolt` CLI. SPACEMOLT_URL is kept in sync with
# SPACEMOLT_URL_DEFAULT in src/session.ts. SPACEMOLT_SESSION is a RELATIVE path:
# the harness runs every in-game command with cwd /work/players/<name>, so this
# resolves to that player's /work/players/<name>/me/.spacemolt-session.json for
# every player without any per-exec env injection (containers are shared).
ENV SPACEMOLT_URL=https://game.spacemolt.com/api/v2
ENV SPACEMOLT_SESSION=me/.spacemolt-session.json

# The container firewall blocks https://models.dev/api.json; without these, opencode
# hangs at startup fetching its model registry instead of falling back to the
# configured local provider. Defense-in-depth — the harness also injects these at
# docker-exec time, but this protects any opencode invocation inside the container.
ENV OPENCODE_DISABLE_MODELS_FETCH=1
ENV OPENCODE_DISABLE_AUTOUPDATE=1

# Pre-seed opencode config for permission bypass
RUN mkdir -p /home/node/.opencode && \
    echo '{"permission":{"*":"allow"}}' > /home/node/.opencode/config.json

# Pre-seed claude config to skip onboarding and trust /work
RUN echo '{"hasCompletedOnboarding":true,"numStartups":1,"projects":{"/work":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}' \
    > /home/node/.claude.json

# Install the Agent SDK frontier-worker runner (Phase 2)
RUN mkdir -p /home/node/sdk-runner
COPY --chown=node:node sdk-runner.mjs sdk-runner-protocol.mjs /home/node/sdk-runner/
COPY --chown=node:node sdk-runner-package.json /home/node/sdk-runner/package.json
RUN cd /home/node/sdk-runner && npm install --omit=dev

# Enable channels + activity logging hooks (user-level so they apply to subagents too).
# All tool calls and subagent lifecycle events append to logs/activity.log (relative to cwd).
COPY --chown=node:node claude-settings.json /home/node/.claude/settings.json

# Use iptables-legacy for WSL2 compatibility (nf_tables has limited kernel support)
USER root
RUN update-alternatives --set iptables /usr/sbin/iptables-legacy && \
    update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy
USER node

# Copy firewall script (must be in image for sudoers trust)
COPY init-firewall.sh /usr/local/bin/
USER root
RUN sed -i 's/\r$//' /usr/local/bin/init-firewall.sh && \
    chmod +x /usr/local/bin/init-firewall.sh && \
    echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall && \
    chmod 0440 /etc/sudoers.d/node-firewall
USER node

# Install roci channel server and its dependencies
RUN mkdir -p /work/bin
COPY --chown=node:node channel-package.json /work/bin/package.json
RUN cd /work/bin && bun install
COPY --chown=node:node roci-channel.ts /work/bin/roci-channel.ts
