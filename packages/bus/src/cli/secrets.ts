/**
 * The bus's key material on disk: the signing keyring (`keys.json`) and the
 * admin token (`admin-token`), each a 0600 file in `<data>/bus`.
 * `BUS_SIGNING_KEY` and `BUS_ADMIN_TOKEN` override the files.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateKey, type Keyring, keyring, singleKey } from "../bus/tokens";

export interface KeyringFile {
  active: string;
  keys: Record<string, string>;
}

/** Secrets live in a 0600 file, not in argv where `ps` would show them. */
export async function loadOrCreate(path: string): Promise<string> {
  const file = Bun.file(path);
  if (await file.exists()) return (await file.text()).trim();
  const value = generateKey();
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, value, { mode: 0o600 });
  return value;
}

export async function writeKeyring(path: string, value: KeyringFile) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

/**
 * The signing keyring.
 *
 * Two keys live at once during a rotation, which is what makes rotating
 * possible without invalidating every token in the fleet at the same moment.
 * The first start writes one key, `k1`.
 */
export async function keyringIn(dir: string): Promise<Keyring> {
  // An explicit environment key means the operator is managing keys
  // themselves; rotation is theirs to do, so there is one and no file.
  if (process.env.BUS_SIGNING_KEY) return singleKey(process.env.BUS_SIGNING_KEY);
  const path = `${dir}/keys.json`;
  const file = Bun.file(path);
  if (await file.exists()) {
    const parsed = JSON.parse(await file.text()) as KeyringFile;
    return keyring(parsed.keys, parsed.active);
  }
  const first = generateKey();
  await writeKeyring(path, { active: "k1", keys: { k1: first } });
  return keyring({ k1: first }, "k1");
}

export async function secretsIn(dir: string) {
  return {
    adminToken:
      process.env.BUS_ADMIN_TOKEN ?? (await loadOrCreate(`${dir}/admin-token`)),
  };
}

/**
 * A clustered node's keys. Every node has to verify the tokens every other
 * node minted, so nothing is generated here: a node that would make its own
 * key refuses to start instead of answering 401 after a failover.
 */
export async function clusterSecretsIn(
  dir: string,
): Promise<{ keys: Keyring; adminToken: string }> {
  const missing: string[] = [];
  const hasKeys =
    Boolean(process.env.BUS_SIGNING_KEY) ||
    (await Bun.file(`${dir}/keys.json`).exists());
  if (!hasKeys) missing.push(`BUS_SIGNING_KEY or ${dir}/keys.json`);
  const hasToken =
    Boolean(process.env.BUS_ADMIN_TOKEN) ||
    (await Bun.file(`${dir}/admin-token`).exists());
  if (!hasToken) missing.push(`BUS_ADMIN_TOKEN or ${dir}/admin-token`);
  if (missing.length > 0)
    throw new Error(
      `a clustered bus needs the same keys on every node and generates none; provide ${missing.join(" and ")}`,
    );
  return {
    keys: await keyringIn(dir),
    adminToken: (await secretsIn(dir)).adminToken,
  };
}
