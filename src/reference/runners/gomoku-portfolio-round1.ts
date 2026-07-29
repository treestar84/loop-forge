/**
 * gomoku-portfolio-round1 — GAP-11 Phase 3-B: the first live run of the
 * portfolio protocol v2 (docs/GAP-ANALYSIS-11.md D5.5, docs/adr/0013) end to
 * end for gomoku, following Phase 3-A's infrastructure (design-brief.ts,
 * portfolio.ts). The point of this round is completing all 6 steps once —
 * adoption success/failure is not the pass/fail bar, finishing the loop is:
 *
 *   1. Design brief (artifacts/design-brief.ts) — assembled and saved to
 *      runs/gomoku/design-brief-round1.md (not read by any other step here;
 *      it is this round's *input artifact* to the humans/agents who design
 *      B2/B3/B4, not something the code re-parses).
 *   2. Portfolio candidate batch — 7 candidates across 4 buckets (B5 skipped
 *      this round, see this file's own note below):
 *        B1-exploit (3, mechanical sweep of Phase 2's mcts4-s256-prior-w16
 *          champion-rollout config): priorWeight 32/64, and priorWeight 16 +
 *          tacticalDepth 2.
 *        B2-opponent (1): an opening-window policy ("중앙 균형 전개" — closest
 *          to board center, ties broken by maximizing distance from every
 *          existing stone) for the game's first `OPENING_WINDOW` stones,
 *          falling through to the Phase 2 prior-w16 champion-rollout engine
 *          afterward — targets the LossReport's own finding that every
 *          recorded loss diverges from L2 within the first 10 moves
 *          (docs/GAP-ANALYSIS-11.md §5.5 Phase 1-E).
 *        B3-deep (2): `gomokuChainEvaluator` (../experiments/gomoku-chain-
 *          evaluator.ts) at priorWeight 16/48 — implements the main loop's
 *          own B3 design spec verbatim (latent free-two/cross-point/defense-
 *          mirror tier below openThree).
 *        B4-explore (1): `gomokuDefensiveEvaluator` (../experiments/gomoku-
 *          defensive-evaluator.ts) at priorWeight 16 — an axis none of
 *          docs/GAP-ANALYSIS-11.md §3 D6's A1-A10 covers: asymmetric
 *          offense/defense weighting (deny-first) in the tree prior.
 *   3. Probe filter — all 7 scored against runs/gomoku/probe-bank.json
 *      (agreement rate) plus a 5-game-per-candidate cost measurement vs L2;
 *      top 4 by agreement rate (cost as tiebreak) advance to the wave.
 *   4. Regular wave — assembleWaveConfig/runWave over the 4 survivors, fresh
 *      non-overlapping seed banks, regression tier opponent = registry
 *      latest (v5)'s composite, challenge measurement against the L1/L2
 *      feedback anchors (holdout L3 is never touched by this file).
 *   5. Verdict + bookkeeping — any 'adopted' candidate promotes registry to
 *      v6; per-bucket BucketOutcome computed and fed through
 *      artifacts/portfolio.ts's `reallocate`, persisted to
 *      runs/gomoku/portfolio-state.json.
 *   6. Everything summarized to runs/gomoku/portfolio-round1.json.
 *
 * B5-imitate is deliberately given 0 candidates this round (recorded as a
 * BucketOutcome with candidates: 0, not silently omitted) — GAP-11 §3 D6's
 * A10 row already records two prior imitation attempts as "실패
 * (주의)" (dominion/janggi rollout cloning both regressed win rate), and this
 * game's own probe bank is seed-forced-opening-specific (built from L2's
 * losses against v5's own opening distribution), so a cloned opening-probe
 * table would not obviously transfer to a genuinely different candidate's
 * move distribution — the main loop's own judgment call, recorded here per
 * this round's completion-report requirement.
 *
 * Fresh seed ranges (game seeds), verified non-overlapping with every prior
 * gomoku runner's own documented range (see gomoku-prior-diagnostic.ts's own
 * doc comment for the full prior list up to 991,000/996,000-997,019):
 *   - probe-filter cost check: 520,000-520,004 (N=5, shared block across all
 *     7 candidates for one comparabilityKey context).
 *   - wave smoke/prune/holdout/regression: 521,000+/522,000+/523,000+/524,000+.
 *   - challenge (L1/L2): 525,000-525,039 (N=40).
 * Bot seed bases (independent space): 988,101 (cost check), 988,301 (challenge).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import type { AnyBotFactory, AnyGameAdapter, PlayerId, StrategyFlagSpec } from '../../contract/types';
import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead } from '../../loop/head-to-head';
import { scoreAgainstProbes, type ProbeScore } from '../../loop/probe-bank';
import { loadProbeBank } from '../../artifacts/trajectory-archive';
import { assembleWaveConfig } from '../../loop/assemble-wave-config';
import { runWave, type WaveChallengeEntry, type WaveReport } from '../../loop/wave-runner';
import { SeedLedger } from '../../kernel/seed-ledger';
import { createRng } from '../../kernel/rng';
import {
  loadOrCreateLedger,
  loadOrCreateRegistry,
  saveLedger,
  saveRegistry,
} from '../../artifacts/game-state';
import { extractNearMissCandidates, type AdoptionEntry } from '../../artifacts/adoption-ledger';
import { renderDesignBrief } from '../../artifacts/design-brief';
import {
  BUCKET_ORDER,
  INITIAL_ALLOCATION,
  loadPortfolioState,
  reallocate,
  savePortfolioState,
  type BucketId,
  type BucketOutcome,
} from '../../artifacts/portfolio';
import { mctsBotFactory, type MctsConfig } from '../../search/mcts';
import { gomokuAdapter, type GomokuMove, type GomokuObservation, type GomokuState } from '../gomoku';
import { gomokuOpusBot } from '../experiments/gomoku-opus-bot';
import { gomokuMidBot } from '../experiments/gomoku-mid-bot';
import { gomokuChainEvaluator } from '../experiments/gomoku-chain-evaluator';
import { gomokuDefensiveEvaluator } from '../experiments/gomoku-defensive-evaluator';
import {
  GOMOKU_CHAMPION_ROLLOUT_FLAGS,
  GOMOKU_MCTS2_S256_HR_CONFIG,
  GOMOKU_MCTS2_S256_HR_FLAG,
  gomokuMctsFlagSpec,
  gomokuMctsFlagSpecFor,
  gomokuMcts2S256CrFlagSpec,
  gomokuMcts2S512CrFlagSpec,
} from './shared/gomoku-mcts-flag';

const GAME_ID = 'gomoku';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const PROBE_SCORE_BOT_SEED_BASE = 975_201; // same base gomoku-loss-mining.ts/-prior-diagnostic.ts use (self-consistency, see probe-bank.ts's doc comment).
const COST_CHECK_SEED_BASE = 520_000;
const COST_CHECK_N = 5;
const COST_CHECK_BOT_SEED_BASE = 988_101;

function now(): string {
  return new Date().toISOString();
}

function seeds(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------
// Step 2: candidate batch (B1/B2/B3/B4 — see file doc comment)
// ---------------------------------------------------------------------

interface RoundCandidate {
  readonly flag: string;
  readonly bucket: BucketId;
  readonly spec: StrategyFlagSpec<unknown, unknown>;
}

function championRolloutPriorConfig(
  bareAdapter: AnyGameAdapter,
  priorWeight: number,
  label: string,
  extra?: Partial<MctsConfig>,
): MctsConfig {
  return {
    simulations: 256,
    uctC: 1.4,
    rolloutCount: 1,
    label,
    rolloutFactory: composeBot(bareAdapter, [...GOMOKU_CHAMPION_ROLLOUT_FLAGS]),
    priorWeight,
    priorSource: 'choiceEvaluator',
    ...extra,
  };
}

/**
 * Widens a gomoku-typed choice evaluator to the erased `MctsConfig.priorEvaluator`
 * signature — `search/mcts.ts` calls this only through `AnyGameAdapter`'s
 * already-erased state/choice types (the same widening `eraseAdapter` performs
 * for every other adapter field), so this is a type-level cast only, never a
 * behavior change.
 */
