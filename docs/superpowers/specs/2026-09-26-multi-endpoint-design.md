# Multi-endpoint CLI design

## Intent and agreed scope

Make BQL convenient to operate across multiple organizations, projects, and deployed
endpoints, inspired by Vercel's CLI. A linked checkout should select its project;
operators and CI should be able to override that context explicitly. Protected
Vercel deployments must be usable without disabling deployment protection.

The user selected a local organization/project registry with linked checkouts.
Organizations are local connection namespaces for independently deployed BQL servers,
not server-enforced security boundaries. Accounts, membership, and a hosted control
plane are outside this agreed scope.

## Alternatives

1. Flat endpoint profiles: simple, but lacks the requested organization/project model.
2. Local organization/project registry and checkout links: recommended for managing
   existing deployments. Each endpoint keeps its existing BQL authorization.
3. Hosted organization control plane: shared identity, membership, project discovery,
   invitations, roles, and endpoint credentials. Useful for a hosted multi-user product,
   but requires a separate authoritative service and authentication lifecycle.

## Model

An organization owns projects. A project owns named endpoints (for example development,
preview, production, or a named branch) and an explicit default endpoint. Each endpoint
has a database URL, optional bus URL, and separate credentials for each service. Optional
Vercel protection-bypass credentials belong to the individual service URL.

Names are unique inside their parent, validated as nonempty slugs, and stored in a
versioned registry. Project selection always includes its organization; identical project
names across organizations never trigger an arbitrary match.

Records have stable generated IDs and mutable display names. Links and credential keys
use IDs so renaming an organization, project, or endpoint preserves existing checkouts.
Slugs accept ASCII letters, digits, `_`, and `-`, beginning with a letter or digit.

## Command contract

```sh
bql org add personal
bql org list
bql switch personal
bql project add app
bql project list --org personal
bql endpoint add preview --org personal --project app --url https://example.vercel.app --token-env APP_PREVIEW_TOKEN --vercel-bypass-env APP_PREVIEW_BYPASS
bql endpoint list --org personal --project app
bql link --org personal --project app --endpoint preview
bql context
bql db list
bql db list --endpoint production
bql exec app --org personal --project app --endpoint preview --sql 'SELECT 1'
bql unlink
```

Management groups support inspect, update, and remove with JSON output. Removal of a
nonempty parent requires explicit recursive intent; removing registry entries never
deletes remote databases. References to deleted selections fail with actionable errors.
`endpoint use` sets the linked checkout's endpoint, or the project's default if explicitly
requested. `context` reports the resolved organization, project, endpoint, URLs, and
selection source, with no credentials. `link` supports terminal selection and a fully
specified noninteractive form; ambiguous noninteractive inputs fail rather than guess.

`update <name> --name <new-name>` renames any registry record. Endpoint updates also
accept connection options; replacing a URL clears its stored credentials unless new
credential options are supplied in the same operation. `remove <name> --recursive`
is required for nonempty organizations/projects. `endpoint use <name> --default` sets
the project default; without `--default` it requires and updates a checkout link.
`switch <org>` changes global organization selection and clears the global project
selection; `project use <name>` sets that organization's global project selection.
Neither command changes an existing checkout link. A newly added endpoint becomes
the project default only when it is the first endpoint.

Use `--org`, not Vercel's `--scope`: BQL already uses `--scope ro|rw` for token minting.
Use `--cwd` for the context lookup directory and `--config-dir` / `BQL_CONFIG_DIR` for
isolated global configuration in CI and tests. Existing `--config` remains server TOML.

## Storage and resolution

Global registry lives under the user's config directory. Stored secrets, if provided
through a hidden interactive prompt, live in a separate owner-only credentials file.
Environment-variable references are supported so CI need not persist credentials.
Writes are atomic and concurrent updates are serialized; malformed or unsupported
versions fail without overwriting the original file.

Default directory: `$XDG_CONFIG_HOME/bql` when set, otherwise `~/.config/bql`.
Registry is `config.json`; secrets are `credentials.json` (mode 0600), with mode 0700
on newly created config directories. A directory lock serializes mutations, with a
bounded timeout and an actionable error for stale locks; no automatic unsafe lock
stealing. Each file replacement uses a same-directory temporary file and rename.
Credential changes are written before registry references; interruption may leave
unreferenced credentials, but never silently pair a new endpoint with an old secret.
Registry removal precedes credential cleanup for the same reason.

