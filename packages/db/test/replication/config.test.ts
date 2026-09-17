// The `[replication]` section and the three CLI flags that write into it. Configuration is the
// one part of replication that fails at start rather than at runtime, so the cases worth pinning
// are the ones that decide a node's role.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "../../src/cli.ts"
import { DEFAULT_CONFIG, envNameFor, loadConfig } from "../../src/server/config.ts"
import { removeTempDir } from "../tmpdir.ts"

describe("[replication] configuration", () => {
  test("a node is a primary with replication off by default", () => {
    const config = loadConfig({ env: {} })
    expect(config.replication).toEqual(DEFAULT_CONFIG.replication)
    expect(config.replication.role).toBe("primary")
    expect(config.replication.secret).toBe("")
  })

  test("setting a primary URL is what makes a node a replica", () => {
    const config = loadConfig({
      env: {},
      overrides: { replication: { primary: "wss://p/v1/replication", secret: "s" } },
    })
    expect(config.replication.role).toBe("replica")
  })

  test("a replica with no primary is refused at start", () => {
    expect(() => loadConfig({ env: {}, overrides: { replication: { role: "replica" } } })).toThrow(
      /needs \[replication\] primary/,
    )
  })

  test("an unknown role is refused", () => {
    expect(() =>
      loadConfig({
        env: {},
        overrides: { replication: { role: "witness" as "primary", primary: "wss://p" } },
      }),
    ).toThrow(/must be "primary" or "replica"/)
  })

  test("canonical and alias environment overrides both work, canonical winning", () => {
    expect(envNameFor("replication", "slowReplicaMs")).toBe("BUNQL_REPLICATION_SLOW_REPLICA_MS")
    const config = loadConfig({
      env: {
        BUNQL_CLUSTER_SECRET: "from-alias",
        BUNQL_REPLICATION_SECRET: "from-canonical",
        BUNQL_REPLICA_OF: "wss://p/v1/replication",
        BUNQL_REPLICATION_HEARTBEAT_MS: "1234",
      },
    })
    expect(config.replication.secret).toBe("from-canonical")
    expect(config.replication.primary).toBe("wss://p/v1/replication")
    expect(config.replication.role).toBe("replica")
    expect(config.replication.heartbeatMs).toBe(1234)
  })

  test("`follow` is a comma-separated list in the environment and never empty", () => {
    const listed = loadConfig({ env: { BUNQL_FOLLOW: "acme, beta ,gamma" } })
    expect(listed.replication.follow).toEqual(["acme", "beta", "gamma"])
    const blanked = loadConfig({ env: {}, overrides: { replication: { follow: [] } } })
    expect(blanked.replication.follow).toEqual(["*"])
  })

  test("a TOML section expands secrets from the environment", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-repl-config-"))
    try {
      const file = path.join(dir, "bunql.toml")
      fs.writeFileSync(
        file,
        '[replication]\nsecret = "${MY_CLUSTER_SECRET}"\nprimary = "wss://p/v1/replication"\n',
      )
      const config = loadConfig({ file, env: { MY_CLUSTER_SECRET: "shhh" } })
      expect(config.replication.secret).toBe("shhh")
      expect(config.replication.role).toBe("replica")
    } finally {
      removeTempDir(dir)
    }
  })
})

describe("serve flags", () => {
  test("the three replication flags parse", () => {
    const args = parseArgs([
      "serve",
      "--replica-of",
      "wss://p/v1/replication",
      "--cluster-secret",
      "s3cret",
      "--follow",
      "acme,beta",
    ])
    expect(args.positional).toEqual(["serve"])
    expect(args.flags["replica-of"]).toBe("wss://p/v1/replication")
    expect(args.flags["cluster-secret"]).toBe("s3cret")
    expect(args.flags.follow).toBe("acme,beta")
  })

  test("a flag beats the environment variable it covers", () => {
    // `serve` clears the variables a flag covers before `loadConfig` applies the environment;
    // this is the same resolution, spelled out.
    const config = loadConfig({
      env: { BUNQL_CLUSTER_SECRET: "from-env" },
      overrides: { replication: { secret: "from-flag" } },
    })
    // Without the suppression the environment would win, which is what `envSuppressions` fixes.
    expect(config.replication.secret).toBe("from-env")
    const suppressed = loadConfig({
      env: { BUNQL_CLUSTER_SECRET: undefined },
      overrides: { replication: { secret: "from-flag" } },
    })
    expect(suppressed.replication.secret).toBe("from-flag")
  })

  test("[replication] logicalChanges is a level, from the file or the environment", () => {
    // P9. The default's type is a boolean, so the generic `BUNQL_*` coercion would read "row" as
    // "not true" and turn the feature off without saying so. Each spelling is pinned here because
    // the failure it prevents is silent: a replica answering 501 for a primary that was configured.
    expect(loadConfig({ env: {} }).replication.logicalChanges).toBe(false)
    expect(
      loadConfig({ env: {}, overrides: { replication: { logicalChanges: true } } }).replication
        .logicalChanges,
    ).toBe("row")
    expect(
      loadConfig({ env: {}, overrides: { replication: { logicalChanges: "pk" } } }).replication
        .logicalChanges,
    ).toBe("pk")
    expect(
      loadConfig({ env: { BUNQL_REPLICATION_LOGICAL_CHANGES: "row+old" } }).replication
        .logicalChanges,
    ).toBe("row+old")
    expect(
      loadConfig({ env: { BUNQL_REPLICATION_LOGICAL_CHANGES: "true" } }).replication.logicalChanges,
    ).toBe("row")
    expect(
      loadConfig({ env: { BUNQL_REPLICATION_LOGICAL_CHANGES: "false" } }).replication
        .logicalChanges,
    ).toBe(false)
    expect(() =>
      loadConfig({ env: { BUNQL_REPLICATION_LOGICAL_CHANGES: "rows" } }),
    ).toThrow("[replication] logicalChanges")
  })
})
