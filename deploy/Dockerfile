# DeepSeek Harness (dsh) — runtime image from the published npm package.
# Fast to build (no TypeScript compile); DSH_VERSION must match the tag the
# fork's `main` is based on so "what runs" == "what you read in the repo".
# For a from-source build of local modifications see Dockerfile.source.
ARG DSH_VERSION=0.1.5-rc.3

FROM node:22-bookworm-slim AS build
ARG DSH_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates cmake \
    && rm -rf /var/lib/apt/lists/*
# Speech to text for Telegram voice notes, built here and shipped as one binary.
# The MODEL is not baked in: the bridge fetches it into $DSH_HOME/models on the
# first voice note, so the image stays small and a deployment that never gets
# voice never pays for it. GGML_NATIVE tunes for the CPU that builds the image,
# which for this repository is the machine that runs it (deploy/update.sh
# builds locally); set it OFF when building an image to run elsewhere.
# OpenMP is off so the binary needs no libgomp at runtime.
ARG WHISPER_VERSION=v1.9.4
ARG WHISPER_NATIVE=ON
RUN git clone --depth 1 --branch "${WHISPER_VERSION}" https://github.com/ggml-org/whisper.cpp /tmp/whisper \
 && cmake -S /tmp/whisper -B /tmp/whisper/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DGGML_OPENMP=OFF -DGGML_NATIVE="${WHISPER_NATIVE}" \
 && cmake --build /tmp/whisper/build --config Release -j"$(nproc)" --target whisper-cli \
 && install -m 0755 /tmp/whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli \
 && rm -rf /tmp/whisper
# Installed through a manifest rather than `npm install -g` so the separately
# published recall tools ride the SAME version line as the app: they are not in
# its dependency closure, and a tool package a minor behind the host is how a
# seam quietly changes shape underneath it.
#
# (History: rc.2 needed an `overrides` block because
# `dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3` had never been published
# and the registry jumped straight to 0.1.6-alpha.1. Upstream has since
# published it, so rc.3 resolves on its own and the override is gone.)
WORKDIR /opt/dsh-runtime
# `dsh-tool-session-query` is published separately and is NOT in the app's
# dependency closure, so it has to be asked for by name, at the app's version.
# It carries the five model-facing tools over the session index — the recall
# path our compaction checkpoints point at.
# The three LSP packages (seam, stdio provider, model tool) are likewise outside
# the closure; dsh-ext-lsp mounts them once install-extensions.sh has put them
# into the profile.
#
# undici ≥ 8.11.2, or web search breaks. Importing npm undici 8 installs its
# Agent as the process-wide dispatcher, and Node 22's built-in fetch (undici 6)
# then reaches it through a legacy wrapper. 8.11.0's Agent negotiates HTTP/2,
# and over HTTP/2 that wrapper handed fetch NO response headers: DeepSeek's
# brotli-compressed search replies were never decompressed ("Unexpected token
# 'e'"), and every header of every built-in fetch over HTTP/2 was lost.
RUN printf '{"name":"dsh-runtime","private":true,"dependencies":{"@deepseek-ai/dsh":"%s","@deepseek-ai/dsh-tool-session-query":"%s","@deepseek-ai/dsh-lsp":"%s","@deepseek-ai/dsh-lsp-stdio":"%s","@deepseek-ai/dsh-tool-lsp":"%s"},"overrides":{"undici":"^8.11.2"}}' "${DSH_VERSION}" "${DSH_VERSION}" "${DSH_VERSION}" "${DSH_VERSION}" "${DSH_VERSION}" > package.json \
 && npm install --no-audit --no-fund
# MCP servers switched on by deploy/features.patch.yml (stdio, launched by dsh).
RUN npm install -g --no-audit --no-fund \
      @modelcontextprotocol/server-memory \
      @upstash/context7-mcp \
      @modelcontextprotocol/server-sequential-thinking

FROM node:22-bookworm-slim
ARG DSH_VERSION
# Identity of THIS fork build: the two facts a committed file cannot carry.
ARG FORK_VERSION=local
ARG FORK_COMMIT=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="deepseek-harness" \
      org.opencontainers.image.version="${FORK_VERSION}" \
      org.opencontainers.image.revision="${FORK_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.base.name="@deepseek-ai/dsh@${DSH_VERSION}" \
      org.opencontainers.image.source="https://github.com/mirrorcoder/deepseek-harness"
# chromium + fonts: dsh-ext-web-shot (screenshot, page_text); DejaVu and
# Liberation cover Cyrillic, without them a Russian page renders as boxes.
# opus-tools: `opusdec` turns a Telegram voice note into the WAV whisper reads.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep procps tini openssh-client jq \
      chromium fonts-dejavu-core fonts-liberation opus-tools \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-audit --no-fund pnpm@11.7.0
# Language servers for dsh-ext-lsp. Installed in this stage, not copied from the
# build stage, so npm lays down the bin links itself.
RUN npm install -g --no-audit --no-fund pyright typescript typescript-language-server
COPY --from=build /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=build /opt/dsh-runtime /opt/dsh-runtime
# npm's bin entries are symlinks; COPY would flatten them into files outside
# node_modules and break package resolution — recreate the links instead.
RUN ln -s /opt/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js /usr/local/bin/dsh \
 && ln -s /usr/local/lib/node_modules/@modelcontextprotocol/server-memory/dist/index.js /usr/local/bin/mcp-server-memory \
 && ln -s /usr/local/lib/node_modules/@upstash/context7-mcp/dist/index.js /usr/local/bin/context7-mcp \
 && ln -s /usr/local/lib/node_modules/@modelcontextprotocol/server-sequential-thinking/dist/index.js /usr/local/bin/mcp-server-sequential-thinking \
 && chmod +x /usr/local/lib/node_modules/@modelcontextprotocol/server-memory/dist/index.js \
             /usr/local/lib/node_modules/@upstash/context7-mcp/dist/index.js \
             /usr/local/lib/node_modules/@modelcontextprotocol/server-sequential-thinking/dist/index.js
# Release stamp of THIS fork (deploy/gen-build-info.sh writes it; /version reads it).
COPY VERSION /opt/dsh/VERSION
COPY deploy/build-info.json /opt/dsh/build-info.json
# Read by dsh-ext-about to show what this fork added and when.
COPY CHANGELOG.md /opt/dsh/CHANGELOG.md
COPY deploy/web-docker.patch.yml /opt/dsh/web-docker.patch.yml
COPY deploy/features.patch.yml /opt/dsh/features.patch.yml
COPY deploy/entrypoint.sh /opt/dsh/entrypoint.sh
COPY deploy/install-extensions.sh /opt/dsh/install-extensions.sh
COPY deploy/preset-pro.mjs /opt/dsh/preset-pro.mjs
COPY deploy/test-runtime-fetch.mjs /opt/dsh/test-runtime-fetch.mjs
# Our out-of-tree plugin bundles; installed into the profile by install-extensions.sh.
COPY extensions/ /opt/dsh/extensions/
RUN chmod +x /opt/dsh/entrypoint.sh /opt/dsh/install-extensions.sh \
 && mkdir -p /data /workspace /run/imggw && chown node:node /data /workspace
ENV DSH_HOME=/data/dsh \
    HOME=/data \
    DSH_TELEMETRY_MODE=DISABLED \
    NODE_ENV=production \
    DSH_FORK_COMMIT=${FORK_COMMIT} \
    DSH_BUILT_AT=${BUILD_DATE}
USER node
WORKDIR /workspace
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/)" = 401 || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/dsh/entrypoint.sh"]