function erasePriorEvaluator(
  evaluator: (state: GomokuState, player: PlayerId, choices: readonly GomokuMove[]) => readonly number[],
): (state: unknown, player: PlayerId, choices: readonly unknown[]) => readonly number[] {
  return (state, player, choices) => evaluator(state as GomokuState, player, choices as readonly GomokuMove[]);
}

/** B2's opening window (this file's own design — see the file doc comment's LossReport rationale). */
const OPENING_WINDOW = 6;

function chebyshevDistance(a: GomokuMove, b: GomokuMove): number {
  return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
}

/**
 * "중앙 균형 전개" (B2's own design): among legal moves closest to board
 * center, prefer the one that maximizes its minimum distance to every
 * existing stone (spreads development out rather than clustering against a
 * single existing line this early) — final ties broken deterministically by
 * `rng`. Pure function of `observation`/`legal`, reused nowhere else.
 */
function openingPolicyMove(
  observation: GomokuObservation,
  legal: readonly GomokuMove[],
  rng: ReturnType<typeof createRng>,
): GomokuMove {
  const center: GomokuMove = { row: 7, col: 7 };
  let bestCenterDistance = Infinity;
  let centerCandidates: GomokuMove[] = [];
  for (const move of legal) {
    const distance = chebyshevDistance(move, center);
    if (distance < bestCenterDistance) {
      bestCenterDistance = distance;
      centerCandidates = [move];
    } else if (distance === bestCenterDistance) {
      centerCandidates.push(move);
    }
  }
  if (centerCandidates.length === 1) {
    return centerCandidates[0] as GomokuMove;
  }

  const boardSize = Math.sqrt(observation.board.length);
  let bestSpread = -1;
  let spreadCandidates: GomokuMove[] = [];
  for (const move of centerCandidates) {
    let minStoneDistance = Infinity;
    for (let index = 0; index < observation.board.length; index += 1) {
      if (observation.board[index] === 0) {
        continue;
      }
      const row = Math.floor(index / boardSize);
      const col = index % boardSize;
      const distance = chebyshevDistance(move, { row, col });
      if (distance < minStoneDistance) {
        minStoneDistance = distance;
      }
    }
    const spread = minStoneDistance === Infinity ? 0 : minStoneDistance;
    if (spread > bestSpread) {
      bestSpread = spread;
      spreadCandidates = [move];
    } else if (spread === bestSpread) {
      spreadCandidates.push(move);
    }
  }
  if (spreadCandidates.length === 1) {
    return spreadCandidates[0] as GomokuMove;
  }
  return spreadCandidates[rng.nextInt(spreadCandidates.length)] as GomokuMove;
}

