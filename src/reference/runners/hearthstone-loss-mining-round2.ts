/**
 * hearthstone-loss-mining-round2 — GAP-11 프로토콜 v2 2회전 전반부(재채굴),
 * `hearthstone-loss-mining.ts`(1회전)와 도미니언 round2/round3 채굴 러너의
 * 파일명·구조 관례를 그대로 따른다. 이번 채굴 대상은 registry **v3**
 * (`ismcts-s128-tempo-w4`, portfolio-round1에서 승격 — vs L2 46.3%, N=40)
 * 이며, 1회전과 달리 v2가 아니라 현 챔피언이 상대 L2(외부 Opus봇)에 어디서
 * 갈리는지를 새 시드에서 다시 채굴한다.
 *
 * withStrategyFlags 함정(1회전과 동일 클래스, 이번엔 대상 플래그만 다름):
 * v3의 플래그 `ismcts-s128-tempo-w4`는 하스스톤 어댑터의 정적
 * strategySurface에 없는 동적 플래그(`shared/hearthstone-ismcts-flag.ts`의
 * `hearthstoneIsmctsFlagSpecFor` + `hearthstoneTempoPriorConfig(4, …)`로
 * portfolio-round1이 그때그때 만들어 쓴 것) — composeBot을 bare 어댑터에
 * 바로 걸면 "unknown strategy flag"로 던진다. 반드시 동일한 config로 다시
 * 만들어 withStrategyFlags로 확장한 뒤에만 composeBot을 호출한다(설정이
 * 어긋나면 같은 플래그 이름으로 다르게 행동하는 봇이 조용히 재현된다).
 *
 * 자원 규칙(1회전과 동일): IS-MCTS(s128)+prior라 판당 비용이 크므로,
 * N_TRIAL=5판을 먼저 재고 예상 소요가 30분 예산을 넘으면 N을 N_MIN=60까지
 * 낮춘다.
 *
 * 시드(기존 하스스톤 러너의 문서화된 범위와 전부 비겹침 — 벤치마크
 * 55,000-56,599 / anchor-ladder 994,000+·995,000+·1,000,000+·1,001,000+ /
 * 1회전 채굴 499,000-499,004·500,000-500,099·501,000-501,099 /
 * portfolio-round1 520,000-527,099): 이 파일은 505,000+(사전 타이밍),
 * 506,000+(측정1), 507,000+(측정2)를 쓴다. 봇 시드 베이스는 기존
 * 950_10x/983_10x/986_10x/987_1xx-987_3xx/988_1xx-988_7xx와 겹치지 않는 신규
 * 992_1xx/992_2xx/992_3xx 블록.
 *
 * 프로브 은행: 1회전의 `probe-bank.json`은 건드리지 않고 이번 회전 분기점을
 * 별도 `runs/hearthstone/probe-bank-round2.json`으로 봉인한다(도미니언
 * round2/round3 선례). probeId가 `${gameSeed}-${decisionIndex}`이므로 위의
 * 비겹침 시드 범위가 이미 probeId 충돌을 막는다.
 *
 * 추가 산출(2회전 B2 후보 설계의 입력, 설계 브리프의 "반드시 round2 자체
 * 데이터로 타겟 재선정" 지시): 1회전은 encodeChoice 접두사별 불일치율을
 * 일회성 스크립트로 재고 삭제했지만, 이번에는 같은 집계를 이 러너 안에
 * 넣어 judgment-summary.json에 남긴다 — `scoreAgainstProbes`를 접두사별
 * 부분집합에 그대로 호출하는 방식이라 재현 로직 중복이 없다(
 * `scoreAgainstProbes`의 봇 시드는 `rootRng.fork(gameSeed:decisionIndex)`로
 * 프로브마다 라벨 파생되고 rootRng의 상태는 소비되지 않으므로, 부분집합으로
 * 나눠 채점해도 프로브별 결과가 전체 채점과 동일하다).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { mineLosses, type LossReport } from '../../loop/loss-mining';
import { buildProbeBank, scoreAgainstProbes, type ProbePosition, type ProbeScore } from '../../loop/probe-bank';
import type { MatchTrajectoryRecord } from '../../loop/paired-match';
import { loadOrCreateRegistry } from '../../artifacts/game-state';
import { saveTrajectories, saveProbeBank } from '../../artifacts/trajectory-archive';
import { hearthstoneAdapter } from '../hearthstone';
import { hearthstoneOpusBot } from '../experiments/hearthstone-opus-bot';
import { hearthstoneMidBot } from '../experiments/hearthstone-mid-bot';
import { hearthstoneIsmctsFlagSpecFor, hearthstoneTempoPriorConfig } from './shared/hearthstone-ismcts-flag';

const GAME_ID = 'hearthstone';
const L2_ANCHOR_ID = 'external-opus-l2';
const L1_ANCHOR_ID = 'external-mid-l1';

/** registry v3의 유일한 플래그 (portfolio-round1 승격 결과). */
const CHAMPION_FLAG = 'ismcts-s128-tempo-w4';
const CHAMPION_PRIOR_WEIGHT = 4;
const CHAMPION_LABEL = 's128-tempo-w4';

