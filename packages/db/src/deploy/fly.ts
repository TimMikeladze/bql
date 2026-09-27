import { nativeArray, type DriverContext } from "./driver.ts"

interface FlyApp { Name: string; Organization?: { Slug?: string } }
interface FlyVolume { id: string; name: string; region: string }

/** One owned app and disk. There is deliberately no deletion/rollback command. */
export async function deployFly(context: DriverContext): Promise<string> {
  const { config, journal, runner, appDir, release } = context
  const appArgs = ["--app", config.name]
  const call = (args: string[], input?: string) => runner({ executable: "fly", args, cwd: appDir, ...(input === undefined ? {} : { input }), env: { NO_COLOR: "1" } })
  const listApps = async () => nativeArray<FlyApp>((await call(["apps", "list", "--json"])).stdout, "fly apps list")
  await journal.step("app", async () => {
    const found = (await listApps()).find(app => app.Name === config.name)
    if (found) {
      if (journal.state.resources.app !== config.name) throw new Error(`Fly app ${config.name} already exists and is not owned by this deployment. No changes made; use a different deployment name`)
      if (found.Organization?.Slug !== (journal.state.scope ?? config.scope ?? "personal")) throw new Error("Owned Fly app has moved to a different organization")
      return
    }
    if (journal.state.resources.app) throw new Error("The recorded Fly app is missing; refusing to create a replacement database")
    await call(["apps", "create", config.name, "--org", journal.state.scope ?? config.scope ?? "personal", "--json", "--yes"])
    await journal.recordResource("app", config.name)
  })
  await journal.step("volume", async () => {
    const volumes = nativeArray<FlyVolume>((await call(["volumes", "list", ...appArgs, "--json"])).stdout, "fly volumes list")
    const matching = volumes.filter(volume => volume.name === "bql_data")
    if (matching.length > 1) throw new Error("Multiple bql_data volumes exist; refusing to choose a database disk")
    let volume = matching[0]
    if (!volume) {
      if (journal.state.resources.volume) throw new Error("The recorded Fly volume is missing; recover its data before applying")
      await call(["volumes", "create", "bql_data", ...appArgs, "--region", config.region, "--size", "1", "--yes", "--json"])
      const created = nativeArray<FlyVolume>((await call(["volumes", "list", ...appArgs, "--json"])).stdout, "fly volumes list").filter(volume => volume.name === "bql_data")
      if (created.length !== 1) throw new Error("Cannot identify the created Fly volume; inspect provider status before retrying")
      volume = created[0]!
    }
    if (volume.region !== config.region || typeof volume.id !== "string") throw new Error("Fly volume does not match the planned region")
    await journal.recordResource("volume", volume.id)
  })
  // A completed checkpoint is history, not proof the disk still exists today.
  // In particular, never let `fly deploy --yes` replace a missing database volume.
  const currentApp = (await listApps()).find(app => app.Name === journal.state.resources.app)
  if (!currentApp || currentApp.Organization?.Slug !== (journal.state.scope ?? config.scope ?? "personal")) throw new Error("The recorded Fly app is missing or belongs to a different organization")
  const currentVolumes = nativeArray<FlyVolume>((await call(["volumes", "list", ...appArgs, "--json"])).stdout, "fly volumes list")
  const ownedVolume = currentVolumes.find(volume => volume.id === journal.state.resources.volume)
  if (!ownedVolume || ownedVolume.name !== "bql_data" || ownedVolume.region !== config.region) throw new Error("The recorded Fly volume is missing or changed; recover its data before applying")
  await journal.step("network", async () => {
    const ips = nativeArray<{ Type: string }>((await call(["ips", "list", ...appArgs, "--json"])).stdout, "fly ips list")
    if (!ips.some(ip => ip.Type === "v6")) await call(["ips", "allocate-v6", ...appArgs])
    if (!ips.some(ip => ip.Type === "shared_v4")) await call(["ips", "allocate-v4", "--shared", ...appArgs])
  })
  await journal.step("secrets", async () => {
    await call(["secrets", "import", ...appArgs, "--stage"], ["BQL_ADMIN_KEY", "BQL_JWT_ED25519"].map(key => `${key}=${journal.secrets[key]}`).join("\n") + "\n")
  })
  await journal.publishRelease(release, async () => {
    await call(["deploy", ...appArgs, "--config", "fly.toml", "--remote-only", "--ha=false", "--yes"])
  })
  const endpoint = `https://${config.name}.fly.dev`
  await journal.recordEndpoint(endpoint)
  return endpoint
}