/**
 * B2 flag spec: `openingPolicyMove` for the game's first `openingMoves`
 * stones (`observation.moveCount < openingMoves`), then delegates to a
 * `mctsBotFactory(adapter, config)` instance for the rest of the game.
 * `apply()` ignores `base` entirely — same convention as every other MCTS
 * flag spec in ../shared/gomoku-mcts-flag.ts (this candidate builds its own
 * decision from scratch, it does not modulate a base bot's choice).
 */
function gomokuOpeningThenPriorFlagSpec(
  adapter: AnyGameAdapter,
  openingMoves: number,
  config: MctsConfig,
  flag: string,
): StrategyFlagSpec<unknown, unknown> {
  return {
    flag,
    description: `Opening policy (중앙 균형 전개, first ${openingMoves} stones) then prior-MCTS "${config.label}" (docs/GAP-ANALYSIS-11.md Phase 3-B B2); ignores the base bot entirely.`,
    apply: () => (seed) => {
      const rng = createRng(seed).fork('gomoku-opening-policy');
      const engine = mctsBotFactory(adapter, config)(seed);
      return {
        id: `gomoku-opening${openingMoves}-${config.label}-${seed}`,
        decide(decisionPoint, observation, legal) {
          const obs = observation as GomokuObservation;
          if (obs.moveCount < openingMoves) {
            return openingPolicyMove(obs, legal as readonly GomokuMove[], rng);
          }
          return engine.decide(decisionPoint, observation, legal);
        },
      };
    },
  };
}

