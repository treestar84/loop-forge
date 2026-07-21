/**
 * Conformance report types and Markdown rendering for the G-Score battery
 * (DESIGN.md §4, axes C0-contract .. C7-parity). Scoring itself (running the
 * axes against a GameAdapter) is implemented separately in `score.ts`; this
 * module only defines the report shape and how to build/render it.
 */

export type AxisId =
  | 'C0-contract'
  | 'C1-determinism'
  | 'C2-integrity'
  | 'C3-hidden-info'
  | 'C4-throughput'
  | 'C5-baselines'
  | 'C6-strategy-surface'
  | 'C7-parity';

export interface AxisBlocker {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
}

export interface AxisResult {
  readonly axis: AxisId;
  /** 0-100. */
  readonly score: number;
  readonly blockers: readonly AxisBlocker[];
  readonly notes: readonly string[];
}

export interface ConformanceReport {
  readonly gameId: string;
  readonly axes: readonly AxisResult[];
  /** The minimum axis score dominates — not a weighted average (DESIGN.md §4). */
  readonly overallScore: number;
  readonly ready: boolean;
  readonly threshold: number;
}

/**
 * Build a ConformanceReport from per-axis results. `overallScore` is the
 * minimum score across all axes (a single weak axis makes the whole loop
 * meaningless). `ready` requires overallScore >= threshold AND that every
 * axis contributing to that minimum is blocker-free — in practice this means
 * no axis may have any blockers while also being ready, since a blocker on
 * any axis signals unresolved defects regardless of its numeric score.
 */
export function buildReport(
  gameId: string,
  axes: readonly AxisResult[],
  threshold = 70,
): ConformanceReport {
  const overallScore =
    axes.length === 0 ? 0 : Math.min(...axes.map((axis) => axis.score));
  const hasBlockers = axes.some((axis) => axis.blockers.length > 0);
  const ready = axes.length > 0 && overallScore >= threshold && !hasBlockers;

  return {
    gameId,
    axes,
    overallScore,
    ready,
    threshold,
  };
}

function renderAxisRow(axis: AxisResult): string {
  const status = axis.blockers.length > 0 ? '⛔' : '✅';
  return `| ${axis.axis} | ${axis.score} | ${axis.blockers.length} | ${status} |`;
}

function renderBlockerSection(axis: AxisResult): string[] {
  if (axis.blockers.length === 0) {
    return [];
  }
  const lines = [`### ${axis.axis} — blockers`, ''];
  for (const blocker of axis.blockers) {
    lines.push(`- **${blocker.code}**: ${blocker.message}`);
    lines.push(`  - remediation: ${blocker.remediation}`);
  }
  lines.push('');
  return lines;
}

/** Render a human-readable Markdown conformance report. */
export function renderReportMarkdown(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push(`# Conformance Report: ${report.gameId}`);
  lines.push('');
  lines.push(
    `**Overall score:** ${report.overallScore} / 100 (threshold: ${report.threshold})`,
  );
  lines.push(`**Ready for loop execution:** ${report.ready ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('| Axis | Score | Blockers | Status |');
  lines.push('|---|---|---|---|');
  for (const axis of report.axes) {
    lines.push(renderAxisRow(axis));
  }
  lines.push('');

  for (const axis of report.axes) {
    lines.push(...renderBlockerSection(axis));
  }

  for (const axis of report.axes) {
    if (axis.notes.length === 0) {
      continue;
    }
    lines.push(`### ${axis.axis} — notes`, '');
    for (const note of axis.notes) {
      lines.push(`- ${note}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
