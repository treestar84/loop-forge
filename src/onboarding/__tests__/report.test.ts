import { buildReport, renderReportMarkdown, type AxisResult } from '../report';

function axis(
  id: AxisResult['axis'],
  score: number,
  blockers: AxisResult['blockers'] = [],
): AxisResult {
  return { axis: id, score, blockers, notes: [] };
}

describe('buildReport', () => {
  it('overallScore is the minimum axis score, not an average', () => {
    const report = buildReport('mini-trick', [
      axis('C0-contract', 100),
      axis('C1-determinism', 90),
      axis('C2-integrity', 40),
    ]);
    expect(report.overallScore).toBe(40);
  });

  it('is ready when overallScore meets threshold and no axis has blockers', () => {
    const report = buildReport(
      'mini-trick',
      [axis('C0-contract', 80), axis('C1-determinism', 75)],
      70,
    );
    expect(report.overallScore).toBe(75);
    expect(report.ready).toBe(true);
  });

  it('is not ready when overallScore is below threshold even with no blockers', () => {
    const report = buildReport(
      'mini-trick',
      [axis('C0-contract', 80), axis('C1-determinism', 50)],
      70,
    );
    expect(report.ready).toBe(false);
  });

  it('is not ready when any axis has a blocker, even if overallScore clears threshold', () => {
    const report = buildReport(
      'mini-trick',
      [
        axis('C0-contract', 90),
        axis('C1-determinism', 90, [
          { code: 'NONDET', message: 'seed 1 diverged', remediation: 'fix rng usage' },
        ]),
      ],
      70,
    );
    expect(report.overallScore).toBe(90);
    expect(report.ready).toBe(false);
  });

  it('is not ready for an empty axis list', () => {
    const report = buildReport('mini-trick', []);
    expect(report.overallScore).toBe(0);
    expect(report.ready).toBe(false);
  });

  it('defaults the threshold to 70', () => {
    const report = buildReport('mini-trick', [axis('C0-contract', 70)]);
    expect(report.threshold).toBe(70);
    expect(report.ready).toBe(true);
  });
});

describe('renderReportMarkdown', () => {
  it('includes the overall score, axis table, blockers, and remediation', () => {
    const report = buildReport('mini-trick', [
      axis('C0-contract', 90),
      axis('C2-integrity', 40, [
        {
          code: 'INVALID_MOVE',
          message: 'illegal choice accepted',
          remediation: 'reject choices not in getLegalChoices',
        },
      ]),
    ]);
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain('mini-trick');
    expect(markdown).toContain('C0-contract');
    expect(markdown).toContain('C2-integrity');
    expect(markdown).toContain('INVALID_MOVE');
    expect(markdown).toContain('illegal choice accepted');
    expect(markdown).toContain('reject choices not in getLegalChoices');
    expect(markdown).toContain('40 / 100');
  });

  it('renders notes for axes that have them', () => {
    const report = buildReport('mini-trick', [
      {
        axis: 'C4-throughput',
        score: 95,
        blockers: [],
        notes: ['measured 12000 games/sec'],
      },
    ]);
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain('measured 12000 games/sec');
  });
});
