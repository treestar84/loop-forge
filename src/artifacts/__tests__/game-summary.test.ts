import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunStore, computeComparabilityKey } from '../run-store';
import { loadOrCreateLedger, loadOrCreateRegistry, saveLedger, saveRegistry } from '../game-state';
import { DEFAULT_CRITERIA } from '../../kernel/gates';
import { renderGameSummaryMarkdown } from '../game-summary';
import type { ConformanceReport } from '../../onboarding/report';

const conformancePayload: ConformanceReport = {
  gameId: 'gomoku',
  axes: [{ axis: 'C0-contract', score: 90, blockers: [], notes: [] }],
  overallScore: 90,
  ready: true,
  threshold: 65,
};

describe('renderGameSummaryMarkdown', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'loop-forge-game-summary-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('reports "not yet" for a game with no runs, registry, or ledger', () => {
    const markdown = renderGameSummaryMarkdown(rootDir, 'nonexistent-game');
    expect(markdown).toContain('# 게임 요약: nonexistent-game');
    expect(markdown).toContain('아직 온보딩 채점 안 됨');
    expect(markdown).toContain('등록된 기준선 버전 없음');
    expect(markdown).toContain('아직 기록된 웨이브 없음');
    expect(markdown).toContain('아직 벤치마크 없음');
    expect(markdown).toContain('(없음)');
  });

  it('summarizes conformance, baseline, and ledger state for a game with data', () => {
    const store = new RunStore(rootDir);
    store.saveRun({
      gameId: 'gomoku',
      runId: 'conformance',
      kind: 'conformance',
      recordedAt: '2026-07-01T00:00:00.000Z',
      comparabilityKey: computeComparabilityKey({
        gameId: 'gomoku',
        specDigest: 'sha256-abc',
        baselineVersion: 'n/a',
        opponentId: 'n/a',
        seedBankIds: [],
      }),
      payload: conformancePayload,
      markdown: '# Conformance Report: gomoku',
    });

    const registry = loadOrCreateRegistry(rootDir, 'gomoku');
    registry.register({
      version: 'v1',
      flags: [],
      parent: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      sourceWaveId: null,
      notes: 'pristine',
    });
    registry.registerAnchor({ anchorId: 'anchor-random', kind: 'random' });
    saveRegistry(rootDir, 'gomoku', registry);

    const ledger = loadOrCreateLedger(rootDir, 'gomoku');
    ledger.add({
      waveId: 'wave-1',
      recordedAt: '2026-07-01T01:00:00.000Z',
      comparabilityKey: 'sha256-def',
      baselineVersion: 'v1',
      opponentId: 'heuristic',
      entries: [
        {
          flags: ['flagA'],
          verdict: 'near-miss',
          tierStats: { smoke: { pointWinRate: 0.5, pointScoreDiff: 3, blocks: 10 } },
        },
        {
          flags: ['flagB'],
          verdict: 'adopted',
          tierStats: { holdout: { pointWinRate: 0.6, pointScoreDiff: 8, blocks: 20 } },
        },
      ],
      nextLoopNotes: [],
    });
    saveLedger(rootDir, 'gomoku', ledger);

    const markdown = renderGameSummaryMarkdown(rootDir, 'gomoku', {
      latestWaveCriteria: DEFAULT_CRITERIA,
    });

    expect(markdown).toContain('overallScore=90 / 65, ready=yes');
    expect(markdown).toContain('v1: flags=[(no flags)]');
    expect(markdown).toContain('anchor-random: random');
    expect(markdown).toContain('채택 1, 근접실패 1, 실패/선별 0');
    expect(markdown).toContain('flagA');
    expect(markdown).toContain('DESIGN.md §6.1');
    expect(markdown).toContain('아직 벤치마크 없음');
  });
});