function buildCandidates(bareAdapter: AnyGameAdapter): readonly RoundCandidate[] {
  const b1: RoundCandidate[] = [
    {
      flag: 'mcts6-s256-prior-w32',
      bucket: 'B1-exploit',
      spec: gomokuMctsFlagSpecFor(
        bareAdapter,
        championRolloutPriorConfig(bareAdapter, 32, 's256-prior-w32'),
        'mcts6-s256-prior-w32',
      ),
    },
    {
      flag: 'mcts6-s256-prior-w64',
      bucket: 'B1-exploit',
      spec: gomokuMctsFlagSpecFor(
        bareAdapter,
        championRolloutPriorConfig(bareAdapter, 64, 's256-prior-w64'),
        'mcts6-s256-prior-w64',
      ),
    },
    {
      flag: 'mcts6-s256-prior-w16-tactical2',
      bucket: 'B1-exploit',
      spec: gomokuMctsFlagSpecFor(
        bareAdapter,
        championRolloutPriorConfig(bareAdapter, 16, 's256-prior-w16-tactical2', { tacticalDepth: 2 }),
        'mcts6-s256-prior-w16-tactical2',
      ),
    },
  ];

  const b2: RoundCandidate[] = [
    {
      flag: 'mcts7-s256-opening6-prior-w16',
      bucket: 'B2-opponent',
      spec: gomokuOpeningThenPriorFlagSpec(
        bareAdapter,
        OPENING_WINDOW,
        championRolloutPriorConfig(bareAdapter, 16, 's256-opening6-prior-w16'),
        'mcts7-s256-opening6-prior-w16',
      ),
    },
  ];

  const chainConfig = (priorWeight: number, label: string): MctsConfig => ({
    simulations: 256,
    uctC: 1.4,
    rolloutCount: 1,
    label,
    rolloutFactory: composeBot(bareAdapter, [...GOMOKU_CHAMPION_ROLLOUT_FLAGS]),
    priorWeight,
    priorEvaluator: erasePriorEvaluator(gomokuChainEvaluator),
  });
  const b3: RoundCandidate[] = [
    {
      flag: 'mcts5-s256-chain-w16',
      bucket: 'B3-deep',
      spec: gomokuMctsFlagSpecFor(bareAdapter, chainConfig(16, 's256-chain-w16'), 'mcts5-s256-chain-w16'),
    },
    {
      flag: 'mcts5-s256-chain-w48',
      bucket: 'B3-deep',
      spec: gomokuMctsFlagSpecFor(bareAdapter, chainConfig(48, 's256-chain-w48'), 'mcts5-s256-chain-w48'),
    },
  ];

  const b4: RoundCandidate[] = [
    {
      flag: 'mcts9-s256-defensive-w16',
      bucket: 'B4-explore',
      spec: gomokuMctsFlagSpecFor(
        bareAdapter,
        {
          simulations: 256,
          uctC: 1.4,
          rolloutCount: 1,
          label: 's256-defensive-w16',
          rolloutFactory: composeBot(bareAdapter, [...GOMOKU_CHAMPION_ROLLOUT_FLAGS]),
          priorWeight: 16,
          priorEvaluator: erasePriorEvaluator(gomokuDefensiveEvaluator),
        },
        'mcts9-s256-defensive-w16',
      ),
    },
  ];

  return [...b1, ...b2, ...b3, ...b4];
}

// ---------------------------------------------------------------------
// Step 3: probe filter
// ---------------------------------------------------------------------

