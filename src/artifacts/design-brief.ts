/**
 * Design brief assembler (docs/GAP-ANALYSIS-11.md D5.5 step 3): collects
 * every persisted artifact a big-loop round produces for one game — the
 * GameProfile summary, adoption/near-miss history, LossReport, probe bank
 * stats, anchor ladder gates, and the axis matrix (docs/GAP-ANALYSIS-11.md
 * D6, supplied by the caller — the axis matrix document stays the source of
 * truth, this module only formats whatever snapshot it's handed) — into one
 * markdown document for the next round's B2/B3/B4 design work.
 *
 * Every section is read defensively: a missing artifact degrades that
 * section to an explicit "산출물 없음" line instead of throwing, because a
 * design round with partial evidence is still useful — the header's
 * evidence-level line already tells the reader how much to trust the rest
 * (docs/GAP-ANALYSIS-11.md §6 risk mitigation).
 *
 * Holdout guard: registry.json's `anchors` entries carry a `role` field
 * ('feedback' | 'holdout'). anchor-ladder.json's `l3*`-prefixed fields
 * measure whichever anchor `l3AnchorId` names — in this repo that is always
 * the L3 (role: 'holdout') anchor, so those fields are stripped before
 * rendering unless the registry positively confirms `l3AnchorId` is a
 * `role: 'feedback'` anchor. Missing/ambiguous registry data strips by
 * default (fail safe, not fail open) — L3 exists only to measure post-hoc
 * transcendence (docs/GAP-ANALYSIS-11.md Phase 4), never to steer design.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AxisMatrixRow {
  readonly axis: string;
  readonly status: string;
  readonly note?: string;
}

export interface DesignBriefEvidence {
  readonly title: string;
  readonly body: string;
}

export interface DesignBriefInput {
  readonly gameId: string;
  /** Root directory to resolve `runs/<gameId>/...` artifacts under. */
  readonly rootDir: string;
  readonly axisMatrix: readonly AxisMatrixRow[];
  readonly extraEvidence?: readonly DesignBriefEvidence[];
}

const BUCKET_TABLE = [
  ['B1-exploit', '챔피언·near-miss 파라미터 변형(예산/uctC/priorWeight 스윕, 플래그 재조합)', '기계 생성(LLM 0)', '25%'],
  ['B2-opponent', 'LossReport·프로브 불일치 상위 결정지점을 겨냥한 설계', 'Sonnet', '25%'],
  ['B3-deep', '이 브리프 전체를 읽고 집중 설계 1~2개(자연어 명세+의사코드)', 'Opus', '15%'],
  ['B4-explore', '축 매트릭스 미시도 축 + 행동 지문이 챔피언과 최대 거리인 후보', 'Sonnet(+기계 변형)', '25%'],
  ['B5-imitate', '앵커 행동 클로닝, 타 게임 성공 패턴 이식', 'Sonnet', '10%'],
] as const;

function gameDir(rootDir: string, gameId: string): string {
  return join(rootDir, 'runs', gameId);
}

