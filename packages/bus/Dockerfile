# bql.sh/bus: one process, database `bus` on bql.sh under /data, the dashboard baked in.
#
# Build from the repository root, not from packages/bus: the bus runs on bql.sh's FFI driver, and
# the driver and the libsqlite3 it loads come from packages/db.
#
#   docker build -f packages/bus/Dockerfile -t bql-bus .
FROM oven/bun:1.4-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# The pinned libsqlite3, the same way the bql.sh image builds it. The slim base has no SQLite of
# its own, and a distribution one lacks the flags the driver checks for. It lands in
# packages/db/vendor/sqlite, which the driver searches relative to its own source, so the runtime
# needs no BQL_SQLITE_LIB.
COPY package.json ./
COPY packages/db/src ./packages/db/src
COPY packages/db/scripts ./packages/db/scripts
RUN bun run packages/db/scripts/sqlite.ts
# The dashboard. `serve` reads it from dist/dashboard, so the image has a UI without a second
# service. Every workspace manifest has to be present for the lockfile to stay frozen.
COPY bun.lock tsconfig.base.json ./
COPY packages/db/package.json ./packages/db/package.json
COPY site/package.json ./site/package.json
COPY packages/bus ./packages/bus
RUN bun install --frozen-lockfile --filter bql-bus
RUN cd packages/bus && bun run build:dashboard

FROM oven/bun:1.4-slim AS runtime
ENV NODE_ENV=production \
    PORT=4317 \
    BUS_DATA=/data \
    BUS_LOG_FORMAT=json \
    # A container has to bind 0.0.0.0 to receive anything at all. The bus
    # itself still defaults to loopback; this is the container saying so
    # explicitly, and the platform terminates TLS in front of it.
    BUS_HOST=0.0.0.0
# TypeScript source, as the npm package ships it. Nothing here needs node_modules: the server has
# no runtime dependencies and the dashboard is already compiled.
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/packages/db/src /app/packages/db/src
COPY --from=build /app/packages/db/vendor/sqlite/libsqlite3.so /app/packages/db/vendor/sqlite/libsqlite3.so
COPY --from=build /app/packages/bus/package.json /app/packages/bus/package.json
COPY --from=build /app/packages/bus/src /app/packages/bus/src
COPY --from=build /app/packages/bus/dist/dashboard /app/packages/bus/dist/dashboard
WORKDIR /app/packages/bus
# The bus spawns nothing, but root in a container is root for anything that
# reaches it. `bun` (uid 1000) already exists in the base image.
RUN mkdir -p /data && chown -R bun:bun /data
USER bun
VOLUME ["/data"]
EXPOSE 4317
# SIGTERM drains: claims stop being handed out, parked long polls return,
# in-flight requests finish, and only then is the database closed.
STOPSIGNAL SIGTERM
CMD ["bun", "src/cli/index.ts", "serve"]