interface ProbeFilterRow {
  readonly flag: string;
  readonly bucket: BucketId;
  readonly probeScore: ProbeScore;
  readonly msPerGame: number;
  readonly advanced: boolean;
}

function runProbeFilter(
  adapter: AnyGameAdapter,
  candidates: readonly RoundCandidate[],
  probes: ReturnType<typeof loadProbeBank>,
): readonly ProbeFilterRow[] {
  const costSeeds = seeds(COST_CHECK_SEED_BASE, COST_CHECK_N);
  const rows: Array<Omit<ProbeFilterRow, 'advanced'>> = [];

  for (const candidate of candidates) {
    const bot = composeBot(adapter, [candidate.flag]);
    const probeScore = scoreAgainstProbes(adapter, bot, probes, PROBE_SCORE_BOT_SEED_BASE);

    const t0 = Date.now();
    const costResult = runHeadToHead(adapter, bot, gomokuOpusBot, costSeeds, COST_CHECK_BOT_SEED_BASE);
    const elapsedMs = Date.now() - t0;
    const msPerGame = costResult.blocks > 0 ? elapsedMs / costResult.blocks : Infinity;

    console.log(
      `  [probe-filter] ${candidate.flag} (${candidate.bucket}): agreement=${pct(probeScore.agreementRate)} ` +
        `(${probeScore.agreements}/${probeScore.probes - probeScore.skipped}, skipped=${probeScore.skipped}) ms/game=${msPerGame.toFixed(0)}`,
    );
    rows.push({ flag: candidate.flag, bucket: candidate.bucket, probeScore, msPerGame });
  }

  const ranked = [...rows].sort((a, b) => {
    if (b.probeScore.agreementRate !== a.probeScore.agreementRate) {
      return b.probeScore.agreementRate - a.probeScore.agreementRate;
    }
    return a.msPerGame - b.msPerGame; // tie-break: cheaper wins
  });
  const advancingFlags = new Set(ranked.slice(0, 4).map((row) => row.flag));

  return rows.map((row) => ({ ...row, advanced: advancingFlags.has(row.flag) }));
}

// ---------------------------------------------------------------------
// Step 4-5: wave + challenge + bookkeeping
// ---------------------------------------------------------------------

