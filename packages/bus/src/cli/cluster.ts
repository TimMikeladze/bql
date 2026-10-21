/**
 * Serve the bus on a `Bql` that serves itself: what `bql bus serve --cluster`
 * and `bql serve --bus` share once each has opened its engine.
 */
import type { Bql, ServerHandle } from "../../../db/src/embedded.ts";
import type { Logger } from "../bus/log";
import { prometheusMetrics } from "../bus/metrics";
import { busNode, type BusNode } from "../bus/node";
import type { Ack } from "../bus/storage";
import { clusterSecretsIn, keyringIn, secretsIn } from "./secrets";

export interface ServeBusOptions {
  /** Where the bus keeps its keys: `keys.json` and `admin-token`. */
  data: string;
  database?: string;
  ack?: Ack;
  prefix?: string;
  port?: number;
  host?: string;
  logger?: Logger;
  assets?: string;
}

export interface ServedBus {
  node: BusNode;
  handle: ServerHandle;
  /** The bus's base URL on this node, `http://host:port/bus`. */
  url: string;
  close(): Promise<void>;
}

export async function serveBus(bq: Bql, options: ServeBusOptions): Promise<ServedBus> {
  const clustered = bq.config.cluster.enabled;
  const { keys, adminToken } = clustered
    ? await clusterSecretsIn(options.data)
    : {
        keys: await keyringIn(options.data),
        adminToken: (await secretsIn(options.data)).adminToken,
      };
  const prefix = options.prefix ?? "/bus";
  const node = busNode({
    bq,
    ...(options.database ? { database: options.database } : {}),
    ...(options.ack ? { ack: options.ack } : {}),
    prefix,
    signingKey: keys,
    adminToken,
    metrics: prometheusMetrics(),
    ...(options.logger ? { logger: options.logger } : {}),
    assets: options.assets ?? "dist/dashboard",
  });
  const handle = await bq.serve({
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    mount: [node.mount],
  });
  await node.start();
  return {
    node,
    handle,
    url: `${handle.url}${prefix}`,
    async close() {
      await node.close();
      await bq.close();
    },
  };
}
