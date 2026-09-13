# AgenticBus — one process, one SQLite file, the dashboard baked in.
FROM oven/bun:1.4-slim AS base
WORKDIR /app

FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# The library bundle and the dashboard. `serve` reads the dashboard from
# dist/dashboard, so the image has a UI without a second service.
RUN bun run build
# Drop the build-only tree before it is copied into the runtime layer: the
# dashboard is already compiled and nothing below needs a devDependency.
RUN rm -rf node_modules && bun install --frozen-lockfile --production

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=4317 \
    BUS_STATE=/data \
    BUS_LOG_FORMAT=json \
    # A container has to bind 0.0.0.0 to receive anything at all. The bus
    # itself still defaults to loopback; this is the container saying so
    # explicitly, and the platform terminates TLS in front of it.
    BUS_HOST=0.0.0.0
COPY --from=build /app /app
# The bus spawns nothing, but root in a container is root for anything that
# reaches it. `bun` (uid 1000) already exists in the base image.
RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun
VOLUME ["/data"]
EXPOSE 4317
# SIGTERM drains: claims stop being handed out, parked long polls return,
# in-flight requests finish, and only then is the database closed.
STOPSIGNAL SIGTERM
CMD ["bun", "dist/cli/index.js", "serve"]
