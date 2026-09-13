/**
 * Metrics: a sink seam, and a Prometheus renderer behind it.
 *
 * The shape — `counter`, `gauge`, `histogram` — is deliberately the same as
 * dagr's `MetricsSink`, so an operator running both scrapes one vocabulary.
 * It is *copied* rather than imported: the bus must never depend on dagr, and
 * a hundred lines is a cheaper price than that dependency.
 *
 * Histograms keep count/sum/min/max rather than buckets. Bucket boundaries
 * depend on the workload, and a wrong default is worse than an honest summary —
 * a host that wants quantiles should pass its own sink.
 */

export type Tags = Record<string, string>;

export interface MetricsSink {
  counter(name: string, value: number, tags?: Tags): void;
  gauge(name: string, value: number, tags?: Tags): void;
  histogram(name: string, value: number, tags?: Tags): void;
}

export function noopMetrics(): MetricsSink {
  return { counter: () => {}, gauge: () => {}, histogram: () => {} };
}

export interface PrometheusMetrics extends MetricsSink {
  /** The current snapshot, in Prometheus text exposition format. */
  render(): string;
  /** Drop everything. Only for tests; a real scrape target is cumulative. */
  reset(): void;
}

interface Series {
  kind: "counter" | "gauge" | "histogram";
  name: string;
  tags: Tags;
  value: number;
  count: number;
  sum: number;
  min: number;
  max: number;
}

/** `agenticbus.claim.duration` -> `agenticbus_claim_duration`. Dots are illegal. */
function metricName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function sorted(tags: Tags): [string, string][] {
  return Object.entries(tags)
    .filter(([, value]) => value !== "")
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

function labelKey(name: string, tags: Tags): string {
  return `${name}{${sorted(tags)
    .map(([key, value]) => `${key}=${value}`)
    .join(",")}}`;
}

function renderLabels(tags: Tags): string {
  const pairs = sorted(tags);
  if (pairs.length === 0) return "";
  const body = pairs
    .map(
      ([key, value]) =>
        `${metricName(key)}="${value
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\n/g, "\\n")}"`,
    )
    .join(",");
  return `{${body}}`;
}

export function prometheusMetrics(): PrometheusMetrics {
  const series = new Map<string, Series>();

  const upsert = (
    kind: Series["kind"],
    name: string,
    value: number,
    tags: Tags,
  ): Series => {
    const key = labelKey(`${kind}:${name}`, tags);
    let found = series.get(key);
    if (found === undefined) {
      found = {
        kind,
        name,
        tags,
        value: 0,
        count: 0,
        sum: 0,
        min: value,
        max: value,
      };
      series.set(key, found);
    }
    return found;
  };

  return {
    counter(name, value, tags = {}) {
      upsert("counter", name, value, tags).value += value;
    },
    gauge(name, value, tags = {}) {
      upsert("gauge", name, value, tags).value = value;
    },
    histogram(name, value, tags = {}) {
      const found = upsert("histogram", name, value, tags);
      found.count++;
      found.sum += value;
      found.min = Math.min(found.min, value);
      found.max = Math.max(found.max, value);
    },
    render(): string {
      const lines: string[] = [];
      const declared = new Set<string>();
      for (const entry of series.values()) {
        const name = metricName(entry.name);
        const labels = renderLabels(entry.tags);
        if (!declared.has(name)) {
          declared.add(name);
          lines.push(
            `# TYPE ${name} ${entry.kind === "histogram" ? "summary" : entry.kind}`,
          );
        }
        if (entry.kind === "histogram") {
          lines.push(`${name}_count${labels} ${entry.count}`);
          lines.push(`${name}_sum${labels} ${entry.sum}`);
          lines.push(`${name}_min${labels} ${entry.count === 0 ? 0 : entry.min}`);
          lines.push(`${name}_max${labels} ${entry.count === 0 ? 0 : entry.max}`);
        } else {
          lines.push(`${name}${labels} ${entry.value}`);
        }
      }
      return `${lines.join("\n")}\n`;
    },
    reset(): void {
      series.clear();
    },
  };
}
