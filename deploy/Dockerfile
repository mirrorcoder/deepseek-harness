# DeepSeek Harness (dsh) — runtime image from the published npm package.
# Fast to build (no TypeScript compile); DSH_VERSION must match the tag the
# fork's `main` is based on so "what runs" == "what you read in the repo".
# For a from-source build of local modifications see Dockerfile.source.
ARG DSH_VERSION=0.1.5-rc.2

FROM node:22-bookworm-slim AS build
ARG DSH_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Installed through a manifest rather than `npm install -g` for one reason: the
# published tree is currently unresolvable. `@deepseek-ai/dsh-web-app@0.1.5-rc.3`
# requires `dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3`, which was never
# published — the registry jumps from rc.2 to 0.1.6-alpha.1 — so a plain install
# of rc.2 fails with ETARGET as soon as npm resolves that sub-dependency to
# rc.3. rc.3 itself fails the same way. The override pins that one package to
# the version that exists; everything else resolves normally. Remove it once
# upstream publishes a consistent tree.
WORKDIR /opt/dsh-runtime
RUN printf '{"name":"dsh-runtime","private":true,"dependencies":{"@deepseek-ai/dsh":"%s"},"overrides":{"@deepseek-ai/dsh-client-ui-sidebar-documentpreview":"0.1.5-rc.2"}}' "${DSH_VERSION}" > package.json \
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
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep procps tini openssh-client jq \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-audit --no-fund pnpm@11.7.0
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
