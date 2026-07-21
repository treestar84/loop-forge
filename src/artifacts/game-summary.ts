/**
 * One-page per-game status summary (GAP-ANALYSIS-5.md H8): a game's runs,
 * baseline lineage, adoption history, and benchmark ladder each live in
 * separate files under `runs/<gameId>/` — this module reads them all back
 * and renders a single Markdown digest so "what state is this game in"
 * doesn't require opening every file by hand.
 */

import type { PromotionCriteria } from '../kernel/gates';
import { RunStore, type RunSummary } from './run-store';
import { loadOrCreateLedger, loadOrCreateRegistry } from './game-state';
import { extractNearMissCandidates, type NearMissCandidate } from './adoption-ledger';
import { renderLadderMarkdown, type LadderResult } from './benchmark';

/** Mirrors onboarding/report.ts's ConformanceReport shape structurally —
 * artifacts may not import from onboarding (layer rule), so this narrows the
 * run payload's `unknown` type by duck-typing instead. */
interface ConformanceReportShape {
  readonly overallScore: number;
  readonly ready: boolean;
  readonly threshold: number;
}

export interface GameSummaryOptions {
  /** Needed to compute near-miss gaps for the ledger's latest record; if
   * omitted, near-miss candidates are counted but not tabulated. */
  readonly latestWaveCriteria?: PromotionCriteria;
}

function latestOfKind(runs: readonly RunSummary[], kind: RunSummary['kind']): RunSummary | undefined {
  let latest: RunSummary | undefined;
  for (const run of runs) {
    if (run.kind !== kind) {
      continue;
    }
    if (latest === undefined || run.recordedAt > latest.recordedAt) {
      latest = run;
    }
  }
  return latest;
}

function isConformanceReport(value: unknown): value is ConformanceReportShape {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['overallScore'] === 'number' &&
    typeof record['ready'] === 'boolean' &&
    typeof record['threshold'] === 'number'
  );
}

function isLadderResult(value: unknown): value is LadderResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const rungs = (value as Record<string, unknown>)['rungs'];
  return Array.isArray(rungs);
}

/** Finds every LadderResult-shaped value in a benchmark run's payload — the
 * payload itself if it's a single ladder, or any of its top-level
 * properties (demo.ts saves `{ v1, v2, registry }`, only two of which are
 * ladders). */
function findLadders(payload: unknown): ReadonlyArray<{ readonly label: string; readonly ladder: LadderResult }> {
  if (isLadderResult(payload)) {
    return [{ label: '결과', ladder: payload }];
  }
  if (typeof payload !== 'object' || payload === null) {
    return [];
  }
  const found: Array<{ label: string; ladder: LadderResult }> = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (isLadderResult(value)) {
      found.push({ label: key, ladder: value });
    }
  }
  return found;
}

function renderOnboardingSection(runs: readonly RunSummary[], store: RunStore, gameId: string): string[] {
  const lines = ['## 온보딩 상태', ''];
  const latest = latestOfKind(runs, 'conformance');
  if (latest === undefined) {
    lines.push('아직 온보딩 채점 안 됨.', '');
    return lines;
  }
  const loaded = store.loadRun(gameId, latest.runId);
  if (isConformanceReport(loaded.payload)) {
    lines.push(
      `overallScore=${loaded.payload.overallScore} / ${loaded.payload.threshold}, ready=${loaded.payload.ready ? 'yes' : 'no'} (run: ${latest.runId}, recordedAt: ${latest.recordedAt})`,
      '',
    );
  } else {
    lines.push(`최근 conformance run(${latest.runId})의 payload 형식을 인식할 수 없음.`, '');
  }
  return lines;
}

function renderBaselineSection(rootDir: string, gameId: string): string[] {
  const lines = ['## 기준선 이력', ''];
  const registry = loadOrCreateRegistry(rootDir, gameId);
  const latest = registry.latest();
  if (latest === undefined) {
    lines.push('등록된 기준선 버전 없음.', '');
  } else {
    const chain = registry.lineage(latest.version);
    lines.push('버전 계보 (oldest → latest):', '');
    for (const version of chain) {
      const flags = version.flags.length > 0 ? version.flags.join('+') : '(no flags)';
      lines.push(`- ${version.version}: flags=[${flags}]`);
    }
    lines.push('');
  }
  const anchors = registry.listAnchors();
  if (anchors.length === 0) {
    lines.push('등록된 벤치마크 앵커 없음.', '');
  } else {
    lines.push('벤치마크 앵커:', '');
    for (const anchor of anchors) {
      const suffix = anchor.kind === 'baseline' ? ` (baseline ${anchor.baselineVersion})` : '';
      lines.push(`- ${anchor.anchorId}: ${anchor.kind}${suffix}`);
    }
    lines.push('');
  }
  return lines;
}