function main(): void {
  console.log(`=== gomoku portfolio round 1 (GAP-11 Phase 3-B, ADR-0013) — rootDir=${ROOT_DIR} ===`);

  const bareAdapter = eraseAdapter(gomokuAdapter);

  console.log('1) 설계 브리프 생성');
  const priorDiagnosticEvidence = {
    title: 'Phase 2 트리 prior 진단 요약 (prior-diagnostic.json)',
    body:
      '| 후보 | vsL1 | vsL2 | 프로브 일치율 |\n|---|---|---|---|\n' +
      '| mcts2-s256-cr (prior 없음) | 0.0% | 0.0% | 0.5% |\n' +
      '| prior w=1 | 11.0% | 0.0% | 0.5% |\n' +
      '| prior w=4 | 29.0% | 0.0% | 2.0% |\n' +
      '| prior w=16 | 34.5% | 0.0% | 4.5% |\n\n' +
      'L1 승률 곡선은 w16까지 완전 단조 개선(0→34.5%), L2는 전 구간 0.0%로 무영향 ' +
      '— "무영향" 가설(과적합이 아니라 이 forkAwareness 재표현이 담는 위협 패턴을 L2가 ' +
      '이미 전부 방어)이 B3(잠재 위협 티어)/B4(비대칭 방어 가중치) 설계의 직접 근거.',
  };
  const axisMatrix = [
    { axis: 'A1 탐색 예산', status: '시도(0%)' },
    { axis: 'A2 롤아웃 정책 교체', status: '시도(0%)' },
    { axis: 'A3 전술 프리체크', status: '시도(0%)' },
    { axis: 'A4 루트 오버라이드', status: '시도(0%)' },
    { axis: 'A5 트리 prior (D1+D2)', status: '시도-부분성공', note: 'w16: L1 34.5%, L2 0% 무영향(Phase 2)' },
    { axis: 'A6 상대 정보 기반 설계 (D4)', status: '이번 라운드 시도', note: 'B2 오프닝 정책' },
    { axis: 'A7 오프닝 북 / 정석 테이블', status: '미시도' },
    { axis: 'A8 도메인 전략 재설계', status: '이번 라운드 시도', note: 'B3 잠재 위협 티어' },
    { axis: 'A9 학습(MCCFR/정책 테이블)', status: '부적격(상태공간)' },
    { axis: 'A10 모방/이식 (B5)', status: '이번 라운드 제외', note: '전이성 낮다고 판단 — B5=0 후보' },
    { axis: 'A11 비대칭 공격/방어 가중치', status: '이번 라운드 신설', note: 'B4 신규 탐험' },
  ];
  const brief = renderDesignBrief({
    gameId: GAME_ID,
    rootDir: ROOT_DIR,
    axisMatrix,
    extraEvidence: [priorDiagnosticEvidence],
  });
  mkdirSync(join(ROOT_DIR, 'runs', GAME_ID), { recursive: true });
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'design-brief-round1.md'), brief);
  console.log(`   저장: runs/${GAME_ID}/design-brief-round1.md`);

  console.log('2) 포트폴리오 후보 배치 생성 (B1x3, B2x1, B3x2, B4x1 = 7)');
  const candidates = buildCandidates(bareAdapter);
  for (const candidate of candidates) {
    console.log(`   ${candidate.bucket}: ${candidate.flag}`);
  }

  const adapter = withStrategyFlags(bareAdapter, [
    gomokuMctsFlagSpec(bareAdapter), // mcts-s64 (needed to reconstruct registry v5's baselineFlags composite)
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_HR_CONFIG, GOMOKU_MCTS2_S256_HR_FLAG), // mcts2-s256-hr
    gomokuMcts2S256CrFlagSpec(bareAdapter), // mcts2-s256-cr
    gomokuMcts2S512CrFlagSpec(bareAdapter), // mcts2-s512-cr
    ...candidates.map((candidate) => candidate.spec),
  ]);

  console.log('3) 프로브 필터 (판당 비용 실측 각 5판, 상위 4개 진출)');
  const probeBankPath = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank.json');
  const probes = loadProbeBank(probeBankPath);
  const probeFilterRows = runProbeFilter(adapter, candidates, probes);
  const advancing = probeFilterRows.filter((row) => row.advanced);
  console.log(`   진출: ${advancing.map((row) => row.flag).join(', ')}`);

  console.log('4) 정규 웨이브 (신규 시드 뱅크)');
  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const ledgerStore = loadOrCreateLedger(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined) {
    throw new Error('gomoku-portfolio-round1: registry has no latest baseline — run reference/runners/gomoku.ts first');
  }

  const waveLedger = new SeedLedger();
  const reservedAt = now();
  const SMOKE_MAX = 30;
  const PRUNE_BLOCKS = 15;
  const HOLDOUT_BLOCKS = 15;
  const REGRESSION_BLOCKS = 40;
  waveLedger.reserve({ bankId: 'gomoku-portfolio1-smoke', range: { start: 521_000, end: 521_000 + SMOKE_MAX - 1 }, purpose: 'smoke', reservedAt });
  waveLedger.reserve({ bankId: 'gomoku-portfolio1-prune', range: { start: 522_000, end: 522_000 + PRUNE_BLOCKS - 1 }, purpose: 'prune', reservedAt });
  waveLedger.reserve({ bankId: 'gomoku-portfolio1-holdout', range: { start: 523_000, end: 523_000 + HOLDOUT_BLOCKS - 1 }, purpose: 'holdout', reservedAt });
  waveLedger.reserve({ bankId: 'gomoku-portfolio1-regression', range: { start: 524_000, end: 524_000 + REGRESSION_BLOCKS - 1 }, purpose: 'regression', reservedAt });

  const CHALLENGE_N = 40;
  const CHALLENGE_SEED_BASE = 525_000;
  const CHALLENGE_BOT_SEED_BASE = 988_301;
  const challengeEntries: readonly WaveChallengeEntry[] = [
    { anchorId: 'external-mid-l1', factory: gomokuMidBot as AnyBotFactory, role: 'feedback' },
    { anchorId: 'external-opus-l2', factory: gomokuOpusBot as AnyBotFactory, role: 'feedback' },
  ];

  const waveConfig = {
    ...assembleWaveConfig(adapter, {
      waveId: 'portfolio-round1',
      candidates: advancing.map((row) => ({ flag: row.flag })),
      opponent: 'heuristic',
      ledger: waveLedger,
      recordedAt: now(),
      baselineFlags: latest.flags,
      baselineVersion: latest.version,
      tiers: {
        smoke: { bankId: 'gomoku-portfolio1-smoke', sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 }, maxBlocks: SMOKE_MAX, minBlocks: 5 },
        prune: { bankId: 'gomoku-portfolio1-prune', blocks: PRUNE_BLOCKS },
        holdout: { bankId: 'gomoku-portfolio1-holdout', blocks: HOLDOUT_BLOCKS },
        regression: { bankId: 'gomoku-portfolio1-regression', blocks: REGRESSION_BLOCKS },
      },
      screenProbe: { seeds: [1, 2, 3], botSeedBase: 100 },
    }),
    challenge: {
      entries: challengeEntries,
      seeds: seeds(CHALLENGE_SEED_BASE, CHALLENGE_N),
      botSeedBase: CHALLENGE_BOT_SEED_BASE,
    },
  };

  const report: WaveReport = runWave(adapter, waveConfig);
  for (const result of report.results) {
    console.log(`   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`);
  }

  console.log('5) challenge 결과');
  const challengeTable: Record<string, Record<string, { winRate: number; blocks: number }>> = {};
  for (const entry of report.challengeResult ?? []) {
    challengeTable[entry.anchorId] ??= {};
    (challengeTable[entry.anchorId] as Record<string, { winRate: number; blocks: number }>)[entry.subject] = {
      winRate: entry.winRate,
      blocks: entry.blocks,
    };
    console.log(`   ${entry.anchorId} vs ${entry.subject}: winRate=${pct(entry.winRate)} blocks=${entry.blocks}`);
  }

  console.log('6) adoption ledger 기록');
  const entries: AdoptionEntry[] = report.results.map((result) => {
    const tierStats: AdoptionEntry['tierStats'] = {};
    for (const tier of ['screen', 'smoke', 'prune', 'holdout', 'regression'] as const) {
      const stats = result.stats[tier];
      if (stats) {
        tierStats[tier] = {
          pointWinRate: stats.pointWinRate,
          pointScoreDiff: stats.pointScoreDiff,
          blocks: stats.blocks,
          ...(stats.drawRate !== undefined ? { drawRate: stats.drawRate } : {}),
          ...(stats.winRateCI !== undefined ? { winRateCI: stats.winRateCI } : {}),
        };
      }
    }
    const isNoOp = result.tiersPassed.length === 0 && result.stats.smoke === undefined;
    return {
      flags: result.flags,
      verdict: isNoOp ? 'screened-out' : result.verdict,
      tierStats,
      ...(isNoOp ? { failureReason: 'behavioral no-op (screened out before any games)' } : {}),
    };
  });
  const adoptionRecord = ledgerStore.add({
    waveId: report.waveId,
    recordedAt: now(),
    comparabilityKey: report.comparabilityKey,
    baselineVersion: latest.version,
    opponentId: waveConfig.opponent,
    entries,
    nextLoopNotes: [],
  });

  const nearMiss = extractNearMissCandidates(adoptionRecord, waveConfig.criteria);
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'near-miss.json'), JSON.stringify(nearMiss, null, 2));

  console.log('7) registry 승격 (채택 있으면)');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  let promotedVersion: string | null = null;
  if (adoptedFlags.length > 0) {
    const lineage = registry.lineage(latest.version);
    const nextVersion = registry.register({
      version: `v${lineage.length + 1}`,
      flags: [...latest.flags, ...adoptedFlags],
      parent: latest.version,
      createdAt: now(),
      sourceWaveId: report.waveId,
      notes: `portfolio-round1에서 채택된 플래그 승격: ${adoptedFlags.join(', ')}`,
    });
    promotedVersion = nextVersion.version;
    console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
  } else {
    console.log('   채택된 후보 없음 — 승격 없음');
  }
  saveRegistry(ROOT_DIR, GAME_ID, registry);
  saveLedger(ROOT_DIR, GAME_ID, ledgerStore);

  console.log('8) 버킷 수율 계산 + 재배분');
  const baselineL2WinRate = challengeTable['external-opus-l2']?.['baseline']?.winRate ?? 0;
  const verdictByFlag = new Map(report.results.map((result) => [result.flag, result.verdict]));

  const bucketOutcomes: BucketOutcome[] = BUCKET_ORDER.map((bucket) => {
    const bucketCandidates = candidates.filter((candidate) => candidate.bucket === bucket);
    const bucketAdvancing = bucketCandidates.filter((candidate) =>
      advancing.some((row) => row.flag === candidate.flag),
    );
    const adopted = bucketAdvancing.filter((candidate) => verdictByFlag.get(candidate.flag) === 'adopted').length;

    const deltas = bucketAdvancing
      .map((candidate) => challengeTable['external-opus-l2']?.[candidate.flag]?.winRate)
      .filter((winRate): winRate is number => winRate !== undefined)
      .map((winRate) => winRate - baselineL2WinRate);
    const challengeDelta = deltas.length > 0 ? deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length : 0;

    return { bucket, candidates: bucketCandidates.length, adopted, challengeDelta };
  });
  for (const outcome of bucketOutcomes) {
    console.log(
      `   ${outcome.bucket}: candidates=${outcome.candidates} adopted=${outcome.adopted} challengeDelta=${outcome.challengeDelta.toFixed(4)}`,
    );
  }

  const currentAllocation = loadPortfolioState(ROOT_DIR, GAME_ID) ?? INITIAL_ALLOCATION;
  const nextAllocation = reallocate(currentAllocation, bucketOutcomes);
  savePortfolioState(ROOT_DIR, GAME_ID, nextAllocation);
  console.log('   재배분 결과:');
  for (const entry of nextAllocation) {
    console.log(`     ${entry.bucket}: ${(entry.share * 100).toFixed(1)}%`);
  }

  console.log('9) runs/gomoku/portfolio-round1.json 저장');
  const summary = {
    gameId: GAME_ID,
    generatedAt: now(),
    designBriefPath: `runs/${GAME_ID}/design-brief-round1.md`,
    probeFilter: probeFilterRows.map((row) => ({
      flag: row.flag,
      bucket: row.bucket,
      agreementRate: row.probeScore.agreementRate,
      probesScored: row.probeScore.probes - row.probeScore.skipped,
      probesSkipped: row.probeScore.skipped,
      msPerGame: row.msPerGame,
      advanced: row.advanced,
    })),
    wave: {
      waveId: report.waveId,
      comparabilityKey: report.comparabilityKey,
      results: report.results.map((result) => ({
        flag: result.flag,
        verdict: result.verdict,
        tiersPassed: result.tiersPassed,
      })),
    },
    challenge: challengeTable,
    adoption: { promotedVersion, adoptedFlags },
    bucketOutcomes,
    portfolioAllocation: { previous: currentAllocation, next: nextAllocation },
    excludedBuckets: {
      'B5-imitate': '이번 라운드 0 후보 — 프로브 은행이 시드-강제 오프닝 특성상 전이성이 낮다고 판단(메인 루프 결정, 이 파일 상단 doc comment 참고).',
    },
  };
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round1.json'), JSON.stringify(summary, null, 2));
  console.log(`   저장: runs/${GAME_ID}/portfolio-round1.json`);
}

main();
