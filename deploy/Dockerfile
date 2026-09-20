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
RUN npm install -g --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}"

FROM node:22-bookworm-slim
ARG DSH_VERSION
LABEL org.opencontainers.image.title="deepseek-harness" \
      org.opencontainers.image.version="${DSH_VERSION}" \
      org.opencontainers.image.source="https://github.com/mirrorcoder/deepseek-harness"
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep procps tini openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-audit --no-fund pnpm@11.7.0
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules
# npm's bin entry is a symlink; COPY would flatten it into a file outside
# node_modules and break package resolution — recreate the link instead.
RUN ln -s /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js /usr/local/bin/dsh
COPY deploy/web-docker.patch.yml /opt/dsh/web-docker.patch.yml
COPY deploy/entrypoint.sh /opt/dsh/entrypoint.sh
RUN chmod +x /opt/dsh/entrypoint.sh && mkdir -p /data /workspace && chown node:node /data /workspace
ENV DSH_HOME=/data/dsh \
    HOME=/data \
    DSH_TELEMETRY_MODE=DISABLED \
    NODE_ENV=production
USER node
WORKDIR /workspace
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/)" = 401 || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/dsh/entrypoint.sh"]