`.bql/project.json` stores only organization, project, and endpoint identifiers. Link
lookup walks parent directories for commands invoked in a project subdirectory.
Linking adds `.bql/` to the checkout's ignore rules without replacing existing rules.

Selection precedence is explicit flags, BQL selection environment variables, nearest
checkout link, then global selection/project default. An explicit organization or
project override cannot retain incompatible identifiers from a lower-precedence link.
No configured context preserves the existing localhost behavior. A broken or incomplete
configured context fails rather than silently targeting localhost.

Direct `--url` / `BQL_URL` retains legacy operation. A direct URL does not inherit saved
credentials from a selected endpoint. Explicit credential flags/environment variables
remain available. Tests must cover explicit selection mixed with legacy variables and
document exactly which source wins. Connection mode is selected in this order:

1. Explicit `--url`: direct mode. Combining it with explicit `--org`, `--project`, or
   `--endpoint` is an error rather than an ambiguous mix.
2. Any explicit selection flag: named mode, ignoring legacy URL and credential variables.
3. `BQL_ORG`, `BQL_PROJECT`, or `BQL_ENDPOINT`: named mode.
4. `BQL_URL` (or `BUS_URL` for bus commands): direct legacy mode.
5. Checkout link, then global selection: named mode.
6. No context: unchanged legacy localhost behavior.

In named mode, credentials come from the selected endpoint's stored secret or explicit
environment-variable reference. Database `--token` and `--vercel-bypass` can override
them for that invocation. Ambient `BQL_TOKEN`/`BQL_ADMIN_KEY` and `BUS_TOKEN` do not
override named credentials. In direct legacy mode the existing token precedence remains;
`BQL_VERCEL_BYPASS` supplies the database bypass header. Bus uses `BUS_VERCEL_BYPASS`.
Missing environment references fail before network access and name only the variable.
Secrets are never included in context/list/inspect output or errors. URL validation
rejects embedded credentials, queries, and fragments, and accepts only HTTP(S) service
bases. Redirects on authenticated CLI requests fail instead of forwarding credentials.

## Transport integration

Database remote commands use a single resolved connection passed to the existing SDK.
Vercel bypass becomes `x-vercel-protection-bypass` in HTTP requests. The CLI's WebSocket
factory must carry the same protection header for endpoints that support sockets;
cloud deployments still do not support interactive SQL sessions.

Bus remote commands resolve the selected endpoint's bus connection and preserve legacy
BUS_URL/BUS_TOKEN behavior when no endpoint is selected. Missing bus configuration
fails explicitly instead of using database credentials or accidentally creating local
bus secrets. Local serve, key-management, and storage-init commands do not require
a saved remote context.

The portable SDK remains explicitly configured: it does not read a workstation's
registry or filesystem. Export a Bun-facing resolver as `bql.sh/context` returning
resolved connection options for scripts, with explicit cwd/config-dir/environment
inputs for testability. Its return value includes credentials for constructing clients;
only the dedicated redacted view may be used for CLI output.

## Verification requirements

- Unit tests: registry validation, atomic updates, permissions, concurrent changes,
  environment references, redaction, nested project lookup, and precedence matrix.
- CLI subprocess tests: full organization/project/endpoint lifecycle, linked and
  unlinked directories, noninteractive errors, JSON output, and stale references.
- Two independent database servers: create/query distinct data through named endpoints;
  verify switching never sends credentials or requests to the other server.
- Protected proxy fixture: verify bypass plus BQL auth, failure without bypass, and
  no credential inheritance when overriding URLs. Cover socket handshake headers.
- Bus fixture: selected bus URL and credentials, missing configuration, legacy behavior.
- Existing database CLI, client, cloud CLI, and bus tests plus typechecking.
- README and CLI help show setup, switching, CI, credentials, protected Vercel access,
  migration from environment-only configuration, and uninstalling a local link.

## Reference behavior

- https://vercel.com/docs/cli/link — directory-to-project linking.
- https://vercel.com/docs/cli/switch — changing team context.
- https://vercel.com/docs/cli — project, team, and target command families.

The user approved this design on 2026-09-26. Implementation and verification are complete;
see the completion evidence in `../plans/2026-09-26-multi-endpoint.md`.
