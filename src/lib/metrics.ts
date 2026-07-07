/**
 * Minimal, dependency-free metrics registry that renders Prometheus text
 * exposition format at `/metrics`.
 *
 * We deliberately avoid `prom-client` (Node-only, native-ish) so the same code
 * emits metrics under Bun, Deno and Node. It supports the two shapes EdgeHive
 * needs: monotonically-increasing counters and a bucketed request-latency
 * histogram. Everything is in-process, matching the single-instance model of the
 * in-memory broadcaster.
 */

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly labelKeys = new Map<string, Record<string, string>>();

  // Latency histogram (seconds) — fixed buckets tuned for a fast edge API.
  private readonly buckets = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];
  private readonly bucketCounts = new Array(this.buckets.length + 1).fill(0);
  private latencySum = 0;
  private latencyCount = 0;

  private readonly startedAt = Date.now();

  /** Increment a labelled counter (labels are folded into the series key). */
  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
    if (!this.labelKeys.has(key)) this.labelKeys.set(key, { __name__: name, ...labels });
  }

  /** Record a request duration in seconds into the latency histogram. */
  observeLatency(seconds: number): void {
    this.latencySum += seconds;
    this.latencyCount += 1;
    let i = 0;
    for (; i < this.buckets.length; i++) {
      if (seconds <= this.buckets[i]) {
        this.bucketCounts[i] += 1;
        return;
      }
    }
    this.bucketCounts[this.buckets.length] += 1; // +Inf bucket
  }

  uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  /** Render the registry as Prometheus text exposition format. */
  render(extra: { subscribers: number; storeKind: string } ): string {
    const lines: string[] = [];

    lines.push("# HELP edgehive_uptime_seconds Process uptime in seconds.");
    lines.push("# TYPE edgehive_uptime_seconds gauge");
    lines.push(`edgehive_uptime_seconds ${this.uptimeSeconds()}`);

    lines.push("# HELP edgehive_sse_subscribers Current active SSE subscribers.");
    lines.push("# TYPE edgehive_sse_subscribers gauge");
    lines.push(`edgehive_sse_subscribers ${extra.subscribers}`);

    lines.push("# HELP edgehive_store_info Which store backend is active (value is always 1).");
    lines.push("# TYPE edgehive_store_info gauge");
    lines.push(`edgehive_store_info{kind="${extra.storeKind}"} 1`);

    // Counters grouped by metric name.
    const byName = new Map<string, Array<{ labels: Record<string, string>; value: number }>>();
    for (const [key, value] of this.counters) {
      const labels = this.labelKeys.get(key)!;
      const name = labels.__name__;
      const rest: Record<string, string> = {};
      for (const [k, v] of Object.entries(labels)) if (k !== "__name__") rest[k] = v;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name)!.push({ labels: rest, value });
    }
    for (const [name, series] of byName) {
      lines.push(`# HELP ${name} EdgeHive counter.`);
      lines.push(`# TYPE ${name} counter`);
      for (const s of series) {
        lines.push(`${name}${renderLabels(s.labels)} ${s.value}`);
      }
    }

    // Latency histogram.
    lines.push("# HELP edgehive_request_duration_seconds Request handler latency.");
    lines.push("# TYPE edgehive_request_duration_seconds histogram");
    let cumulative = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      cumulative += this.bucketCounts[i];
      lines.push(
        `edgehive_request_duration_seconds_bucket{le="${this.buckets[i]}"} ${cumulative}`,
      );
    }
    cumulative += this.bucketCounts[this.buckets.length];
    lines.push(`edgehive_request_duration_seconds_bucket{le="+Inf"} ${cumulative}`);
    lines.push(`edgehive_request_duration_seconds_sum ${this.latencySum.toFixed(6)}`);
    lines.push(`edgehive_request_duration_seconds_count ${this.latencyCount}`);

    return lines.join("\n") + "\n";
  }

  /** Structured snapshot for `/health` (subset of the above). */
  snapshot(): { uptimeSeconds: number; requests: number; p50Ms: number; p95Ms: number } {
    return {
      uptimeSeconds: this.uptimeSeconds(),
      requests: this.latencyCount,
      p50Ms: this.percentileMs(0.5),
      p95Ms: this.percentileMs(0.95),
    };
  }

  private percentileMs(p: number): number {
    if (this.latencyCount === 0) return 0;
    const target = this.latencyCount * p;
    let cumulative = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      cumulative += this.bucketCounts[i];
      if (cumulative >= target) return Math.round(this.buckets[i] * 1000);
    }
    return Math.round(this.buckets[this.buckets.length - 1] * 1000);
  }
}

function seriesKey(name: string, labels: Record<string, string>): string {
  const parts = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
  return name + "|" + parts.map(([k, v]) => `${k}=${v}`).join(",");
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return "{" + entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",") + "}";
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
