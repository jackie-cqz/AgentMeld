export function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

export function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
}

export function wilsonInterval(successes: number, total: number, z = 1.96): { low: number; high: number } {
  if (total <= 0) return { low: 0, high: 0 };
  const p = successes / total;
  const denominator = 1 + (z ** 2) / total;
  const center = (p + (z ** 2) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + (z ** 2) / (4 * total)) / total)) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}
