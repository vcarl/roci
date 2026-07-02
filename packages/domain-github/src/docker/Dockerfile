FROM node:20

# Core tools — gh CLI for GitHub operations, git for repo work
RUN apt-get update && apt-get install -y --no-install-recommends \
    git gh jq sudo less procps zsh nano vim \
    iptables ipset iproute2 dnsutils aggregate \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Node user setup
RUN mkdir -p /usr/local/share/npm-global && chown -R node:node /usr/local/share/npm-global
RUN mkdir -p /work /home/node/.claude && chown -R node:node /work /home/node/.claude
WORKDIR /work

USER node
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin
ENV SHELL=/bin/zsh

# Install bun + Claude Code
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/node/.bun/bin:${PATH}"
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Install OpenCode
ARG OPENCODE_VERSION=latest
RUN npm install -g opencode-ai@${OPENCODE_VERSION}

# Pre-seed opencode config for permission bypass
RUN mkdir -p /home/node/.opencode && \
    echo '{"permission":{"*":"allow"}}' > /home/node/.opencode/config.json

# Pre-seed claude config
RUN echo '{"hasCompletedOnboarding":true,"numStartups":1,"projects":{"/work":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}' \
    > /home/node/.claude.json

# Install the Agent SDK frontier-worker runner (Phase 2)
RUN mkdir -p /home/node/sdk-runner
COPY --chown=node:node sdk-runner.mjs sdk-runner-protocol.mjs /home/node/sdk-runner/
COPY --chown=node:node sdk-runner-package.json /home/node/sdk-runner/package.json
RUN cd /home/node/sdk-runner && npm install --omit=dev

# Use iptables-legacy for WSL2 compatibility (nf_tables has limited kernel support)
USER root
RUN update-alternatives --set iptables /usr/sbin/iptables-legacy && \
    update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy
USER node

# Firewall script
COPY init-firewall.sh /usr/local/bin/
USER root
RUN sed -i 's/\r$//' /usr/local/bin/init-firewall.sh && \
    chmod +x /usr/local/bin/init-firewall.sh && \
    echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall && \
    chmod 0440 /etc/sudoers.d/node-firewall
USER node

# Bake the sqlite-vec loadable extension (linux-arm64 0.1.9) used by the
# long-term memory `memory` CLI (bun:sqlite db.loadExtension with the explicit
# sqlite3_vec_init entrypoint). World-readable so USER node can load it.
USER root
COPY vec0.so /usr/local/lib/vec0.so
RUN chmod 0644 /usr/local/lib/vec0.so
USER node
