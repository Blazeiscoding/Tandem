# Build the bundled server + web client, then ship a tiny runtime image.
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
# The image has no .git to ask which source it is (IMP-08); CI passes the
# commit. Declared after installing, so a new commit reuses that step.
ARG GITHUB_SHA=unknown
ENV GITHUB_SHA=${GITHUB_SHA}
RUN pnpm --filter @slackoss/web build && pnpm --filter slackoss-server build

FROM node:24-alpine
RUN addgroup -S slackoss && adduser -S slackoss -G slackoss
RUN mkdir -p /data /app && chown slackoss:slackoss /data /app
USER slackoss
WORKDIR /app
COPY --from=build /repo/apps/server-cli/dist ./
VOLUME /data
EXPOSE 8543
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8543/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# mDNS is pointless inside a container; hosts on a LAN should run the binary directly.
ENTRYPOINT ["node", "slackoss-server.js", "--data", "/data", "--no-mdns"]
