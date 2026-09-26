# Fly database deployment

The database is deployed as `bql-tm` in the personal Fly organization:

- Endpoint: https://bql-tm.fly.dev
- Region: `sjc`
- One `shared-cpu-1x` Machine, 256 MB RAM
- One encrypted 1 GB `bql_data` volume mounted at `/data`
- Automatic stop when idle; automatic start on requests
- Fly volume snapshots enabled with five-day retention
- Initial database: `myapp`

`Dockerfile` builds the pinned SQLite library in a build stage and copies only
the database server and shared library into the runtime image. Optional GraphQL
dependencies and the bus are not included. `.dockerignore` allows only the
required source files into the remote build context.

On this workstation, connection credentials are in
`~/.config/bql/deployments/bql-tm.env` (mode 0600), outside the repository.
The administrator key is also configured as the Fly secret `BQL_ADMIN_KEY`.

From the repository root:

```sh
source ~/.config/bql/deployments/bql-tm.env
bun run packages/db/src/cli.ts db list
bun run packages/db/src/cli.ts exec myapp --sql 'select 1'
bun run packages/db/src/cli.ts shell myapp
```

Mint scoped tokens for applications instead of distributing the administrator key:

```sh
bun run packages/db/src/cli.ts token --db myapp --scope rw --ttl 30d
```

Deploy changes and inspect status:

```sh
fly deploy --ha=false
fly checks list
fly status
```

This is the minimum single-Machine configuration. Idle compute stops, while volume
storage remains allocated and billable. Requests after an idle stop incur startup
latency. Deployments briefly interrupt service. No database replica or S3 backup
is configured; increasing the Machine count alone does not configure replication.

The Vercel/Cloudflare object-storage mode is a separate proposed design, not a
feature enabled on this deployment.
