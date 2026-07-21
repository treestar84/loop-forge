/**
 * Dependency-free report visuals: Unicode bar charts for terminal/Markdown
 * tables, and a small inline SVG line-chart renderer for baseline-version
 * progression against benchmark anchors (INTERPRETATION.md §5). No canvas,
 * no external libs — everything here is a plain string builder so it can be
 * embedded directly into a Markdown report or written to a standalone .svg
 * file by run-store.
 */

const FULL_BLOCK = '▇'; // ▇

export function unicodeBar(value: number, max: number, width = 20): string {
  if (width <= 0) {
    throw new Error('unicodeBar: width must be positive');
  }
  if (max <= 0) {
    return ''.padEnd(0);
  }
  const clamped = Math.max(0, Math.min(value, max));
  const filled = Math.round((clamped / max) * width);
  return FULL_BLOCK.repeat(Math.max(0, Math.min(width, filled)));
}

export interface MetricRow {
  readonly label: string;
  readonly value: string;
  readonly bar?: { readonly value: number; readonly max: number };
}

export function renderMetricTable(rows: readonly MetricRow[]): string {
  const lines = ['| metric | value | bar |', '|---|---|---|'];
  for (const row of rows) {
    const bar = row.bar ? unicodeBar(row.bar.value, row.bar.max) : '';
    lines.push(`| ${row.label} | ${row.value} | ${bar} |`);
  }
  return lines.join('\n');
}

export interface ProgressionPoint {
  readonly x: string;
  readonly y: number;
}

export interface ProgressionSeries {
  readonly label: string;
  readonly points: readonly ProgressionPoint[];
}

export interface ProgressionSvgOptions {
  readonly title: string;
  readonly yLabel: string;
  readonly yMin?: number;
  readonly yMax?: number;
}

const SERIES_COLORS: readonly string[] = [
  '#2563eb', // blue
  '#dc2626', // red
  '#16a34a', // green
  '#d97706', // amber
  '#7c3aed', // violet
  '#0891b2', // cyan
];

const SVG_WIDTH = 700;
const SVG_HEIGHT = 360;
const MARGIN = { top: 40, right: 24, bottom: 56, left: 56 };

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a 700x360 line chart of baseline-version-over-time series (e.g. each
 * anchor's win rate across successive baseline versions). All series share
 * one x-axis of category labels (the union of every point's `x`, in first-
 * seen order) and one shared y-scale (fit to data unless yMin/yMax given).
 */
export function renderProgressionSvg(
  series: readonly ProgressionSeries[],
  options: ProgressionSvgOptions,
): string {
  const plotWidth = SVG_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = SVG_HEIGHT - MARGIN.top - MARGIN.bottom;

  const xLabels: string[] = [];
  for (const s of series) {
    for (const point of s.points) {
      if (!xLabels.includes(point.x)) {
        xLabels.push(point.x);
      }
    }
  }

  const allY = series.flatMap((s) => s.points.map((p) => p.y));
  const dataMin = allY.length > 0 ? Math.min(...allY) : 0;
  const dataMax = allY.length > 0 ? Math.max(...allY) : 1;
  const yMin = options.yMin ?? Math.min(0, dataMin);
  const yMax = options.yMax ?? Math.max(1, dataMax);
  const ySpan = yMax - yMin || 1;

  const xStep = xLabels.length > 1 ? plotWidth / (xLabels.length - 1) : 0;

  function xPos(label: string): number {
    const index = xLabels.indexOf(label);
    return MARGIN.left + (xLabels.length > 1 ? index * xStep : plotWidth / 2);
  }

  function yPos(value: number): number {
    return MARGIN.top + plotHeight - ((value - yMin) / ySpan) * plotHeight;
  }

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" font-family="sans-serif">`,
  );
  parts.push(`<rect x="0" y="0" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="none" />`);
  parts.push(
    `<text x="${SVG_WIDTH / 2}" y="20" text-anchor="middle" font-size="16" fill="currentColor">${escapeXml(options.title)}</text>`,
  );

  // Axes.
  parts.push(
    `<line x1="${MARGIN.left}" y1="${MARGIN.top}" x2="${MARGIN.left}" y2="${MARGIN.top + plotHeight}" stroke="currentColor" stroke-width="1" />`,
  );
  parts.push(
    `<line x1="${MARGIN.left}" y1="${MARGIN.top + plotHeight}" x2="${MARGIN.left + plotWidth}" y2="${MARGIN.top + plotHeight}" stroke="currentColor" stroke-width="1" />`,
  );
  parts.push(
    `<text x="${MARGIN.left - 40}" y="${MARGIN.top}" font-size="12" fill="currentColor">${escapeXml(options.yLabel)}</text>`,
  );

  // Y ticks (5 divisions).
  const tickCount = 5;
  for (let i = 0; i <= tickCount; i += 1) {
    const value = yMin + (ySpan * i) / tickCount;
    const y = yPos(value);
    parts.push(
      `<line x1="${MARGIN.left - 4}" y1="${y}" x2="${MARGIN.left}" y2="${y}" stroke="currentColor" stroke-width="1" />`,
    );
    parts.push(
      `<text x="${MARGIN.left - 8}" y="${y + 4}" font-size="10" text-anchor="end" fill="currentColor">${value.toFixed(2)}</text>`,
    );
  }

  // X labels.
  xLabels.forEach((label) => {
    const x = xPos(label);
    parts.push(
      `<text x="${x}" y="${MARGIN.top + plotHeight + 18}" font-size="10" text-anchor="middle" fill="currentColor">${escapeXml(label)}</text>`,
    );
  });

  // Series lines + legend.
  series.forEach((s, index) => {
    const color = SERIES_COLORS[index % SERIES_COLORS.length];
    const pointsAttr = s.points.map((p) => `${xPos(p.x)},${yPos(p.y)}`).join(' ');
    parts.push(`<polyline points="${pointsAttr}" fill="none" stroke="${color}" stroke-width="2" />`);
    for (const p of s.points) {
      parts.push(`<circle cx="${xPos(p.x)}" cy="${yPos(p.y)}" r="3" fill="${color}" />`);
    }

    const legendY = MARGIN.top + index * 16;
    parts.push(
      `<rect x="${SVG_WIDTH - MARGIN.right - 12}" y="${legendY - 8}" width="10" height="10" fill="${color}" />`,
    );
    parts.push(
      `<text x="${SVG_WIDTH - MARGIN.right - 16}" y="${legendY}" font-size="11" text-anchor="end" fill="currentColor">${escapeXml(s.label)}</text>`,
    );
  });

  parts.push('</svg>');
  return parts.join('\n');
}
