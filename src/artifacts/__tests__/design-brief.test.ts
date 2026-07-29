import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderDesignBrief, stripHoldoutLadderFields } from '../design-brief';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'loop-forge-design-brief-'));
}

function gameDir(root: string, gameId: string): string {
  const dir = join(root, 'runs', gameId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('renderDesignBrief', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('renders every section from a full fixture directory', () => {
    const dir = gameDir(root, 'fixture-game');
    writeFileSync(join(dir, 'summary.md'), '# 게임 요약: fixture-game\n\n온보딩 완료.\n', 'utf8');
    writeFileSync(
      join(dir, 'registry.json'),
      JSON.stringify({
        anchors: [
          { anchorId: 'anchor-heuristic', kind: 'heuristic' },
          { anchorId: 'external-mid-l1', kind: 'external', role: 'feedback' },
          { anchorId: 'external-opus-l2', kind: 'external', role: 'feedback' },
          { anchorId: 'external-style2-l3', kind: 'external', role: 'holdout' },
        ],
      }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'anchor-ladder.json'),
      JSON.stringify({
        gate1: { candidateWinRate: 1, pass: true },
        gate2: { candidateWinRate: 0.05, pass: true },
        bothPass: true,
        l3AnchorId: 'external-style2-l3',
        l3Gate2: { agreementRate: 0.6920289855072463 },
      }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'ledger.json'),
      JSON.stringify({
        records: [
          {
            waveId: 'wave-1',
            entries: [{ verdict: 'adopted' }, { verdict: 'near-miss' }, { verdict: 'rejected' }],
          },
        ],
      }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'near-miss.json'),
      JSON.stringify([
        { flags: ['flagA'], failedAtTier: 'smoke', gap: { winRateGap: 0.05, scoreDiffGap: 0.1 } },
      ]),
      'utf8',
    );
    mkdirSync(join(dir, 'challenge-l2'), { recursive: true });
    writeFileSync(
      join(dir, 'challenge-l2', 'loss-report.json'),
      JSON.stringify({
        totalGames: 200,
        candidateLosses: 200,
        firstDivergenceDepthHistogram: { '0-9': 200 },
        mismatchRateByDecisionPoint: { place: { decisions: 854, mismatches: 812 } },
      }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'probe-bank.json'),
      JSON.stringify({
        probes: [
          { probeId: 'a', sourceAnchorId: 'external-opus-l2' },
          { probeId: 'b', sourceAnchorId: 'external-opus-l2' },
        ],
        seal: 'sha256-fake',
      }),
      'utf8',
    );

    const brief = renderDesignBrief({
      gameId: 'fixture-game',
      rootDir: root,
      axisMatrix: [{ axis: 'A5 트리 prior', status: '미시도', note: '이번 라운드 신설' }],
      extraEvidence: [{ title: 'prior 진단', body: '진단 요약 텍스트' }],
    });

    expect(brief).toContain('# 설계 브리프');
    expect(brief).toContain('LossReport 있음');
    expect(brief).toContain('프로브 은행 있음(국면 2개)');
    expect(brief).toContain('게임 요약: fixture-game');
    expect(brief).toContain('앵커 래더 게이트');
    expect(brief).toContain('채택 1, 근접실패 1, 실패/선별 1');
    expect(brief).toContain('flagA');
    expect(brief).toContain('LossReport 요약');
    expect(brief).toContain('place');
    expect(brief).toContain('프로브 은행 통계');
    expect(brief).toContain('external-opus-l2: 2개');
    expect(brief).toContain('A5 트리 prior');
    expect(brief).toContain('prior 진단');
    expect(brief).toContain('설계자 지시');
    expect(brief).toContain('B1-exploit');
    expect(brief).toContain('홀드아웃 앵커(L3) 정보는 이 브리프에 절대 포함되지 않는다');
  });

  it('degrades every missing artifact to an honest "산출물 없음" line without throwing', () => {
    gameDir(root, 'empty-game');

    const brief = renderDesignBrief({
      gameId: 'empty-game',
      rootDir: root,
      axisMatrix: [],
    });

    expect(brief).toContain('LossReport 없음');
    expect(brief).toContain('프로브 은행 없음');
    expect(brief).toContain('산출물 없음(summary.md 없음)');
    expect(brief).toContain('산출물 없음(anchor-ladder.json 없음)');
    expect(brief).toContain('산출물 없음(ledger.json 없음)');
    expect(brief).toContain('산출물 없음(near-miss.json 없음)');
    expect(brief).toContain('산출물 없음(challenge-l2/loss-report.json 없음)');
    expect(brief).toContain('산출물 없음(probe-bank.json 없음)');
  });

  it('does not throw when the runs/<gameId> directory itself does not exist', () => {
    expect(() =>
      renderDesignBrief({ gameId: 'nonexistent-game', rootDir: root, axisMatrix: [] }),
    ).not.toThrow();
  });

  it('strips L3 holdout ladder fields from the rendered brief even though the raw file has them', () => {
    const dir = gameDir(root, 'holdout-game');
    writeFileSync(
      join(dir, 'registry.json'),
      JSON.stringify({
        anchors: [{ anchorId: 'external-style2-l3', kind: 'external', role: 'holdout' }],
      }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'anchor-ladder.json'),
      JSON.stringify({
        gate1: { candidateWinRate: 1, pass: true },
        gate2: { candidateWinRate: 0.05, pass: true },
        bothPass: true,
        l3AnchorId: 'external-style2-l3',
        l3GeneratedAt: '2026-07-28T23:30:54.316Z',
        l3Gate1: { candidateWinRate: 1, pass: true },
        l3Gate2: { agreementRate: 0.6920289855072463, pass: true },
        l3BothPass: true,
      }),
      'utf8',
    );

    const brief = renderDesignBrief({ gameId: 'holdout-game', rootDir: root, axisMatrix: [] });

    expect(brief).not.toContain('0.692');
    expect(brief).not.toContain('l3Gate2');
    expect(brief).not.toContain('external-style2-l3');
    // Non-holdout gates still render.
    expect(brief).toContain('앵커 래더 게이트');
  });

  it('stripHoldoutLadderFields keeps l3* fields when the registry confirms role feedback (positive control)', () => {
    const ladder = {
      gate1: { pass: true },
      l3AnchorId: 'mid-tier-l3-named-anchor',
      l3Gate2: { agreementRate: 0.5 },
    };
    const registry = {
      anchors: [{ anchorId: 'mid-tier-l3-named-anchor', kind: 'external', role: 'feedback' }],
    };

    const kept = stripHoldoutLadderFields(ladder, registry);
    expect(kept['l3Gate2']).toEqual({ agreementRate: 0.5 });

    const strippedByDefault = stripHoldoutLadderFields(ladder, undefined);
    expect(strippedByDefault['l3Gate2']).toBeUndefined();
  });
});
