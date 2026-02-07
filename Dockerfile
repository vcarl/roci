FROM node:22-slim
RUN apt-get update && apt-get install -y bash && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
USER node

# Pre-seed claude config to skip the first-run onboarding wizard
RUN echo '{"hasCompletedOnboarding":true,"numStartups":1}' > /home/node/.claude.json

WORKDIR /work
ENTRYPOINT ["entrypoint.sh"]
