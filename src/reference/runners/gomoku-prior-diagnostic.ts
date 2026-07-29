/**
 * gomoku-prior-diagnostic — GAP-11 Phase 2 judgment experiment (D1+D2,
 * docs/adr/0011-choice-evaluator-tree-prior.md): measures whether
 * `search/mcts.ts`'s new PUCT-style tree prior (`MctsConfig.priorWeight`/
 * `priorSource`, driven by `gomokuAdapter.choiceEvaluator`'s forkAwareness
 * re-expression) actually moves gomoku's win rate against the anchor ladder,
 * not just that it changes root-fixture decisions in isolation
 * (src/search/__tests__/mcts.test.ts already covers that).
 *
 * This is a diagnostic head-to-head sweep, NOT a wave — no gate, no registry
 * write, no adoption. docs/GAP-ANALYSIS-11.md §5 Phase 2 item 4's own success
 * criterion: L2 win rate > 9.0% (pure forkAwareness's un-searched rate,
 * docs/GAP-ANALYSIS-11.md §0) OR a monotone improvement in the L1 win-rate
 * curve across priorWeight — either is a positive signal even if the other
 * doesn't clear; a flat/zero curve on both is itself the informative result
 * this experiment is designed to surface (§5 Phase 2 item 4's own framing:
 * "실패해도 priorWeight-승률 곡선이 브리프 입력이 된다").
 *
 * Candidates (all "champion rollout" — same rolloutFactory as
 * `mcts2-s256-cr`, ../runners/shared/gomoku-mcts-flag.ts):
 *   - `mcts2-s256-cr`      baseline, priorWeight unset (0) — same bot already
 *                          measured at 0.5% vs L1 (docs/GAP-ANALYSIS-11.md §0),
 *                          re-measured here on this file's own fresh seed
 *                          block so the baseline and the candidates share an
 *                          identical comparabilityKey context
 *                          (docs/INTERPRETATION.md 제1규칙).
 *   - `mcts4-s256-prior-w1/4/16`  priorWeight ∈ {1, 4, 16}, priorSource:
 *                          'choiceEvaluator', otherwise identical config.
 *
 * Opponents: L1 (`external-mid-l1` = gomokuMidBot) and L2 (`external-opus-l2`
 * = gomokuOpusBot), N=100 each, per docs/GAP-ANALYSIS-11.md D3's anchor
 * ladder (gomoku-anchor-ladder.ts). Anchor registration is not required to
 * run this diagnostic (it calls the bot factories directly, mirroring
 * gomoku-loss-mining.ts's own direct-import pattern) — the anchor registry's
 * role is the design-feedback/holdout bookkeeping, not a runtime dependency
 * of head-to-head measurement itself.
 *
 * Probe-bank agreement: scored against runs/gomoku/probe-bank.json (built by
 * gomoku-loss-mining.ts from L2 losses) with `BOT_SEED_BASE.probeScore =
 * 975_201` — the exact same seed base gomoku-loss-mining.ts's own
 * `mineLosses`/`probeScoreL2` calls use (that file's own doc comment: probe
 * self-consistency requires the identical seed base on both sides). Requires
 * gomoku-loss-mining.ts to have been run at least once already (this file
 * throws a clear error otherwise, rather than silently skipping the probe
 * check).
 *
 * Seeds: SEED_BASE_L1 = 400_000, SEED_BASE_L2 = 410_000 (N=100 each) — fresh
 * ranges, verified non-overlapping with every existing gomoku runner's game
 * seeds (gomoku-benchmark.ts 50,000-51,999; -v4 70,000-70,699; -v4-full
 * 80,000-80,699; -v5 90,000-91,299; gomoku-anchor-ladder.ts
 * 990,000/991,000/996,000/997,000; gomoku-loss-mining.ts 300,000/301,000;
 * gomoku.ts's internal wave banks 1-999/1,000-2,029/8,000-10,014/
 * 20,000-23,039/60,000-63,039/70,000-73,039/700,000-700,099). Bot-seed bases
 * (987,1xx range below) are likewise a fresh block, distinct from every
 * existing runner's own bot-seed bases (900,0xx/900,1xx/960,1xx/970,2xx/
 * 975,1xx-975,3xx/980,xxx/981,1xx/984,1xx/986,1xx).
 *
 * Each candidate vs each opponent shares the exact same 100-seed block (not
 * a per-candidate fresh block) — same comparabilityKey context for every
 * row in the resulting table, so priorWeight is the only variable that
 * differs between rows (docs/INTERPRETATION.md 제1규칙).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

import type { AnyGameAdapter, StrategyFlagSpec } from '../../contract/types';
import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { scoreAgainstProbes, type ProbeScore } from '../../loop/probe-bank';
import { loadProbeBank } from '../../artifacts/trajectory-archive';
import type { MctsConfig } from '../../search/mcts';
import { gomokuAdapter } from '../gomoku';
import { gomokuOpusBot } from '../experiments/gomoku-opus-bot';
import { gomokuMidBot } from '../experiments/gomoku-mid-bot';
import {
  GOMOKU_CHAMPION_ROLLOUT_FLAGS,
  gomokuMctsFlagSpecFor,
  gomokuMcts2S256CrFlagSpec,
  GOMOKU_MCTS2_S256_CR_FLAG,
} from './shared/gomoku-mcts-flag';

const GAME_ID = 'gomoku';
const N = 100;
const SEED_BASE_L1 = 400_000;
const SEED_BASE_L2 = 410_000;
const PRIOR_WEIGHTS = [1, 4, 16] as const;

/** Same seed base gomoku-loss-mining.ts's mineLosses/probeScoreL2 use (that file's doc comment — required for probe self-consistency). */
const PROBE_SCORE_BOT_SEED_BASE = 975_201;

