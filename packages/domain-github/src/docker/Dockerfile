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

# Pre-seed claude config
RUN echo '{"hasCompletedOnboarding":true,"numStartups":1,"projects":{"/work":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}' \
    > /home/node/.claude.json

# Firewall script
COPY init-firewall.sh /usr/local/bin/
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh && \
    echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall && \
    chmod 0440 /etc/sudoers.d/node-firewall
USER node
