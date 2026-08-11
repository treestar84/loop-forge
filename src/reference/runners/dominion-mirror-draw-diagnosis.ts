/**
 * dominion-mirror-draw-diagnosis — GAP-11 순수 진단 러너(main-loop design spec:
 * scratchpad/dominion-mirror-draw-diagnosis-design-spec.md). 도미니언은 4회전째
 * 채택 후보 0개(v6=v5, no-op 승격, docs/GAP-11-ROUNDS.md "도미니언 4회전")고,
 * v6 vs L2 실측이 33.5%(N=100 채굴)~41.3%(N=40 challenge)로 명백한 격차(오목·
 * 하스스톤의 0.5 근접실패와 다름)라 E9(대규모 재확증)는 부적합하다. 4회전
 * 문서가 남긴 미해결 질문 — "남은 격차가 결정 품질이 아니라 무승부로 수렴하는
 * 국면 구조에 있을 가능성" — 을, A4/A6/A9 같은 본격 설계 라운드 착수 전에
 * 저렴하게 먼저 점검한다. **새 전략/평가함수를 설계하지 않는다** — 기존
 * `mineLosses`/`mineDraws`(loop/loss-mining.ts)를 새 시드 뱅크에서 재사용하는
 * 순수 측정 스크립트다.
 *
 * 측정 1(거울 손실): dominion-loss-mining-round4.ts의 "측정 1"과 완전히 동일한
 * 방식(v6 vs L2, 완전한 트래젝토리 수집)으로 새 시드 뱅크에서 N=100 재생.
 * 거울 손실의 정확한 정의는 gomoku-loss-mining-round4.ts/gomoku-design-brief-
 * round4.ts(오목 4회전 "패배의 42%는 거울 손실")를 그대로 재현한 것이다:
 * `mineLosses`를 anchorFactory=L2 자신(dominionOpusBot)으로 호출하면(오목처럼
 * "L2라면 어떻게 뒀을까"를 실제 L2 자신과 비교하는 것이므로 앵커=상대와 동일
 * 정책이 되어) divergences 배열의 각 항목은 (gameSeed, decisionIndex) 쌍으로
 * 특정 패배판에 속한다. 거울 손실 = divergences에 **전혀** 기여하지 않는
 * 패배판의 수(= candidateLosses - divergences에 등장하는 고유 gameSeed 수) —
 * gomoku-design-brief-round4.ts의 "candidateLosses=62 중 divergences가 1건
 * 이상 있는 게임은 36개뿐 — 나머지 26개(42%)는 거울 손실" 계산을 그대로
 * 재현한 것.
 *
 * 측정 2(무승부 구조): 같은 트래젝토리에 `mineDraws`를 적용해 DrawReport의
 * 기존 필드(gameLengthHistogram, first/lastDivergenceDepthHistogram)를 그대로
 * 소비한다 — 오목 5회전 방법론(마지막 의미있는 분기 시점의 분포, "죽은 구간"
 * 비율)의 도미니언식 재해석: lastDivergenceDepthHistogram이 game length 대비
 * 어디에 몰리는지("죽은 구간" = lastDivergenceDepth 이후 남은 결정 수)를
 * 추가로 집계한다(DrawReport가 제공하지 않는 유일한 파생 지표).
 *
 * Seeds: fresh, disjoint from every prior dominion-loss-mining*.ts range
 * (400/401k, 420/421k, 429-431k, 439-441k) and every dominion-portfolio-*.ts
 * range (700/710/715/720/725/726/727/730/735/736/737/740/741/745/746/747k)
 * and the anchor ladder's 992k/993k/998k/999k — this file uses 450,000+.
 * Bot-seed bases: a fresh 996_1xx/996_2xx block, distinct from every prior
 * dominion base (982_1xx, 985_1xx, 986_1xx-986_3xx, 987_1xx-987_3xx,
 * 988_1xx-988_3xx, 989_1xx-989_7xx, 990_1xx-990_3xx, 991_1xx-991_7xx,
 * 994_1xx-994_3xx, 995_1xx-995_7xx).
 *
 * 코드/게임 로직 변경 없음 — 신규 러너 1개 추가뿐이며 loss-mining.ts/
 * dominion.ts 등 기존 코드는 건드리지 않는다. 결과를 근거로 새 설계 라운드에
 * 그 자리에서 착수하지 않는다 — 다음 라운드 착수 여부는 메인 루프의 판단.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { mineDraws, mineLosses, type DrawReport, type LossReport } from '../../loop/loss-mining';
import type { MatchTrajectoryRecord } from '../../loop/paired-match';
import { loadOrCreateRegistry } from '../../artifacts/game-state';
import { saveTrajectories } from '../../artifacts/trajectory-archive';
import { dominionAdapter } from '../dominion';
import { dominionOpusBot } from '../experiments/dominion-opus-bot';
import { dominionIsmctsV2BuyPriorFlagSpec, DOMINION_V5_CHAMPION_FLAG } from './shared/dominion-round4-candidates';

const GAME_ID = 'dominion';
const CANDIDATE_FLAG = DOMINION_V5_CHAMPION_FLAG;
const EXPECTED_REGISTRY_VERSION = 'v6';
const L2_ANCHOR_ID = 'external-opus-l2';

const N = 100;
const SEED_BASE_M1 = 450_000;

const BOT_SEED_BASE = {
  m1: 996_101,
  mine: 996_201,
} as const;

function seeds(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function ci(result: HeadToHeadResult): string {
  return `${pct(result.winRateCI.lower)}-${pct(result.winRateCI.upper)}`;
}

/** Same bucketing convention as loop/loss-mining.ts's internal depthBucket
 * (width 10, e.g. "0-9"). Reimplemented here only to bucket the *derived*
 * "dead zone length" metric (gameLength - lastDivergenceDepth), which
 * DrawReport does not already provide. */