const BOT_SEED_BASE = {
  vsL1: { 'mcts2-s256-cr': 987_101, 'mcts4-s256-prior-w1': 987_102, 'mcts4-s256-prior-w4': 987_103, 'mcts4-s256-prior-w16': 987_104 },
  vsL2: { 'mcts2-s256-cr': 987_201, 'mcts4-s256-prior-w1': 987_202, 'mcts4-s256-prior-w4': 987_203, 'mcts4-s256-prior-w16': 987_204 },
} as const;

function priorFlagName(priorWeight: number): string {
  return `mcts4-s256-prior-w${priorWeight}`;
}

/** Same config as mcts2-s256-cr (256 sims, champion rollout) plus priorWeight/priorSource — see this file's own doc comment. */
function gomokuMcts4PriorFlagSpec(bareAdapter: AnyGameAdapter, priorWeight: number): StrategyFlagSpec<unknown, unknown> {
  const config: MctsConfig = {
    simulations: 256,
    uctC: 1.4,
    rolloutCount: 1,
    label: `s256-prior-w${priorWeight}`,
    rolloutFactory: composeBot(bareAdapter, [...GOMOKU_CHAMPION_ROLLOUT_FLAGS]),
    priorWeight,
    priorSource: 'choiceEvaluator',
  };
  return gomokuMctsFlagSpecFor(bareAdapter, config, priorFlagName(priorWeight));
}

