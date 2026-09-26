FROM oven/bun:1.4-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
COPY packages/db/src ./packages/db/src
COPY packages/db/scripts ./packages/db/scripts
RUN bun run packages/db/scripts/sqlite.ts

FROM oven/bun:1.4-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/db/src ./packages/db/src
COPY --from=build /app/packages/db/vendor/sqlite/libsqlite3.so ./packages/db/vendor/sqlite/libsqlite3.so
EXPOSE 4321
STOPSIGNAL SIGTERM
CMD ["bun", "run", "packages/db/src/cli.ts", "serve", "--dir", "/data", "--host", "0.0.0.0", "--port", "4321"]