function depthBucket(n: number): string {
  const bucketStart = Math.floor(n / 10) * 10;
  return `${bucketStart}-${bucketStart + 9}`;
}

/**
 * Mirror-loss ratio (오목 4회전 "거울 손실" 정의의 도미니언 재현): among the
 * candidate's lost games in `records`, how many contribute zero entries to
 * `lossReport.divergences`? A lost game with zero divergences means the
 * candidate agreed with the anchor (L2 itself, passed as `mineLosses`'s
 * anchorFactory) at every one of its own decisions yet still lost — a
 * structural (not decision-quality) loss.
 */
function mirrorLossRatio(
  records: readonly MatchTrajectoryRecord[],
  lossReport: LossReport,
): { mirrorLosses: number; divergentLosses: number; candidateLosses: number; ratio: number } {
  const gameSeedsWithDivergence = new Set(lossReport.divergences.map((d) => d.gameSeed));
  const lostGameSeeds = records
    .filter((r) => r.outcome.winner !== null && r.outcome.winner !== r.candidateSeat)
    .map((r) => r.gameSeed);
  const candidateLosses = lostGameSeeds.length;
  const divergentLosses = lostGameSeeds.filter((seed) => gameSeedsWithDivergence.has(seed)).length;
  const mirrorLosses = candidateLosses - divergentLosses;
  return {
    mirrorLosses,
    divergentLosses,
    candidateLosses,
    ratio: candidateLosses > 0 ? mirrorLosses / candidateLosses : 0,
  };
}

/**
 * "죽은 구간" 비율(오목 5회전 방법론의 도미니언 재해석): 무승부판마다
 * (record.choices.length - lastDivergenceDepth)를 구해, "마지막으로 후보가
 * L2 자신과 갈렸던 지점 이후 게임이 끝날 때까지 얼마나 더 진행됐는가"를
 * 히스토그램으로 집계한다. lastDivergenceDepthHistogram(DrawReport 기존
 * 필드)이 "안착 지점이 어디인가"를 답한다면, 이 파생 지표는 "안착 이후
 * 얼마나 오래 결정 무관하게 소진됐는가"를 답한다 — DrawReport가 직접
 * 제공하지 않는 유일한 파생치라 여기서만 추가 계산한다(mineDraws 로직
 * 자체는 재구현하지 않음).
 */
