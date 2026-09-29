# X5 — Cron schedules on the bus

Item 5 of `docs/plan-ecosystem.md`. A schedule is a row that says what is due next; a fire is an
ordinary publish with a dedupe key. The existing one-second sweep drives it, on the leader only.

## Decisions

- **Parser** (`src/bus/cron.ts`, no dependencies): five fields with `*`, lists, ranges, steps,
  `jan`–`dec` / `sun`–`sat` names, `7` as Sunday, and `@yearly` `@annually` `@monthly` `@weekly`
  `@daily` `@midnight` `@hourly`. `@reboot` is rejected — there is no "boot" for a replicated bus.
  `5/15` reads as "from 5, every 15" (Vixie rejects it; most other crons accept it). Day of month
  vs day of week is the Vixie rule, including its quirk that a field *starting with* `*` (so
  `*/2`) counts as unrestricted. Errors name the field and quote the expression.
- **Time zones through `Intl`**, one cached `DateTimeFormat` per zone, `UTC` short-circuited. The
  search jumps field by field (month, day, hour, minute) on local wall-clock time. DST follows
  Vixie's split between two kinds of job:
  - **Wildcard jobs** — the minute *or* hour field starts with `*` (Vixie's `MIN_STAR|HR_STAR`),
    so `* * * * *`, `*/15 * * * *`, `0 * * * *`, `*/30 1 * * *`, `@hourly` — run on real time.
    The search holds the offset in force at the start; a match whose instant still has that
    offset is the answer, otherwise it restarts at the transition (found by a day scan plus a
    minute binary search) under the new offset. Through a fall back that re-reads the repeated
    hour, so both passes fire; through a spring forward the skipped minutes simply do not exist
    (`30 * * * *` has no 02:30 and no stand-in for it).
  - **Fixed jobs** (`30 1 * * *`) map each local candidate to an instant: two instants (fall back)
    take the earlier, none (spring forward) takes the first instant after the gap. Candidates not
    after `afterMs` are skipped, which collapses a gap into one fire and drops the second pass. A leap-day schedule costs a few dozen steps; 1,000
  `nextFire` calls on a weekday-business-hours expression in New York take ~10 ms.
- **`nextFire` throws for an expression that can never fire** (`0 0 31 2 *`). The search gives up
  nine years out — a leap day is at most eight away. `PUT` computes the first fire before writing,
  so that is a 400 at definition time, not a silent schedule.
- **Migration 9**: `schedules(workspace, name, cron, tz, subject, body, headers, next_at, last_at,
  catch_up, paused, last_error, retry_at, failures, created_at, updated_at)`, primary key `(workspace, name)`, and a
  partial index on `next_at WHERE paused = 0` for the sweep's due query.
- **Firing** (`BusStore.fireSchedules`, kicked off by `sweep()`): skipped unless the store is the
  leader and writable — a follower is read-only, and so is a fenced-out leader. Each due row is
  published with `dedupeKey = schedule:<name>:<fireAtMs>` and headers `schedule-name` and
  `schedule-at` (ISO), and the `next_at` move is a conditional `UPDATE … WHERE next_at = <read
  value> AND paused = 0` in the same transaction as the insert. A row paused, edited or deleted
  while the body was being written is therefore not fired. Overlapping sweeps share one in-flight
  pass rather than racing.
- **`catchUp: "latest"`** finds the most recent slot at or before now by searching widening
  windows (an hour, a day, a month, a year, then from `next_at`), not by stepping from `next_at`,
  so a minutely schedule back from a week down does not walk ten thousand fires.
  **`"none"`** fires only if the slot is at most 60 s late; otherwise it skips to the next slot.
- **Failures stay due, with backoff.** Quota, disk and an enforced schema leave `next_at` alone,
  record `last_error`, count `bql-bus.schedules.failed`, and set `retry_at` (2 s doubling to
  5 min, reset by a success, an edit, pause or resume). With `latest` that is still one fire once
  the cause clears. The due query skips rows inside their backoff, and a pass keeps taking
  batches of 100 until nothing is due — every row a batch touches leaves the due set — so failing
  schedules cannot starve healthy ones by always sorting first on `next_at`.
- **`run`** is charged to the publish rate limit like any publish, and publishes immediately with `schedule-manual: true`, no dedupe key, and does not touch
  `next_at` — a manual fire should neither swallow nor be swallowed by the next scheduled one.
- **Pause clears `next_at`; resume recomputes it from now.** Paused slots are not caught up.
- **Scopes**: `PUT`/`DELETE`/`pause`/`resume` are admin (a schedule is a standing publish with no
  token present when it fires — same reasoning as subscriptions). `GET` is reader. `run` is
  `authorizePublish` on the schedule's subject, so a consumer token with that grant may use it;
  like every publish-grant failure on the bus, a refusal there is a 401, not a 403.
- **Replication**: the follower loop fetches `GET /api/schedules` *before* the log page, and
  mirrors the rows (`applySchedules`, deletions included) only when that page came back short.
  A fire commits its message and its `next_at` move together, so everything the schedule
  snapshot has recorded is in the log read after it — the row can lag the log but never lead it.
  (Reading the log first, as the first cut did, let a fire land between the two reads and leave a
  row claiming a fire whose message never arrived.) The workspace to mirror into comes from the
  upstream's `GET /api/stats` (`workspace`, added for this), not from the list — an empty list
  from a token pinned to a non-default workspace must still delete the replica's copies. A row behind the log is harmless: the promoted node re-derives the same
  dedupe key and gets the replicated message back (`tests/schedules.test.ts` covers exactly that).
  An upstream from before schedules answers 404 and is treated as "nothing to mirror".

## Where the plan was wrong or silent

- **"Repeated times fire once" was wrong for wildcard jobs.** Taken literally it gave a minutely
  job 61 minutes of silence on the fall-back night (and `0 * * * *` a two-hour gap). Vixie fires
  wildcard jobs in both passes and only de-duplicates fixed times; so does this now.

- **Paths.** The plan says `/v1/schedules/:name`; the bus has always been `/api/...` with
  `/api/v1/...` as the versioned alias. Routes are `/api/schedules[/:name[/pause|resume|run]]`,
  reachable at `/api/v1/schedules/...` too.
- **Columns.** Added `last_error`, `created_at`, `updated_at` to the plan's list; the operator needs
  to see why a schedule is not firing without reading logs.
- **"Fires on the primary only"** needed no new machinery: the store already knows its role and
  its fence (`readOnly`), and the check is those two facts.
- **Failover is not literally "cannot double-fire" for `catchUp: "latest"` across a long
  outage.** If the old leader fired slot A, died, and the promoted node comes up after slot B has
  also passed, it fires B — which is correct (B was missed), not a double fire of A. What dedupe
  guarantees is one message per `(schedule, slot)`, and that holds. It lasts as long as the
  message is retained (7 days by default); `next_at` has moved on long before that matters.
- **Dashboard**: a read-only "Schedules" card (name, cron, subject, zone, next fire, last error).
  No actions from the dashboard, which only holds a reader token.
- **Migration 9 was edited in place** (adding `retry_at`, `failures`) while still unreleased; it
  had never shipped, so the append-only rule for migrations was not broken.
- **Concurrent first open.** The follower replication test in `tests/cli-context.test.ts` opens the
  replica database while `bql bus follow` is creating it. Both processes ran the migrations and
  one died on `schema_version`'s primary key (roughly one run in five once migration 9 widened
  the window). `migrate()` now applies each migration in a `BEGIN IMMEDIATE` transaction and
  re-reads the version inside it.
