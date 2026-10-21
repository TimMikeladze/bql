import { afterAll, describe, expect, test } from "bun:test";
import { testStore } from "./helpers";
import { CronError, nextFire, parseCron } from "../src/bus/cron";
import { createServer } from "../src/bus/server";
import { BusStore } from "../src/bus/store";
import { generateKey, mint } from "../src/bus/tokens";
import { BusClient, BusRequestError } from "../src/client/bus";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const NY = "America/New_York";

/** `count` consecutive fires after `from`. */
function fires(expr: string, tz: string, from: string, count: number): string[] {
  const out: string[] = [];
  let cursor = at(from);
  for (let index = 0; index < count; index++) {
    cursor = nextFire(expr, tz, cursor);
    out.push(iso(cursor));
  }
  return out;
}

describe("cron parser", () => {
  test("aliases, steps, ranges, lists and names", () => {
    expect(fires("@hourly", "UTC", "2026-01-01T00:10:00Z", 2)).toEqual([
      "2026-01-01T01:00:00.000Z",
      "2026-01-01T02:00:00.000Z",
    ]);
    expect(fires("@weekly", "UTC", "2026-01-01T00:00:00Z", 1)).toEqual([
      "2026-01-04T00:00:00.000Z", // a Sunday
    ]);
    expect(fires("*/20 9-10 * * *", "UTC", "2026-01-01T09:30:00Z", 4)).toEqual([
      "2026-01-01T09:40:00.000Z",
      "2026-01-01T10:00:00.000Z",
      "2026-01-01T10:20:00.000Z",
      "2026-01-01T10:40:00.000Z",
    ]);
    expect(fires("0 12 * JAN,mar MON-wed", "UTC", "2026-01-31T00:00:00Z", 1)).toEqual([
      "2026-03-02T12:00:00.000Z",
    ]);
    // 7 is Sunday too, and `5/15` reads as "from 5, every 15".
    expect(parseCron("0 0 * * 7").dow[0]).toBe(true);
    expect(fires("5/15 0 * * *", "UTC", "2026-01-01T00:00:00Z", 4).at(-1)).toBe(
      "2026-01-01T00:50:00.000Z",
    );
  });

  test("day of month OR day of week when both are restricted (Vixie)", () => {
    // The 13th, or any Friday.
    expect(fires("0 0 13 * fri", "UTC", "2026-02-01T00:00:00Z", 3)).toEqual([
      "2026-02-06T00:00:00.000Z",
      "2026-02-13T00:00:00.000Z",
      "2026-02-20T00:00:00.000Z",
    ]);
    // A `*`-led field makes it an AND again: odd days that are Fridays.
    expect(fires("0 0 */2 * fri", "UTC", "2026-02-01T00:00:00Z", 2)).toEqual([
      "2026-02-13T00:00:00.000Z",
      "2026-02-27T00:00:00.000Z",
    ]);
  });

  test("a leap-day schedule is found without walking the minutes", () => {
    const started = performance.now();
    expect(iso(nextFire("0 0 29 2 *", "UTC", at("2029-03-01T00:00:00Z")))).toBe(
      "2032-02-29T00:00:00.000Z",
    );
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("invalid expressions say what is wrong", () => {
    const bad: [string, RegExp][] = [
      ["* * * *", /expected 5 fields/],
      ["60 * * * *", /minute value 60 is outside 0-59/],
      ["* * * foo *", /month has an invalid value 'foo'/],
      ["5-1 * * * *", /runs backwards/],
      ["*/0 * * * *", /invalid step/],
      ["1,,2 * * * *", /empty list item/],
      ["@reboot", /unknown alias/],
    ];
    for (const [expr, message] of bad) {
      expect(() => parseCron(expr)).toThrow(CronError);
      expect(() => parseCron(expr)).toThrow(message);
    }
    expect(() => nextFire("0 0 31 2 *", "UTC", 0)).toThrow(/never fires/);
  });
});

describe("DST in America/New_York", () => {
  test("spring forward: a skipped time fires once at the first valid minute", () => {
    // 2026-03-08 02:00 EST jumps to 03:00 EDT; 02:30 does not exist.
    expect(fires("30 2 * * *", NY, "2026-03-07T12:00:00Z", 3)).toEqual([
      "2026-03-08T07:00:00.000Z", // 03:00 EDT
      "2026-03-09T06:30:00.000Z", // 02:30 EDT
      "2026-03-10T06:30:00.000Z",
    ]);
    // Every minute in the gap collapses into that one fire.
    expect(fires("*/20 * * * *", NY, "2026-03-08T06:30:00Z", 3)).toEqual([
      "2026-03-08T06:40:00.000Z", // 01:40 EST
      "2026-03-08T07:00:00.000Z", // 03:00 EDT, once
      "2026-03-08T07:20:00.000Z",
    ]);
  });

  test("fall back: a fixed time fires once, at its first occurrence", () => {
    // 2026-11-01 02:00 EDT falls back to 01:00 EST; 01:30 happens twice.
    expect(fires("30 1 * * *", NY, "2026-10-31T12:00:00Z", 2)).toEqual([
      "2026-11-01T05:30:00.000Z", // 01:30 EDT
      "2026-11-02T06:30:00.000Z", // next day, 01:30 EST
    ]);
  });

  test("fall back: a wildcard job runs on real time through both passes (Vixie)", () => {
    // The repeated hour must not be 61 minutes of silence for a minutely job.
    expect(fires("* * * * *", NY, "2026-11-01T05:58:00Z", 3)).toEqual([
      "2026-11-01T05:59:00.000Z", // 01:59 EDT
      "2026-11-01T06:00:00.000Z", // 01:00 EST
      "2026-11-01T06:01:00.000Z",
    ]);
    expect(fires("*/15 * * * *", NY, "2026-11-01T05:30:00Z", 3)).toEqual([
      "2026-11-01T05:45:00.000Z",
      "2026-11-01T06:00:00.000Z",
      "2026-11-01T06:15:00.000Z",
    ]);
    expect(fires("0 * * * *", NY, "2026-11-01T04:30:00Z", 3)).toEqual([
      "2026-11-01T05:00:00.000Z", // 01:00 EDT
      "2026-11-01T06:00:00.000Z", // 01:00 EST
      "2026-11-01T07:00:00.000Z", // 02:00 EST
    ]);
    // A star in the minute field alone is enough.
    expect(fires("*/30 1 * * *", NY, "2026-11-01T04:30:00Z", 4)).toEqual([
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:00:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ]);
  });

  test("spring forward: a wildcard job skips the minutes that do not exist", () => {
    expect(fires("30 * * * *", NY, "2026-03-08T06:00:00Z", 2)).toEqual([
      "2026-03-08T06:30:00.000Z", // 01:30 EST
      "2026-03-08T07:30:00.000Z", // 03:30 EDT — no 02:30, and no stand-in for it
    ]);
  });
});

describe("store", () => {
  let clock = at("2026-01-01T00:00:30Z");
  const bus = () => testStore({ now: () => clock });
  const W = "default";
  const fired = (store: BusStore) =>
    store.log(W, 0, 100, { subject: "tick" });

  test("the sweep fires once, and a second sweep finds nothing due", async () => {
    clock = at("2026-01-01T00:00:30Z");
    const store = bus();
    const schedule = store.upsertSchedule(W, {
      name: "tick",
      cron: "* * * * *",
      subject: "tick",
      body: { hello: "world" },
      headers: { team: "ops" },
    });
    expect(schedule.nextAt).toBe(at("2026-01-01T00:01:00Z"));
    expect(schedule.catchUp).toBe("latest");

    expect(await store.fireSchedules()).toBe(0);
    clock = at("2026-01-01T00:01:00.400Z");
    expect(await store.fireSchedules()).toBe(1);
    store.sweep();
    expect(await store.fireSchedules()).toBe(0);

    const messages = await fired(store);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toEqual({ hello: "world" });
    expect(messages[0]!.headers["schedule-name"]).toBe("tick");
    expect(messages[0]!.headers["schedule-at"]).toBe("2026-01-01T00:01:00.000Z");
    expect(messages[0]!.headers.team).toBe("ops");
    expect(messages[0]!.dedupeKey).toBe(`schedule:tick:${at("2026-01-01T00:01:00Z")}`);
    expect(store.schedule(W, "tick")).toMatchObject({
      lastAt: at("2026-01-01T00:01:00Z"),
      nextAt: at("2026-01-01T00:02:00Z"),
    });
    store.close();
  });

  test("after downtime, catchUp latest fires once for the most recent slot; none fires nothing", async () => {
    clock = at("2026-01-01T00:00:30Z");
    const store = bus();
    store.upsertSchedule(W, { name: "tick", cron: "* * * * *", subject: "tick" });
    store.upsertSchedule(W, {
      name: "quiet",
      cron: "* * * * *",
      subject: "quiet",
      catchUp: "none",
    });
    // Down for a week.
    clock = at("2026-01-08T00:00:30Z");
    expect(await store.fireSchedules()).toBe(1);
    const messages = await fired(store);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.headers["schedule-at"]).toBe("2026-01-08T00:00:00.000Z");
    expect(await store.log(W, 0, 100, { subject: "quiet" })).toHaveLength(0);
    expect(store.schedule(W, "quiet").nextAt).toBe(at("2026-01-08T00:01:00Z"));
    // Back on cadence, `none` fires normally.
    clock = at("2026-01-08T00:01:02Z");
    expect(await store.fireSchedules()).toBe(2);
    store.close();
  });

  test("a paused schedule does not fire, and resuming does not catch up", async () => {
    clock = at("2026-01-01T00:00:30Z");
    const store = bus();
    store.upsertSchedule(W, { name: "tick", cron: "* * * * *", subject: "tick" });
    expect(store.pauseSchedule(W, "tick", true)).toMatchObject({
      paused: true,
      nextAt: null,
    });
    clock = at("2026-01-01T00:05:30Z");
    expect(await store.fireSchedules()).toBe(0);
    expect(store.pauseSchedule(W, "tick", false).nextAt).toBe(
      at("2026-01-01T00:06:00Z"),
    );
    expect(await store.fireSchedules()).toBe(0);
    expect(await fired(store)).toHaveLength(0);
    store.close();
  });

  test("bad definitions are 400s", () => {
    const store = bus();
    const attempt = (patch: Record<string, unknown>) => {
      try {
        store.upsertSchedule(W, {
          name: "x",
          cron: "* * * * *",
          subject: "tick",
          ...patch,
        });
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };
    expect(attempt({ cron: "61 * * * *" })).toBe(400);
    expect(attempt({ cron: "0 0 31 2 *" })).toBe(400);
    expect(attempt({ tz: "Mars/Olympus" })).toBe(400);
    expect(attempt({ name: "has:colon" })).toBe(400);
    expect(attempt({ catchUp: "all" })).toBe(400);
    store.close();
  });

  test("failing schedules back off and cannot starve a healthy one", async () => {
    clock = at("2026-01-01T00:00:30Z");
    const store = bus();
    // An enforced schema every `bad.*` body violates: those fires always fail.
    store.registerSchema(W, "strict", { type: "object", required: ["id"] }, "none");
    store.bindSchema(W, "bad.>", "strict", "enforce");
    for (let index = 0; index < 120; index++)
      store.upsertSchedule(W, { name: `bad-${index}`, cron: "* * * * *", subject: "bad.tick" });
    store.upsertSchedule(W, { name: "good", cron: "0 * * * *", subject: "tick" });

    clock = at("2026-01-01T00:01:05Z");
    expect(await store.fireSchedules()).toBe(0);
    const failing = store.schedule(W, "bad-0");
    expect(failing.lastError).toMatch(/schema/);
    expect(failing.retryAt).toBe(clock + 2000);
    // Inside the backoff it is not retried.
    clock += 1000;
    await store.fireSchedules();
    expect(store.schedule(W, "bad-0").retryAt).toBe(clock + 1000);

    // An hour on, 120 rows still sort ahead of `good` by `next_at`.
    clock = at("2026-01-01T01:00:05Z");
    expect(await store.fireSchedules()).toBe(1);
    expect(await fired(store)).toHaveLength(1);
    expect(store.schedule(W, "bad-0").retryAt).toBe(clock + 4000);
    store.close();
  });

  test("a replica never fires; the node that becomes primary does, once", async () => {
    clock = at("2026-01-01T00:00:30Z");
    const store = bus();
    store.upsertSchedule(W, { name: "tick", cron: "* * * * *", subject: "tick" });
    store.becomeReplica();
    clock = at("2026-01-01T00:01:10Z");
    expect(await store.fireSchedules()).toBe(0);
    store.becomePrimary();
    expect(await store.fireSchedules()).toBe(1);
    expect(await store.fireSchedules()).toBe(0);
    expect(await fired(store)).toHaveLength(1);
    expect(store.schedule(W, "tick").nextAt).toBe(at("2026-01-01T00:02:00Z"));
    store.close();
  });
});

describe("HTTP", () => {
  const signingKey = generateKey();
  const adminToken = generateKey();
  const store = testStore();
  const server = createServer({
    store,
    signingKey,
    adminToken,
    port: 0,
    hostname: "127.0.0.1",
  });
  const url = `http://127.0.0.1:${server.port}`;
  const admin = new BusClient({ url, token: adminToken });
  const as = (scope: "consumer" | "reader", publish: string[] = []) =>
    new BusClient({
      url,
      token: mint(
        { sub: `${scope}-1`, scope, workspace: "default", publish, subscribe: [], exp: 0 },
        signingKey,
      ),
    });
  const status = (promise: Promise<unknown>) =>
    promise.then(
      () => 200,
      (error: unknown) => (error instanceof BusRequestError ? error.status : -1),
    );

  afterAll(() => {
    server.stop(true);
    store.close();
  });

  test("put, get, list, pause, resume, run, delete", async () => {
    const created = await admin.putSchedule({
      name: "nightly",
      cron: "30 2 * * *",
      tz: NY,
      subject: "reports.nightly",
      body: { kind: "daily" },
    });
    expect(created).toMatchObject({ name: "nightly", tz: NY, paused: false });
    expect(created.nextAt).toBeGreaterThan(Date.now());
    expect((await admin.schedules()).map((s) => s.name)).toEqual(["nightly"]);
    expect((await admin.schedule("nightly")).body).toEqual({ kind: "daily" });

    expect((await admin.pauseSchedule("nightly")).paused).toBe(true);
    expect((await admin.resumeSchedule("nightly")).nextAt).toBe(created.nextAt);

    const run = await admin.runSchedule("nightly");
    const message = await admin.message(run.seq);
    expect(message.headers["schedule-name"]).toBe("nightly");
    expect(message.headers["schedule-manual"]).toBe("true");
    expect((await admin.schedule("nightly")).nextAt).toBe(created.nextAt);

    // Also reachable under the explicit wire version.
    const raw = await fetch(`${url}/api/v1/schedules/nightly`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(raw.status).toBe(200);

    expect(await admin.deleteSchedule("nightly")).toEqual({ deleted: "nightly" });
    expect(await status(admin.schedule("nightly"))).toBe(404);
  });

  test("validation errors are 400", async () => {
    expect(
      await status(admin.putSchedule({ name: "bad", cron: "nope", subject: "a" })),
    ).toBe(400);
    expect(
      await status(
        admin.putSchedule({ name: "bad", cron: "@daily", subject: "a", tz: "Nowhere/Nope" }),
      ),
    ).toBe(400);
  });

  test("scopes: readers read, only admins define, publishers may run", async () => {
    await admin.putSchedule({ name: "ping", cron: "@hourly", subject: "ping.now" });
    const reader = as("reader");
    const consumer = as("consumer", ["ping.>"]);
    const stranger = as("consumer", ["other.>"]);

    expect(await status(reader.schedules())).toBe(200);
    expect(await status(consumer.schedules())).toBe(403);
    expect(
      await status(consumer.putSchedule({ name: "mine", cron: "@daily", subject: "ping.x" })),
    ).toBe(403);
    expect(await status(reader.pauseSchedule("ping"))).toBe(403);
    expect(await status(consumer.deleteSchedule("ping"))).toBe(403);

    expect(await status(consumer.runSchedule("ping"))).toBe(200);
    // A publish grant failure is a 401 everywhere on the bus, `/publish` included.
    expect(await status(stranger.runSchedule("ping"))).toBe(401);
    expect(await status(reader.runSchedule("ping"))).toBe(401);
  });

  test("a workspace-pinned token sees only its own schedules", async () => {
    await admin.putSchedule({ name: "ours", cron: "@daily", subject: "a.b" });
    const elsewhere = new BusClient({
      url,
      token: mint(
        { sub: "r", scope: "reader", workspace: "other", publish: [], subscribe: [], exp: 0 },
        signingKey,
      ),
    });
    expect(await elsewhere.schedules()).toEqual([]);
    expect(await status(elsewhere.schedule("ours"))).toBe(404);
  });
});

describe("limits", () => {
  const signingKey = generateKey();
  const adminToken = generateKey();
  let clock = at("2026-01-01T00:00:30Z");
  const leader = testStore({ now: () => clock });
  const server = createServer({
    store: leader,
    signingKey,
    adminToken,
    port: 0,
    hostname: "127.0.0.1",
    publishRate: { perSecond: 0.001, burst: 1 },
  });
  const url = `http://127.0.0.1:${server.port}`;

  afterAll(() => {
    server.stop(true);
    leader.close();
  });

  test("running a schedule is charged to the publish rate limit", async () => {
    leader.upsertSchedule("default", { name: "limited", cron: "@daily", subject: "x.y" });
    const admin = new BusClient({ url, token: adminToken });
    await admin.runSchedule("limited");
    const second = await admin.runSchedule("limited").then(
      () => 200,
      (error: unknown) => (error instanceof BusRequestError ? error.status : -1),
    );
    expect(second).toBe(429);
  });
});