function deadZoneHistogram(
  records: readonly MatchTrajectoryRecord[],
  drawReport: DrawReport,
): { histogram: Record<string, number>; drawsWithDivergence: number; drawsWithoutDivergence: number } {
  const lastDivergenceByGameSeed = new Map<number, number>();
  for (const d of drawReport.divergences) {
    const prev = lastDivergenceByGameSeed.get(d.gameSeed);
    if (prev === undefined || d.decisionIndex > prev) {
      lastDivergenceByGameSeed.set(d.gameSeed, d.decisionIndex);
    }
  }

  const histogram: Record<string, number> = {};
  let drawsWithDivergence = 0;
  let drawsWithoutDivergence = 0;

  for (const record of records) {
    if (record.outcome.winner !== null) continue; // not a draw
    const lastDivergence = lastDivergenceByGameSeed.get(record.gameSeed);
    if (lastDivergence === undefined) {
      drawsWithoutDivergence += 1;
      continue;
    }
    drawsWithDivergence += 1;
    const deadZoneLength = record.choices.length - lastDivergence;
    const bucket = depthBucket(deadZoneLength);
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }

  return { histogram, drawsWithDivergence, drawsWithoutDivergence };
}

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const bareAdapter = eraseAdapter(dominionAdapter);
  const adapter = withStrategyFlags(bareAdapter, [dominionIsmctsV2BuyPriorFlagSpec(bareAdapter)]);

  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const l2Anchor = registry.getAnchor(L2_ANCHOR_ID);
  if (!l2Anchor) {
    throw new Error(
      `dominion-mirror-draw-diagnosis: anchor "${L2_ANCHOR_ID}" is not registered — run dominion-anchor-ladder.ts first`,
    );
  }

  const latest = registry.latest();
  console.log(`=== dominion 거울 손실·무승부 구조 진단 (GAP-11, 순수 분석 — 새 전략 설계 없음) ===`);
  console.log(
    `  registry latest: ${latest?.version ?? '(none)'} flags=[${latest?.flags.join(', ') ?? ''}] — ` +
      `진단 대상은 이 챔피언 자신('${CANDIDATE_FLAG}').`,
  );
  if (latest?.version !== EXPECTED_REGISTRY_VERSION) {
    console.warn(
      `  경고: registry latest=${latest?.version ?? '(none)'} (${EXPECTED_REGISTRY_VERSION} 예상과 다름) — 계속 진행하되 결과 해석 시 comparabilityKey 확인 필요`,
    );
  }

  const candidateBot = composeBot(adapter, [CANDIDATE_FLAG]);
  const opusBot = dominionOpusBot;

  const outDir = join(rootDir, 'runs', GAME_ID, 'mirror-draw-diagnosis');
  mkdirSync(outDir, { recursive: true });

  // --- Measurement: candidate(v6) vs L2, full trajectory collection ---
  const t0 = Date.now();
  console.log(`  측정) ${CANDIDATE_FLAG} vs L2(opus) N=${N} seedBase=${SEED_BASE_M1} …`);
  const records: MatchTrajectoryRecord[] = [];
  const m1 = runHeadToHead(adapter, candidateBot, opusBot, seeds(SEED_BASE_M1, N), BOT_SEED_BASE.m1, {
    trajectoryCollector: (record) => records.push(record),
  });
  const t1 = Date.now();
  console.log(
    `     winRate=${pct(m1.candidateWinRate)} CI=${ci(m1)} draw/split=${pct(m1.drawRate)} blocks=${m1.blocks} trajectories=${records.length} (${((t1 - t0) / 1000).toFixed(1)}s)`,
  );

  const trajectoriesPath = saveTrajectories(outDir, records, l2Anchor);
  console.log(`  저장: ${trajectoriesPath}`);

  // --- Diagnosis 1: mirror-loss ratio (mineLosses, anchorFactory = L2 self) ---
  const lossReport: LossReport = mineLosses(adapter, records, opusBot, { anchorSeedBase: BOT_SEED_BASE.mine });
  const lossReportPath = join(outDir, 'loss-report.json');
  writeFileSync(lossReportPath, JSON.stringify(lossReport, null, 2));
  console.log(`  저장: ${lossReportPath}`);

  const mirrorLoss = mirrorLossRatio(records, lossReport);
  console.log(
    `  LossReport: totalGames=${lossReport.totalGames} candidateLosses=${lossReport.candidateLosses} divergences=${lossReport.divergences.length}`,
  );
  console.log(`  패배판 첫 분기 깊이 히스토그램: ${JSON.stringify(lossReport.firstDivergenceDepthHistogram)}`);
  console.log(
    `  [진단 1] 거울 손실: candidateLosses=${mirrorLoss.candidateLosses} 중 divergences 1건 이상=${mirrorLoss.divergentLosses}개, ` +
      `거울 손실(divergences 0건)=${mirrorLoss.mirrorLosses}개 -> 거울 손실 비율=${pct(mirrorLoss.ratio)}`,
  );

  // --- Diagnosis 2: draw structure (mineDraws) ---
  const drawReport: DrawReport = mineDraws(adapter, records, opusBot, { anchorSeedBase: BOT_SEED_BASE.mine });
  const drawReportPath = join(outDir, 'draw-report.json');
  writeFileSync(drawReportPath, JSON.stringify(drawReport, null, 2));
  console.log(`  저장: ${drawReportPath}`);

  const deadZone = deadZoneHistogram(records, drawReport);
  console.log(`  DrawReport: totalGames=${drawReport.totalGames} drawGames=${drawReport.drawGames} divergences=${drawReport.divergences.length}`);
  console.log(`  무승부판 길이 히스토그램: ${JSON.stringify(drawReport.gameLengthHistogram)}`);
  console.log(`  무승부판 첫 분기 깊이 히스토그램: ${JSON.stringify(drawReport.firstDivergenceDepthHistogram)}`);
  console.log(
    `  무승부판 마지막 분기 깊이 히스토그램(안착 지점 근사): ${JSON.stringify(drawReport.lastDivergenceDepthHistogram)}`,
  );
  console.log(
    `  [진단 2] 무승부판 "죽은 구간"(마지막 분기 이후 결정 무관하게 소진된 결정 수) 히스토그램: ${JSON.stringify(deadZone.histogram)} ` +
      `(divergence 있는 무승부=${deadZone.drawsWithDivergence}, 전혀 없는 무승부=${deadZone.drawsWithoutDivergence})`,
  );

  const totalSeconds = (t1 - t0) / 1000;
  console.log(`  총 소요: ${totalSeconds.toFixed(1)}s`);

  const summaryPath = join(outDir, 'diagnosis-summary.json');
  const summary = {
    gameId: GAME_ID,
    generatedAt: new Date().toISOString(),
    candidate: {
      flag: CANDIDATE_FLAG,
      registryLatestVersion: latest?.version ?? null,
      registryLatestFlags: latest?.flags ?? [],
    },
    measurement_candidateVsL2: {
      seedBase: SEED_BASE_M1,
      n: N,
      botSeedBase: BOT_SEED_BASE.m1,
      result: m1,
      trajectoriesRecorded: records.length,
      trajectoriesPath,
      elapsedSeconds: totalSeconds,
    },
    mirrorLossDiagnosis: {
      lossReportPath,
      totalGames: lossReport.totalGames,
      candidateLosses: mirrorLoss.candidateLosses,
      divergentLosses: mirrorLoss.divergentLosses,
      mirrorLosses: mirrorLoss.mirrorLosses,
      mirrorLossRatio: mirrorLoss.ratio,
      firstDivergenceDepthHistogram: lossReport.firstDivergenceDepthHistogram,
    },
    drawStructureDiagnosis: {
      drawReportPath,
      totalGames: drawReport.totalGames,
      drawGames: drawReport.drawGames,
      divergenceCount: drawReport.divergences.length,
      gameLengthHistogram: drawReport.gameLengthHistogram,
      firstDivergenceDepthHistogram: drawReport.firstDivergenceDepthHistogram,
      lastDivergenceDepthHistogram: drawReport.lastDivergenceDepthHistogram,
      deadZoneHistogram: deadZone.histogram,
      drawsWithDivergence: deadZone.drawsWithDivergence,
      drawsWithoutDivergence: deadZone.drawsWithoutDivergence,
    },
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`  저장: ${summaryPath}`);
}

main();