function readJsonIfExists(path: string): unknown | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function readTextIfExists(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  return readFileSync(path, 'utf8');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function formatPercent(value: unknown): string {
  return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '-';
}

// --- Holdout guard -----------------------------------------------------

function feedbackAnchorIds(registry: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  const record = asRecord(registry);
  const anchors = record ? asArray(record['anchors']) : undefined;
  if (!anchors) {
    return ids;
  }
  for (const entry of anchors) {
    const anchor = asRecord(entry);
    const anchorId = anchor?.['anchorId'];
    if (anchor?.['role'] === 'feedback' && typeof anchorId === 'string') {
      ids.add(anchorId);
    }
  }
  return ids;
}

/** Strips every `l3*`-prefixed key from `ladder` unless the registry
 * positively confirms `ladder.l3AnchorId` is a role:'feedback' anchor. */
export function stripHoldoutLadderFields(
  ladder: Record<string, unknown>,
  registry: unknown,
): Record<string, unknown> {
  const l3AnchorId = ladder['l3AnchorId'];
  const confirmedFeedback =
    typeof l3AnchorId === 'string' && feedbackAnchorIds(registry).has(l3AnchorId);

  if (confirmedFeedback) {
    return { ...ladder };
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ladder)) {
    if (key.startsWith('l3')) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

// --- Section renderers --------------------------------------------------

function renderHeader(hasLossReport: boolean, hasProbeBank: boolean, probeCount: number): string[] {
  return [
    '# 설계 브리프',
    '',
    `**근거 수준**: LossReport ${hasLossReport ? '있음' : '없음'} · 프로브 은행 ${
      hasProbeBank ? `있음(국면 ${probeCount}개)` : '없음'
    }`,
    '',
  ];
}

function summarizeGate(gate: unknown): string {
  const record = asRecord(gate);
  if (!record) {
    return '-';
  }
  const winRate = formatPercent(record['candidateWinRate']);
  const pass = record['pass'] === true ? 'PASS' : record['pass'] === false ? 'FAIL' : '-';
  return `winRate=${winRate}, ${pass}`;
}

function renderLadderSection(ladder: Record<string, unknown> | undefined): string[] {
  const lines = ['### 앵커 래더 게이트', ''];
  if (!ladder) {
    lines.push('- 산출물 없음(anchor-ladder.json 없음)', '');
    return lines;
  }
  lines.push(`- gate1(L1 vs heuristic): ${summarizeGate(ladder['gate1'])}`);
  lines.push(`- gate2(L1 vs L2): ${summarizeGate(ladder['gate2'])}`);
  const bothPass = ladder['bothPass'];
  lines.push(`- bothPass: ${typeof bothPass === 'boolean' ? String(bothPass) : '-'}`);
  lines.push('');
  return lines;
}

function renderGameSummarySection(
  summaryMd: string | undefined,
  ladder: Record<string, unknown> | undefined,
): string[] {
  const lines = ['## 게임 요약', ''];
  if (summaryMd === undefined) {
    lines.push('- 산출물 없음(summary.md 없음)', '');
  } else {
    lines.push(summaryMd.trimEnd(), '');
  }
  lines.push(...renderLadderSection(ladder));
  return lines;
}

function renderAdoptionSection(ledger: unknown, nearMiss: unknown): string[] {
  const lines = ['## 채택/근접실패 이력', ''];

  const ledgerRecord = asRecord(ledger);
  const records = ledgerRecord ? asArray(ledgerRecord['records']) : undefined;
  if (!records) {
    lines.push('- 산출물 없음(ledger.json 없음)');
  } else {
    let adopted = 0;
    let near = 0;
    let other = 0;
    for (const rawRecord of records) {
      const entries = asArray(asRecord(rawRecord)?.['entries']) ?? [];
      for (const rawEntry of entries) {
        const verdict = asRecord(rawEntry)?.['verdict'];
        if (verdict === 'adopted') {
          adopted += 1;
        } else if (verdict === 'near-miss') {
          near += 1;
        } else {
          other += 1;
        }
      }
    }
    lines.push(
      `- 총 ${records.length}개 웨이브 — 후보 합계: 채택 ${adopted}, 근접실패 ${near}, 실패/선별 ${other}`,
    );
  }

  const nearMissList = asArray(nearMiss);
  if (!nearMissList) {
    lines.push('- 산출물 없음(near-miss.json 없음)');
  } else if (nearMissList.length === 0) {
    lines.push('- 예약된 근접실패 후보 없음(near-miss.json 비어있음)');
  } else {
    lines.push(`- 예약된 근접실패 후보 ${nearMissList.length}개:`);
    for (const raw of nearMissList) {
      const candidate = asRecord(raw);
      const flags = asArray(candidate?.['flags']);
      const flagLabel = flags && flags.length > 0 ? flags.join('+') : '(no flags)';
      const failedAtTier = candidate?.['failedAtTier'];
      const winRateGap = asRecord(candidate?.['gap'])?.['winRateGap'];
      lines.push(
        `  - ${flagLabel} — failedAtTier=${String(failedAtTier ?? '-')}, winRateGap=${
          typeof winRateGap === 'number' ? winRateGap.toFixed(3) : '-'
        }`,
      );
    }
  }
  lines.push('');
  return lines;
}

function renderLossReportSection(lossReport: unknown): string[] {
  const lines = ['## LossReport 요약', ''];
  const record = asRecord(lossReport);
  if (!record) {
    lines.push('- 산출물 없음(challenge-l2/loss-report.json 없음)', '');
    return lines;
  }

  const totalGames = record['totalGames'];
  const candidateLosses = record['candidateLosses'];
  const lossRate =
    typeof totalGames === 'number' && typeof candidateLosses === 'number' && totalGames > 0
      ? candidateLosses / totalGames
      : undefined;
  lines.push(
    `- 패배율: ${lossRate !== undefined ? formatPercent(lossRate) : '-'} (${String(
      candidateLosses ?? '-',
    )}/${String(totalGames ?? '-')})`,
  );

  const histogram = asRecord(record['firstDivergenceDepthHistogram']);
  lines.push('- 첫 분기 깊이 히스토그램:');
  if (!histogram || Object.keys(histogram).length === 0) {
    lines.push('  - (없음)');
  } else {
    for (const [bucket, count] of Object.entries(histogram)) {
      lines.push(`  - ${bucket}: ${String(count)}건`);
    }
  }

  const mismatchByDp = asRecord(record['mismatchRateByDecisionPoint']);
  lines.push('- 결정지점별 불일치율 상위:');
  if (!mismatchByDp || Object.keys(mismatchByDp).length === 0) {
    lines.push('  - (없음)');
  } else {
    const ranked = Object.entries(mismatchByDp)
      .map(([dpId, stats]) => {
        const s = asRecord(stats);
        const decisions = typeof s?.['decisions'] === 'number' ? s['decisions'] : 0;
        const mismatches = typeof s?.['mismatches'] === 'number' ? s['mismatches'] : 0;
        const rate = decisions > 0 ? mismatches / decisions : 0;
        return { dpId, decisions, mismatches, rate };
      })
      .sort((a, b) => b.rate - a.rate);
    for (const entry of ranked) {
      lines.push(
        `  - ${entry.dpId}: ${formatPercent(entry.rate)} (${entry.mismatches}/${entry.decisions})`,
      );
    }
  }
  lines.push('');
  return lines;
}

function renderProbeBankSection(probeBank: unknown): string[] {
  const lines = ['## 프로브 은행 통계', ''];
  const record = asRecord(probeBank);
  const probes = record ? asArray(record['probes']) : undefined;
  if (!probes) {
    lines.push('- 산출물 없음(probe-bank.json 없음)', '');
    return lines;
  }

  const bySourceAnchor = new Map<string, number>();
  for (const raw of probes) {
    const probe = asRecord(raw);
    const sourceAnchorId = probe?.['sourceAnchorId'];
    const key = typeof sourceAnchorId === 'string' ? sourceAnchorId : '(unknown)';
    bySourceAnchor.set(key, (bySourceAnchor.get(key) ?? 0) + 1);
  }

  lines.push(`- 국면 수: ${probes.length}개`);
  lines.push('- 출처 앵커:');
  for (const [anchorId, count] of [...bySourceAnchor.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  - ${anchorId}: ${count}개`);
  }
  lines.push('');
  return lines;
}

function renderAxisMatrixSection(axisMatrix: readonly AxisMatrixRow[]): string[] {
  const lines = ['## 축 매트릭스', ''];
  if (axisMatrix.length === 0) {
    lines.push('- (없음)', '');
    return lines;
  }
  lines.push('| axis | status | note |', '|---|---|---|');
  for (const row of axisMatrix) {
    lines.push(`| ${row.axis} | ${row.status} | ${row.note ?? '-'} |`);
  }
  lines.push('');
  return lines;
}

function renderExtraEvidenceSection(extraEvidence: readonly DesignBriefEvidence[] | undefined): string[] {
  const lines = ['## 추가 증거', ''];
  if (!extraEvidence || extraEvidence.length === 0) {
    lines.push('- (없음)', '');
    return lines;
  }
  for (const evidence of extraEvidence) {
    lines.push(`### ${evidence.title}`, '');
    lines.push(evidence.body.trimEnd(), '');
  }
  return lines;
}

function renderDesignerInstructionsSection(): string[] {
  const lines = ['## 설계자 지시', ''];
  lines.push('버킷 정의(포트폴리오 배분 대상, docs/GAP-ANALYSIS-11.md D5):', '');
  lines.push('| 버킷 | 내용 | 생성 주체·비용 | 초기 비중 |', '|---|---|---|---|');
  for (const [bucket, content, cost, share] of BUCKET_TABLE) {
    lines.push(`| ${bucket} | ${content} | ${cost} | ${share} |`);
  }
  lines.push('');
  lines.push('**홀드아웃 앵커(L3) 정보는 이 브리프에 절대 포함되지 않는다** — L3는');
  lines.push('초월 판정(docs/GAP-ANALYSIS-11.md Phase 4)에만 쓰이고, 설계 입력으로');
  lines.push('유출되면 그 자체가 홀드아웃 규칙 위반이다.');
  lines.push('');
  return lines;
}

/** Assembles one game's design brief markdown from every persisted
 * `runs/<gameId>/` artifact this round has produced, degrading missing
 * artifacts to an explicit "산출물 없음" line rather than throwing. */
export function renderDesignBrief(input: DesignBriefInput): string {
  const dir = gameDir(input.rootDir, input.gameId);

  const summaryMd = readTextIfExists(join(dir, 'summary.md'));
  const registry = readJsonIfExists(join(dir, 'registry.json'));
  const rawLadder = readJsonIfExists(join(dir, 'anchor-ladder.json'));
  const ladder = asRecord(rawLadder);
  const filteredLadder = ladder ? stripHoldoutLadderFields(ladder, registry) : undefined;

  const ledger = readJsonIfExists(join(dir, 'ledger.json'));
  const nearMiss = readJsonIfExists(join(dir, 'near-miss.json'));

  const lossReport = readJsonIfExists(join(dir, 'challenge-l2', 'loss-report.json'));

  const rawProbeBank = readJsonIfExists(join(dir, 'probe-bank.json'));
  const probeBankRecord = asRecord(rawProbeBank);
  const probes = probeBankRecord ? asArray(probeBankRecord['probes']) : undefined;

  const lines: string[] = [];
  lines.push(...renderHeader(lossReport !== undefined, probes !== undefined, probes?.length ?? 0));
  lines.push(...renderGameSummarySection(summaryMd, filteredLadder));
  lines.push(...renderAdoptionSection(ledger, nearMiss));
  lines.push(...renderLossReportSection(lossReport));
  lines.push(...renderProbeBankSection(rawProbeBank));
  lines.push(...renderAxisMatrixSection(input.axisMatrix));
  lines.push(...renderExtraEvidenceSection(input.extraEvidence));
  lines.push(...renderDesignerInstructionsSection());

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