const N_TRIAL = 5;
const N_TARGET = 100;
const N_MIN = 60;
const BUDGET_MS = 30 * 60 * 1000;

const SEED_BASE_TRIAL = 505_000;
const SEED_BASE_M1 = 506_000;
const SEED_BASE_M2 = 507_000;

const BOT_SEED_BASE = {
  m1: 992_101,
  m2: 992_102,
  mineLosses: 992_201,
  /** mineLosses와 의도적으로 동일 — 자기일치율 재현에 필요(1회전 주석 참조). */
  probeScoreL2: 992_201,
  probeScoreChampion: 992_302,
} as const;

const MAX_PROBES = 200;

function seeds(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function ci(result: HeadToHeadResult): string {
  return `${pct(result.winRateCI.lower)}-${pct(result.winRateCI.upper)}`;
}

/** Top-N decision points by mismatch rate (min 5 decisions) — 1회전과 동일. */
function topMismatchDecisionPoints(
  report: LossReport,
  topN: number,
): Array<{ decisionPointId: string; decisions: number; mismatches: number; mismatchRate: number }> {
  return Object.entries(report.mismatchRateByDecisionPoint)
    .map(([decisionPointId, stats]) => ({
      decisionPointId,
      decisions: stats.decisions,
      mismatches: stats.mismatches,
      mismatchRate: stats.decisions > 0 ? stats.mismatches / stats.decisions : 0,
    }))
    .filter((entry) => entry.decisions >= 5)
    .sort((a, b) => b.mismatchRate - a.mismatchRate)
    .slice(0, topN);
}

/** `encodeChoice` 접두사(`play`/`attack`/`heroPower`/`endTurn`) — 하스스톤
 * 어댑터가 결정지점을 단일 `'action'`으로만 인코딩하기 때문에(1회전 핵심
 * 발견 1), 결정 "종류"는 choice 키 접두사로만 사후 분류할 수 있다. */
function choiceKindOf(choiceKey: string): string {
  const colon = choiceKey.indexOf(':');
  return colon === -1 ? choiceKey : choiceKey.slice(0, colon);
}

interface KindMismatchRow {
  readonly kind: string;
  readonly probes: number;
  readonly scored: number;
  readonly mismatches: number;
  readonly mismatchRate: number;
}

/** 접두사별 부분집합에 scoreAgainstProbes를 그대로 호출해 챔피언의
 * 불일치율을 집계(파일 doc comment의 순서 무관성 논증 참조). */
function mismatchRateByChoiceKind(
  adapter: ReturnType<typeof eraseAdapter>,
  championBot: ReturnType<typeof composeBot>,
  probes: readonly ProbePosition[],
): readonly KindMismatchRow[] {
  const byKind = new Map<string, ProbePosition[]>();
  for (const probe of probes) {
    const kind = choiceKindOf(probe.anchorChoiceKey);
    const bucket = byKind.get(kind) ?? [];
    bucket.push(probe);
    byKind.set(kind, bucket);
  }

  const rows: KindMismatchRow[] = [];
  for (const [kind, subset] of byKind) {
    const score = scoreAgainstProbes(adapter, championBot, subset, BOT_SEED_BASE.probeScoreChampion);
    const scored = score.probes - score.skipped;
    const mismatches = scored - score.agreements;
    rows.push({
      kind,
      probes: subset.length,
      scored,
      mismatches,
      mismatchRate: scored > 0 ? mismatches / scored : 0,
    });
  }
  return rows.sort((a, b) => b.mismatches - a.mismatches);
}

/** 1회전과 동일한 예산 기반 표본 크기 결정. */
function decideSampleSize(
  adapter: ReturnType<typeof eraseAdapter>,
  championBot: ReturnType<typeof composeBot>,
  opusBot: typeof hearthstoneOpusBot,
): { n: number; msPerGame: number; trialElapsedMs: number } {
  const t0 = Date.now();
  const trial = runHeadToHead(adapter, championBot, opusBot, seeds(SEED_BASE_TRIAL, N_TRIAL), BOT_SEED_BASE.m1);
  const trialElapsedMs = Date.now() - t0;
  const games = trial.blocks * 2;
  const msPerGame = games > 0 ? trialElapsedMs / games : Infinity;

  let n = N_TARGET;
  while (n > N_MIN && msPerGame * 2 * n > BUDGET_MS) {
    n = Math.max(N_MIN, n - 10);
  }
  return { n, msPerGame, trialElapsedMs };
}

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const bareAdapter = eraseAdapter(hearthstoneAdapter);
  const championSpec = hearthstoneIsmctsFlagSpecFor(
    bareAdapter,
    hearthstoneTempoPriorConfig(CHAMPION_PRIOR_WEIGHT, CHAMPION_LABEL),
    CHAMPION_FLAG,
    'registry v3 챔피언 재구성 (portfolio-round1 승격): ismcts-s128-hr 예산 + choiceEvaluator 트리 prior(priorWeight=4).',
  );
  const adapter = withStrategyFlags(bareAdapter, [championSpec]);

  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const l2Anchor = registry.getAnchor(L2_ANCHOR_ID);
  const l1Anchor = registry.getAnchor(L1_ANCHOR_ID);
  if (!l2Anchor) {
    throw new Error(`hearthstone-loss-mining-round2: anchor "${L2_ANCHOR_ID}" is not registered`);
  }
  if (!l1Anchor) {
    throw new Error(`hearthstone-loss-mining-round2: anchor "${L1_ANCHOR_ID}" is not registered`);
  }

  const latest = registry.latest();
  if (latest === undefined || latest.version !== 'v3') {
    throw new Error(
      `hearthstone-loss-mining-round2: registry latest=${latest?.version ?? '(none)'} — expected v3 (portfolio-round1의 승격 결과)`,
    );
  }
  if (latest.flags.length !== 1 || latest.flags[0] !== CHAMPION_FLAG) {
    throw new Error(
      `hearthstone-loss-mining-round2: registry v3 flags=[${latest.flags.join(', ')}] — expected [${CHAMPION_FLAG}]`,
    );
  }

  const championBot = composeBot(adapter, latest.flags);
  const opusBot = hearthstoneOpusBot;
  const midBot = hearthstoneMidBot;

  console.log('=== hearthstone loss-mining round 2 (GAP-11 프로토콜 v2 2회전) ===');
  console.log(`  registry latest: ${latest.version} flags=[${latest.flags.join(', ')}] (재채굴 대상 = 현 챔피언)`);

  const outDir = join(rootDir, 'runs', GAME_ID, 'challenge-l2-round2');
  mkdirSync(outDir, { recursive: true });

  console.log(`  사전 타이밍: v3 vs L2 ${N_TRIAL}판 시험 …`);
  const sizing = decideSampleSize(adapter, championBot, opusBot);
  const n = sizing.n;
  console.log(
    `     ms/game=${sizing.msPerGame.toFixed(0)} (trial ${N_TRIAL}판 ${(sizing.trialElapsedMs / 1000).toFixed(1)}s) -> N=${n}` +
      (n < N_TARGET ? ` (budget 축소, 목표 ${N_TARGET}에서 하향)` : ''),
  );

  // --- Measurement 1: v3 vs L2, full trajectory collection ---
  const t0 = Date.now();
  console.log(`  측정 1) v3 챔피언 vs L2(opus) N=${n} seedBase=${SEED_BASE_M1} …`);
  const records: MatchTrajectoryRecord[] = [];
  const m1 = runHeadToHead(adapter, championBot, opusBot, seeds(SEED_BASE_M1, n), BOT_SEED_BASE.m1, {
    trajectoryCollector: (record) => records.push(record),
  });
  const t1 = Date.now();
  console.log(
    `     winRate=${pct(m1.candidateWinRate)} CI=${ci(m1)} draw/split=${pct(m1.drawRate)} blocks=${m1.blocks} trajectories=${records.length} (${((t1 - t0) / 1000).toFixed(1)}s)`,
  );

  const trajectoriesPath = saveTrajectories(outDir, records, l2Anchor);
  console.log(`  저장: ${trajectoriesPath}`);

  const report = mineLosses(adapter, records, opusBot, { anchorSeedBase: BOT_SEED_BASE.mineLosses });
  const lossReportPath = join(outDir, 'loss-report.json');
  writeFileSync(lossReportPath, JSON.stringify(report, null, 2));
  console.log(`  저장: ${lossReportPath}`);

  const topMismatches = topMismatchDecisionPoints(report, 5);
  console.log(
    `  LossReport: totalGames=${report.totalGames} candidateLosses=${report.candidateLosses} divergences=${report.divergences.length}`,
  );
  console.log(`  첫 분기 깊이 히스토그램: ${JSON.stringify(report.firstDivergenceDepthHistogram)}`);
  console.log(
    `  불일치율 상위 결정지점(>=5회): ${topMismatches.map((e) => `${e.decisionPointId}=${pct(e.mismatchRate)}(${e.mismatches}/${e.decisions})`).join(', ') || '(none)'}`,
  );

  // --- Probe bank (round 2, sealed separately from round 1's) ---
  const probes: readonly ProbePosition[] = buildProbeBank(report, records, L2_ANCHOR_ID, { maxProbes: MAX_PROBES });
  const probeBankPath = join(rootDir, 'runs', GAME_ID, 'probe-bank-round2.json');
  saveProbeBank(probeBankPath, probes, l2Anchor);
  console.log(`  저장: ${probeBankPath} (probes=${probes.length}, 1회전 probe-bank.json은 보존)`);

  const l2SelfScore: ProbeScore = scoreAgainstProbes(adapter, opusBot, probes, BOT_SEED_BASE.probeScoreL2);
  const championProbeScore: ProbeScore = scoreAgainstProbes(
    adapter,
    championBot,
    probes,
    BOT_SEED_BASE.probeScoreChampion,
  );
  console.log(
    `  프로브 검증: L2 자기일치율=${pct(l2SelfScore.agreementRate)} (probes=${l2SelfScore.probes}, skipped=${l2SelfScore.skipped}) — 1.0 기대`,
  );
  console.log(
    `  프로브 검증: v3 챔피언 일치율=${pct(championProbeScore.agreementRate)} (probes=${championProbeScore.probes}, skipped=${championProbeScore.skipped})`,
  );

  // --- B2 타깃 재선정용: encodeChoice 접두사별 불일치율 ---
  const kindRows = mismatchRateByChoiceKind(adapter, championBot, probes);
  console.log('  choice 종류별 v3 불일치율 (2회전 B2 후보 타깃 선정 입력):');
  for (const row of kindRows) {
    console.log(`     ${row.kind}: ${pct(row.mismatchRate)} (${row.mismatches}/${row.scored}, probes=${row.probes})`);
  }

  // --- Measurement 2: v3 vs L1, win rate only ---
  const t2 = Date.now();
  console.log(`  측정 2) v3 챔피언 vs L1(mid) N=${n} seedBase=${SEED_BASE_M2} …`);
  const m2 = runHeadToHead(adapter, championBot, midBot, seeds(SEED_BASE_M2, n), BOT_SEED_BASE.m2);
  const t3 = Date.now();
  console.log(
    `     winRate=${pct(m2.candidateWinRate)} CI=${ci(m2)} draw/split=${pct(m2.drawRate)} blocks=${m2.blocks} (${((t3 - t2) / 1000).toFixed(1)}s)`,
  );

  const gradientRestored = m2.candidateWinRate > 0;
  console.log(`  그래디언트 추적: v3 vs L1 winRate=${pct(m2.candidateWinRate)} -> ${gradientRestored ? 'PASS' : 'FAIL'}`);

  const totalSeconds = (t3 - t0) / 1000;
  console.log(`  총 소요: ${totalSeconds.toFixed(1)}s`);

  const summaryPath = join(outDir, 'judgment-summary.json');
  const summary = {
    gameId: GAME_ID,
    round: 2,
    generatedAt: new Date().toISOString(),
    registry: {
      latestVersion: latest.version,
      composedFlags: latest.flags,
    },
    sampleSizing: { n, target: N_TARGET, min: N_MIN, msPerGameTrial: sizing.msPerGame, trialGames: N_TRIAL },
    measurement1_v3VsL2: {
      seedBase: SEED_BASE_M1,
      n,
      botSeedBase: BOT_SEED_BASE.m1,
      result: m1,
      trajectoriesRecorded: records.length,
      trajectoriesPath,
    },
    lossReport: {
      path: lossReportPath,
      totalGames: report.totalGames,
      candidateLosses: report.candidateLosses,
      divergenceCount: report.divergences.length,
      firstDivergenceDepthHistogram: report.firstDivergenceDepthHistogram,
      topMismatchDecisionPoints: topMismatches,
    },
    probeBank: {
      path: probeBankPath,
      probeCount: probes.length,
      l2SelfAgreementRate: l2SelfScore.agreementRate,
      championAgreementRate: championProbeScore.agreementRate,
      mismatchByChoiceKind: kindRows,
    },
    measurement2_v3VsL1: {
      seedBase: SEED_BASE_M2,
      n,
      botSeedBase: BOT_SEED_BASE.m2,
      result: m2,
      gradientRestored,
    },
    elapsedSeconds: totalSeconds,
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`  저장: ${summaryPath}`);
}

main();
