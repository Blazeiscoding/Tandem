# Build the bundled server + web client, then ship a tiny runtime image.
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @slackoss/web build && pnpm --filter slackoss-server build

FROM node:24-alpine
RUN addgroup -S slackoss && adduser -S slackoss -G slackoss
USER slackoss
WORKDIR /app
COPY --from=build /repo/apps/server-cli/dist ./
VOLUME /data
EXPOSE 8543
# mDNS is pointless inside a container; hosts on a LAN should run the binary directly.
ENTRYPOINT ["node", "slackoss-server.js", "--data", "/data", "--no-mdns"]