function renderAdoptionSection(
  rootDir: string,
  gameId: string,
  options: GameSummaryOptions | undefined,
): { readonly lines: string[]; readonly nearMissCandidates: readonly NearMissCandidate[] } {
  const lines = ['## 채택 이력 요약', ''];
  const ledger = loadOrCreateLedger(rootDir, gameId);
  const records = ledger.all();
  if (records.length === 0) {
    lines.push('아직 기록된 웨이브 없음.', '');
    return { lines, nearMissCandidates: [] };
  }

  let adopted = 0;
  let nearMiss = 0;
  let failed = 0;
  for (const record of records) {
    for (const entry of record.entries) {
      if (entry.verdict === 'adopted') {
        adopted += 1;
      } else if (entry.verdict === 'near-miss') {
        nearMiss += 1;
      } else {
        failed += 1;
      }
    }
  }
  lines.push(
    `총 ${records.length}개 웨이브 기록 — 후보 합계: 채택 ${adopted}, 근접실패 ${nearMiss}, 실패/선별 ${failed}.`,
    '',
  );

  const latestRecord = records[records.length - 1];
  let nearMissCandidates: readonly NearMissCandidate[] = [];
  if (latestRecord !== undefined && options?.latestWaveCriteria !== undefined) {
    nearMissCandidates = extractNearMissCandidates(latestRecord, options.latestWaveCriteria);
    if (nearMissCandidates.length === 0) {
      lines.push(`가장 최근 웨이브(${latestRecord.waveId})에는 근접실패 후보 없음.`, '');
    } else {
      lines.push(
        `가장 최근 웨이브(${latestRecord.waveId})의 근접실패 후보 (gap 작은 순):`,
        '',
        '| flags | failedAtTier | winRateGap | scoreDiffGap |',
        '|---|---|---|---|',
      );
      for (const candidate of nearMissCandidates) {
        const flags = candidate.flags.length > 0 ? candidate.flags.join('+') : '(no flags)';
        lines.push(
          `| ${flags} | ${candidate.failedAtTier} | ${candidate.gap.winRateGap.toFixed(4)} | ${candidate.gap.scoreDiffGap.toFixed(4)} |`,
        );
      }
      lines.push('');
    }
  } else if (latestRecord !== undefined) {
    const latestNearMissCount = latestRecord.entries.filter((entry) => entry.verdict === 'near-miss').length;
    lines.push(
      `가장 최근 웨이브(${latestRecord.waveId})의 근접실패 후보 수: ${latestNearMissCount} (latestWaveCriteria 미지정 — 표는 생략).`,
      '',
    );
  }

  return { lines, nearMissCandidates };
}

function renderBenchmarkSection(runs: readonly RunSummary[], store: RunStore, gameId: string): string[] {
  const lines = ['## 벤치마크 사다리', ''];
  const latest = latestOfKind(runs, 'benchmark');
  if (latest === undefined) {
    lines.push('아직 벤치마크 없음.', '');
    return lines;
  }
  const loaded = store.loadRun(gameId, latest.runId);
  const ladders = findLadders(loaded.payload);
  if (ladders.length === 0) {
    lines.push(`최근 benchmark run(${latest.runId})의 payload에서 LadderResult를 찾지 못함.`, '');
    return lines;
  }
  lines.push(`run: ${latest.runId} (recordedAt: ${latest.recordedAt})`, '');
  for (const { label, ladder } of ladders) {
    lines.push(`### ${label}`, '', renderLadderMarkdown(ladder));
  }
  return lines;
}

export function renderGameSummaryMarkdown(
  rootDir: string,
  gameId: string,
  options?: GameSummaryOptions,
): string {
  const store = new RunStore(rootDir);
  const runs = store.listRuns().filter((run) => run.gameId === gameId);

  const lines: string[] = [`# 게임 요약: ${gameId}`, ''];
  lines.push(...renderOnboardingSection(runs, store, gameId));
  lines.push(...renderBaselineSection(rootDir, gameId));
  const adoption = renderAdoptionSection(rootDir, gameId, options);
  lines.push(...adoption.lines);
  lines.push(...renderBenchmarkSection(runs, store, gameId));

  lines.push('## 다음 할 일', '');
  const nextSteps: string[] = [];
  if (adoption.nearMissCandidates.length > 0) {
    nextSteps.push('근접실패 후보가 있음 — DESIGN.md §6.1 절차대로 재설계 후보를 추가하라.');
  }
  const latestConformance = latestOfKind(runs, 'conformance');
  if (latestConformance !== undefined) {
    const loaded = store.loadRun(gameId, latestConformance.runId);
    if (isConformanceReport(loaded.payload) && !loaded.payload.ready) {
      nextSteps.push('conformance 리포트의 blocker를 먼저 해결하라.');
    }
  }
  if (nextSteps.length === 0) {
    lines.push('(없음)');
  } else {
    for (const step of nextSteps) {
      lines.push(`- ${step}`);
    }
  }
  lines.push('');

  return lines.join('\n').trimEnd() + '\n';
}
