/**
 * Hand-rolled inline-SVG micro charts for the explorer — no chart library.
 * Returned as HTML strings so views can drop them into innerHTML. Colors come
 * from the theme via CSS variables, so light/dark both work.
 */

export interface SparkOpts {
  w?: number;
  h?: number;
  fill?: boolean;
}

/** Line chart of `points` (left → right), normalized to its own min/max. */
export function sparklineSVG(points: number[], opts: SparkOpts = {}): string {
  const w = opts.w ?? 320;
  const h = opts.h ?? 56;
  if (points.length < 2) return emptySpark(w, h);

  const pad = 3;
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p < min) min = p;
    if (p > max) max = p;
  }
  const span = max - min || 1;
  const step = (w - pad * 2) / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = pad + i * step;
    const y = pad + (h - pad * 2) * (1 - (p - min) / span);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const fill = opts.fill
    ? `<polygon points="${pad},${h - pad} ${coords.join(' ')} ${(pad + (points.length - 1) * step).toFixed(1)},${h - pad}" fill="var(--accent-soft)" stroke="none"></polygon>`
    : '';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">
    ${fill}
    <polyline points="${coords.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"></polyline>
  </svg>`;
}

/** Bar chart of non-negative `values` (left → right), normalized to its max. */
export function barsSVG(values: number[], opts: SparkOpts = {}): string {
  const w = opts.w ?? 320;
  const h = opts.h ?? 56;
  if (values.length === 0) return emptySpark(w, h);

  const pad = 3;
  const max = Math.max(...values, 1);
  const slot = (w - pad * 2) / values.length;
  const barW = Math.max(1, slot * 0.7);
  const bars = values.map((v, i) => {
    const barH = (h - pad * 2) * (v / max);
    const x = pad + i * slot + (slot - barW) / 2;
    const y = h - pad - barH;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(barH, v > 0 ? 1 : 0).toFixed(1)}" fill="var(--accent)" opacity="0.75" rx="1"></rect>`;
  });
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">${bars.join('')}</svg>`;
}

/** Cap a series at `maxPoints` by averaging fixed-size buckets. */
export function downsample(points: number[], maxPoints: number): number[] {
  if (points.length <= maxPoints) return points;
  const out: number[] = [];
  const bucket = points.length / maxPoints;
  for (let i = 0; i < maxPoints; i++) {
    const start = Math.floor(i * bucket);
    const end = Math.max(start + 1, Math.floor((i + 1) * bucket));
    let sum = 0;
    for (let j = start; j < end; j++) sum += points[j]!;
    out.push(sum / (end - start));
  }
  return out;
}

function emptySpark(w: number, h: number): string {
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">
    <line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 4"></line>
  </svg>`;
}
