/**
 * Minimal Prometheus text-format metrics for the dashboard.
 *
 * Zero deps. Counters, gauges, and bounded histograms. Exposition format:
 *   https://prometheus.io/docs/instrumenting/exposition_formats/#text-format-example
 */

class Counter {
  constructor(name, help, labelNames = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.values = new Map();
  }
  inc(labels = {}, amount = 1) {
    const key = serializeLabels(this.labelNames, labels);
    this.values.set(key, (this.values.get(key) || 0) + amount);
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, val] of this.values) {
      lines.push(`${this.name}${key} ${val}`);
    }
    return lines.join('\n');
  }
}

class Gauge {
  constructor(name, help, labelNames = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.values = new Map();
  }
  set(labels = {}, value) {
    const key = serializeLabels(this.labelNames, labels);
    this.values.set(key, value);
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, val] of this.values) {
      lines.push(`${this.name}${key} ${val}`);
    }
    return lines.join('\n');
  }
}

class Histogram {
  constructor(name, help, labelNames = [], buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.buckets = buckets;
    this.observations = new Map();
  }
  observe(labels = {}, value) {
    const key = serializeLabels(this.labelNames, labels);
    let bucket = this.observations.get(key);
    if (!bucket) {
      bucket = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.observations.set(key, bucket);
    }
    bucket.sum += value;
    bucket.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) bucket.counts[i] += 1;
    }
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, bucket] of this.observations) {
      const labelInner = key ? key.slice(1, -1) : '';
      for (let i = 0; i < this.buckets.length; i++) {
        const le = this.buckets[i];
        const lbl = labelInner ? `{${labelInner},le="${le}"}` : `{le="${le}"}`;
        lines.push(`${this.name}_bucket${lbl} ${bucket.counts[i]}`);
      }
      const lblInf = labelInner ? `{${labelInner},le="+Inf"}` : `{le="+Inf"}`;
      lines.push(`${this.name}_bucket${lblInf} ${bucket.count}`);
      lines.push(`${this.name}_sum${key} ${bucket.sum}`);
      lines.push(`${this.name}_count${key} ${bucket.count}`);
    }
    return lines.join('\n');
  }
}

function serializeLabels(labelNames, labels) {
  if (!labelNames.length) return '';
  const parts = labelNames.map((n) => `${n}="${escapeLabel(labels[n] ?? '')}"`);
  return `{${parts.join(',')}}`;
}

function escapeLabel(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function createRegistry() {
  const collectors = [];
  return {
    counter(name, help, labelNames) {
      const c = new Counter(name, help, labelNames);
      collectors.push(c);
      return c;
    },
    gauge(name, help, labelNames) {
      const g = new Gauge(name, help, labelNames);
      collectors.push(g);
      return g;
    },
    histogram(name, help, labelNames, buckets) {
      const h = new Histogram(name, help, labelNames, buckets);
      collectors.push(h);
      return h;
    },
    render() {
      return collectors.map((c) => c.render()).join('\n') + '\n';
    },
  };
}

module.exports = { createRegistry, Counter, Gauge, Histogram };
