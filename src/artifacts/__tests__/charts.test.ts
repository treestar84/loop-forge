import { renderMetricTable, renderProgressionSvg, unicodeBar } from '../charts';

describe('unicodeBar', () => {
  it('produces a full bar at value===max', () => {
    expect(unicodeBar(20, 20, 10)).toBe('▇'.repeat(10));
  });

  it('produces an empty bar at value===0', () => {
    expect(unicodeBar(0, 20, 10)).toBe('');
  });

  it('produces a half bar at value===max/2', () => {
    expect(unicodeBar(10, 20, 10)).toBe('▇'.repeat(5));
  });

  it('clamps values above max', () => {
    expect(unicodeBar(1000, 20, 10)).toBe('▇'.repeat(10));
  });
});

describe('renderMetricTable', () => {
  it('renders a Markdown table with a bar column', () => {
    const table = renderMetricTable([
      { label: 'winRate', value: '62.0%', bar: { value: 0.62, max: 1 } },
      { label: 'scoreDiff', value: '0.800' },
    ]);
    expect(table).toContain('| metric | value | bar |');
    expect(table).toContain('winRate');
    expect(table).toContain('62.0%');
    expect(table).toContain('▇');
  });
});

describe('renderProgressionSvg', () => {
  it('produces a valid-looking SVG with a viewBox and one polyline per series', () => {
    const svg = renderProgressionSvg(
      [
        { label: 'random anchor', points: [{ x: 'v1', y: 0.5 }, { x: 'v2', y: 0.65 }] },
        { label: 'heuristic anchor', points: [{ x: 'v1', y: 0.3 }, { x: 'v2', y: 0.45 }] },
      ],
      { title: 'Anchor win rate progression', yLabel: 'win rate' },
    );
    expect(svg).toContain('<svg');
    expect(svg).toMatch(/viewBox="0 0 700 360"/);
    expect((svg.match(/<polyline/g) ?? []).length).toBe(2);
    expect(svg).toContain('random anchor');
    expect(svg).toContain('heuristic anchor');
    expect(svg).toContain('</svg>');
  });

  it('escapes XML-sensitive characters in labels', () => {
    const svg = renderProgressionSvg(
      [{ label: 'a & b < c', points: [{ x: 'v1', y: 1 }] }],
      { title: 'x & y', yLabel: 'y' },
    );
    expect(svg).toContain('a &amp; b &lt; c');
    expect(svg).not.toContain('a & b < c');
  });

  it('handles an empty series list without throwing', () => {
    const svg = renderProgressionSvg([], { title: 'empty', yLabel: 'y' });
    expect(svg).toContain('<svg');
  });
});