function seeds(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function ci(result: HeadToHeadResult): string {
  return `${pct(result.winRateCI.lower)}-${pct(result.winRateCI.upper)}`;
}

interface CandidateRow {
  readonly candidateId: string;
  readonly priorWeight: number | null;
  readonly vsL1: HeadToHeadResult;
  readonly vsL1MsPerGame: number;
  readonly vsL2: HeadToHeadResult;
  readonly vsL2MsPerGame: number;
  readonly probeScore: ProbeScore;
}

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const bareAdapter = eraseAdapter(gomokuAdapter);

  const probeBankPath = join(rootDir, 'runs', GAME_ID, 'probe-bank.json');
  if (!existsSync(probeBankPath)) {
    throw new Error(
      `gomoku-prior-diagnostic: probe bank not found at ${probeBankPath} — run gomoku-loss-mining.ts first (GAP-11 Phase 1-E)`,
    );
  }
  const probes = loadProbeBank(probeBankPath);

  const adapter = withStrategyFlags(bareAdapter, [
    gomokuMcts2S256CrFlagSpec(bareAdapter),
    ...PRIOR_WEIGHTS.map((w) => gomokuMcts4PriorFlagSpec(bareAdapter, w)),
  ]);

  const candidateFlags: Array<{ id: string; priorWeight: number | null }> = [
    { id: GOMOKU_MCTS2_S256_CR_FLAG, priorWeight: null },
    ...PRIOR_WEIGHTS.map((w) => ({ id: priorFlagName(w), priorWeight: w })),
  ];

  const l1SeedBlock = seeds(SEED_BASE_L1, N);
  const l2SeedBlock = seeds(SEED_BASE_L2, N);

  console.log(`=== gomoku prior diagnostic (GAP-11 Phase 2, D1+D2) ===`);
  console.log(`  seedBaseL1=${SEED_BASE_L1} seedBaseL2=${SEED_BASE_L2} N=${N} probes=${probes.length}`);

  const rows: CandidateRow[] = [];

  for (const { id, priorWeight } of candidateFlags) {
    const bot = composeBot(adapter, [id]);

    console.log(`  [${id}] vs L1(mid) ...`);
    const t0 = Date.now();
    const vsL1 = runHeadToHead(adapter, bot, gomokuMidBot, l1SeedBlock, BOT_SEED_BASE.vsL1[id as keyof typeof BOT_SEED_BASE.vsL1]);
    const t1 = Date.now();
    const vsL1MsPerGame = (t1 - t0) / vsL1.blocks;
    console.log(
      `     winRate=${pct(vsL1.candidateWinRate)} CI=${ci(vsL1)} blocks=${vsL1.blocks} ms/game=${vsL1MsPerGame.toFixed(0)}`,
    );

    console.log(`  [${id}] vs L2(opus) ...`);
    const t2 = Date.now();
    const vsL2 = runHeadToHead(adapter, bot, gomokuOpusBot, l2SeedBlock, BOT_SEED_BASE.vsL2[id as keyof typeof BOT_SEED_BASE.vsL2]);
    const t3 = Date.now();
    const vsL2MsPerGame = (t3 - t2) / vsL2.blocks;
    console.log(
      `     winRate=${pct(vsL2.candidateWinRate)} CI=${ci(vsL2)} blocks=${vsL2.blocks} ms/game=${vsL2MsPerGame.toFixed(0)}`,
    );

    const probeScore = scoreAgainstProbes(adapter, bot, probes, PROBE_SCORE_BOT_SEED_BASE);
    console.log(
      `     probe agreementRate=${pct(probeScore.agreementRate)} (probes=${probeScore.probes}, skipped=${probeScore.skipped})`,
    );

    rows.push({ candidateId: id, priorWeight, vsL1, vsL1MsPerGame, vsL2, vsL2MsPerGame, probeScore });
  }

  console.log('');
  console.log('  결과 표:');
  console.log('  candidate               priorWeight  vsL1 winRate (CI)         vsL2 winRate (CI)         probe agree  ms/game(L1/L2)');
  for (const row of rows) {
    console.log(
      `  ${row.candidateId.padEnd(24)}${String(row.priorWeight ?? '(none)').padEnd(13)}` +
        `${pct(row.vsL1.candidateWinRate).padEnd(8)}(${ci(row.vsL1)})   ` +
        `${pct(row.vsL2.candidateWinRate).padEnd(8)}(${ci(row.vsL2)})   ` +
        `${pct(row.probeScore.agreementRate).padEnd(10)} ${row.vsL1MsPerGame.toFixed(0)}/${row.vsL2MsPerGame.toFixed(0)}`,
    );
  }

  const successCriterion = {
    l2Above9pct: rows.some((r) => r.priorWeight !== null && r.vsL2.candidateWinRate > 0.09),
    l1MonotoneImprovement: (() => {
      const withoutPrior = rows.find((r) => r.priorWeight === null);
      const withPrior = rows.filter((r) => r.priorWeight !== null).sort((a, b) => (a.priorWeight as number) - (b.priorWeight as number));
      if (!withoutPrior) return false;
      let prev = withoutPrior.vsL1.candidateWinRate;
      for (const r of withPrior) {
        if (r.vsL1.candidateWinRate < prev) return false;
        prev = r.vsL1.candidateWinRate;
      }
      return withPrior.some((r) => r.vsL1.candidateWinRate > withoutPrior.vsL1.candidateWinRate);
    })(),
  };
  console.log('');
  console.log(`  성공 기준: L2 상대 9.0% 초과 = ${successCriterion.l2Above9pct}, L1 상대 단조 개선 = ${successCriterion.l1MonotoneImprovement}`);

  const outDir = join(rootDir, 'runs', GAME_ID);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'prior-diagnostic.json');
  const payload = {
    gameId: GAME_ID,
    generatedAt: new Date().toISOString(),
    n: N,
    seedBaseL1: SEED_BASE_L1,
    seedBaseL2: SEED_BASE_L2,
    probeBankPath,
    probeScoreBotSeedBase: PROBE_SCORE_BOT_SEED_BASE,
    botSeedBase: BOT_SEED_BASE,
    rows,
    successCriterion,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`  저장: ${outPath}`);
}

main();
