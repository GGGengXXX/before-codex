FROM ubuntu:22.04

ARG TARGETARCH
ARG NODE_VERSION=20.19.5
ARG NODE_DIST_BASE=https://cdn.npmmirror.com/binaries/node
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG CODEX_PACKAGE=@openai/codex@latest

ENV NODE_ENV=production \
    PORT=8787 \
    HOME=/home/codex

WORKDIR /app

# Install Node.js for the target CPU architecture. Set NODE_DIST_BASE to
# https://nodejs.org/dist to download directly from the official source.
ADD ${NODE_DIST_BASE}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${TARGETARCH}.tar.gz /tmp/node.tar.gz
RUN tar -xzf /tmp/node.tar.gz --strip-components=1 -C /usr/local \
    && node --version \
    && npm --version \
    && npm install --global --registry="${NPM_REGISTRY}" "${CODEX_PACKAGE}" \
    && codex --version \
    && npm cache clean --force \
    && rm /tmp/node.tar.gz \
    && useradd --create-home --shell /bin/bash codex \
    && mkdir /workspace \
    && chown -R codex:codex /app /workspace /home/codex

COPY package*.json ./

COPY --chown=codex:codex src ./src
COPY --chown=codex:codex config.example.json ./config.json
RUN sed -i 's/"host": "127.0.0.1"/"host": "0.0.0.0"/' config.json \
    && chown codex:codex config.json

EXPOSE 8787

USER codex

# Override this command with `codex` to use the bundled Codex CLI.
CMD ["npm", "start"]
