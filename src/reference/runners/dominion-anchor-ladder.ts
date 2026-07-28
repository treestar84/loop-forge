/**
 * dominion-anchor-ladder — measurement gate for the L1/L2 anchor ladder
 * (docs/GAP-ANALYSIS-11.md D3/Phase 1-C, docs/adr/0012): registers this
 * game's mid-skill bot (../experiments/dominion-mid-bot.ts) as the
 * 'external-mid-l1' anchor and the existing Opus bot
 * (../experiments/dominion-opus-bot.ts) as the 'external-opus-l2' anchor, but
 * ONLY after both gates below pass — anchors are permanently frozen once
 * registered (BaselineRegistry's registerAnchor doc comment), so a bad
 * registration cannot be corrected by re-running this file.
 *
 * Gate 1 (L1 > heuristic): runHeadToHead(midBot, baselines.heuristic) over a
 *   fixed seed block. Passes iff winRateCI.lower > 0.5.
 * Gate 2 (L1 < L2): runHeadToHead(midBot, opusBot) over a second, non-
 *   overlapping seed block. Passes iff winRateCI.upper < 0.5.
 *
 * Seeds are drawn from 992_000+ (gate 1) and 993_000+ (gate 2) — a fresh
 * range distinct from dominion-benchmark.ts's SEED_BASE=50_000 (N up to
 * 2000, i.e. 50_000-51_999).
 *
 * Idempotent across reruns: `getAnchor` is checked before every
 * `registerAnchor` call, so a second run against an already-sealed anchor
 * skips registration instead of throwing.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { eraseAdapter } from '../../loop/erase';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { loadOrCreateRegistry, saveRegistry } from '../../artifacts/game-state';
import { dominionAdapter } from '../dominion';
import { dominionOpusBot } from '../experiments/dominion-opus-bot';
import { dominionMidBot } from '../experiments/dominion-mid-bot';
import { dominionEngineBot } from '../experiments/dominion-engine-bot';

const GAME_ID = 'dominion';
const N = 100;

const SEED_BASE_GATE1 = 992_000;
const SEED_BASE_GATE2 = 993_000;
const BOT_SEED_BASE = { gate1: 982_101, gate2: 982_102 } as const;

const MID_L1_ANCHOR_ID = 'external-mid-l1';
const OPUS_L2_ANCHOR_ID = 'external-opus-l2';

function seeds(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function ci(result: HeadToHeadResult): string {
  return `${pct(result.winRateCI.lower)}-${pct(result.winRateCI.upper)}`;
}

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const adapter = eraseAdapter(dominionAdapter);
  const midBot = dominionMidBot;
  const heuristic = dominionAdapter.baselines.heuristic;
  const opusBot = dominionOpusBot;

  console.log(`=== ${GAME_ID} anchor ladder gate (N=${N} seeds/gate) ===`);

  console.log('  Gate 1) L1(mid) vs heuristic ...');
  const gate1 = runHeadToHead(adapter, midBot, heuristic, seeds(SEED_BASE_GATE1, N), BOT_SEED_BASE.gate1);
  const gate1Pass = gate1.winRateCI.lower > 0.5;
  console.log(
    `     winRate=${pct(gate1.candidateWinRate)} CI=${ci(gate1)} blocks=${gate1.blocks} -> ${gate1Pass ? 'PASS' : 'FAIL'} (need CI lower > 0.5)`,
  );

  console.log('  Gate 2) L1(mid) vs L2(opus) ...');
  const gate2 = runHeadToHead(adapter, midBot, opusBot, seeds(SEED_BASE_GATE2, N), BOT_SEED_BASE.gate2);
  const gate2Pass = gate2.winRateCI.upper < 0.5;
  console.log(
    `     winRate=${pct(gate2.candidateWinRate)} CI=${ci(gate2)} blocks=${gate2.blocks} -> ${gate2Pass ? 'PASS' : 'FAIL'} (need CI upper < 0.5)`,
  );

  const bothPass = gate1Pass && gate2Pass;
  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const registered: string[] = [];
  const skipped: string[] = [];

  if (bothPass) {
    if (registry.getAnchor(MID_L1_ANCHOR_ID)) {
      skipped.push(MID_L1_ANCHOR_ID);
    } else {
      registry.registerAnchor({ anchorId: MID_L1_ANCHOR_ID, kind: 'external', role: 'feedback' });
      registered.push(MID_L1_ANCHOR_ID);
    }
    if (registry.getAnchor(OPUS_L2_ANCHOR_ID)) {
      skipped.push(OPUS_L2_ANCHOR_ID);
    } else {
      registry.registerAnchor({ anchorId: OPUS_L2_ANCHOR_ID, kind: 'external', role: 'feedback' });
      registered.push(OPUS_L2_ANCHOR_ID);
    }
    saveRegistry(rootDir, GAME_ID, registry);
    console.log(`  게이트 통과 — 등록: [${registered.join(', ') || '(none, already sealed)'}]${skipped.length > 0 ? `, 스킵(이미 봉인): [${skipped.join(', ')}]` : ''}`);
  } else {
    console.log('  게이트 실패 — 앵커 등록 skip.');
  }

  const outDir = join(rootDir, 'runs', GAME_ID);
  mkdirSync(outDir, { recursive: true });
  const payload = {
    gameId: GAME_ID,
    generatedAt: new Date().toISOString(),
    n: N,
    seedBaseGate1: SEED_BASE_GATE1,
    seedBaseGate2: SEED_BASE_GATE2,
    botSeedBase: BOT_SEED_BASE,
    gate1: { ...gate1, pass: gate1Pass, criterion: 'winRateCI.lower > 0.5' },
    gate2: { ...gate2, pass: gate2Pass, criterion: 'winRateCI.upper < 0.5' },
    bothPass,
    registered,
    skipped,
  };
  writeFileSync(join(outDir, 'anchor-ladder.json'), JSON.stringify(payload, null, 2));
  console.log(`  저장: runs/${GAME_ID}/anchor-ladder.json`);
}

/**
 * L3 holdout anchor gate (docs/GAP-ANALYSIS-11.md D3 Phase 1-D / docs/adr/0012).
 * The L3 bot (../experiments/dominion-engine-bot.ts) is a *third style*, written
 * without reading L2, and is registered with role 'holdout' — it exists to judge
 * candidates, never to give them feedback. Two gates, both required:
 *
 *   Gate 1 (L3 > heuristic): runHeadToHead over seeds 998_000+.
 *     Passes iff winRateCI.lower > 0.5.
 *   Gate 2 (fingerprint distance from L2): replay heuristic self-play games over
 *     seeds 999_000+, and at every decision point ask L3 and L2 what they would
 *     do (the game itself is always advanced by the heuristic, so both are probed
 *     on an identical, style-neutral state distribution). Passes iff the encoded
 *     choices agree on fewer than AGREEMENT_MAX of those points — an L3 that
 *     mostly mirrors L2 is not an independent judge.
 *
 * There is deliberately NO win-rate gate against L2: a holdout anchor is defined
 * by style independence, not by being stronger or weaker than the feedback tier.
 *
 * Same permanence caveat as main(): registerAnchor seals the id forever, so
 * getAnchor is checked first and registration is skipped when either gate fails.
 */

const SEED_BASE_L3_GATE1 = 998_000;
const SEED_BASE_L3_GATE2 = 999_000;
const BOT_SEED_BASE_L3 = { gate1: 985_101, gate2: 985_102 } as const;
const N_L3_PROBE = 20;
const AGREEMENT_MAX = 0.7;
const STYLE2_L3_ANCHOR_ID = 'external-style2-l3';
/** Safety net for the probe replay loop; spec.maxDecisionsPerGame is 800. */
const PROBE_DECISION_CAP = 4000;

interface FingerprintProbe {
  readonly games: number;
  readonly decisionPoints: number;
  readonly agreements: number;
  readonly agreementRate: number;
}

/**
 * Walk heuristic-vs-heuristic games and count how often L3 and L2 would pick the
 * same encoded choice. Only the heuristic's choice is ever applied, so neither
 * probed bot steers the trajectory toward its own comfortable states.
 */
function probeFingerprintAgreement(probeSeeds: readonly number[], botSeedBase: number): FingerprintProbe {
  const heuristic = dominionAdapter.baselines.heuristic;
  let decisionPoints = 0;
  let agreements = 0;

  for (const seed of probeSeeds) {
    const botSeed = botSeedBase + seed;
    const drivers = [heuristic(botSeed), heuristic(botSeed + 1)];
    const l3 = dominionEngineBot(botSeed);
    const l2 = dominionOpusBot(botSeed);

    let state = dominionAdapter.createInitialState(seed);
    for (let step = 0; step < PROBE_DECISION_CAP; step += 1) {
      const decision = dominionAdapter.currentDecision(state);
      if (decision === null) break;
      const observation = dominionAdapter.getObservation(state, decision.player);
      const legal = dominionAdapter.getLegalChoices(state);

      decisionPoints += 1;
      const l3Choice = dominionAdapter.encodeChoice(l3.decide(decision.decisionPoint, observation, legal));
      const l2Choice = dominionAdapter.encodeChoice(l2.decide(decision.decisionPoint, observation, legal));
      if (l3Choice === l2Choice) agreements += 1;

      const driver = drivers[decision.player];
      if (!driver) throw new Error(`probeFingerprintAgreement: no driver for player ${decision.player}`);
      state = dominionAdapter.applyChoice(state, driver.decide(decision.decisionPoint, observation, legal));
    }
  }

  return {
    games: probeSeeds.length,
    decisionPoints,
    agreements,
    agreementRate: decisionPoints === 0 ? 1 : agreements / decisionPoints,
  };
}

function runL3Gate(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const adapter = eraseAdapter(dominionAdapter);

  console.log(`=== ${GAME_ID} L3 holdout anchor gate ===`);

  console.log(`  Gate 1) L3(engine) vs heuristic (N=${N}) ...`);
  const gate1 = runHeadToHead(
    adapter,
    dominionEngineBot,
    dominionAdapter.baselines.heuristic,
    seeds(SEED_BASE_L3_GATE1, N),
    BOT_SEED_BASE_L3.gate1,
  );
  const gate1Pass = gate1.winRateCI.lower > 0.5;
  console.log(
    `     winRate=${pct(gate1.candidateWinRate)} CI=${ci(gate1)} blocks=${gate1.blocks} -> ${gate1Pass ? 'PASS' : 'FAIL'} (need CI lower > 0.5)`,
  );

  console.log(`  Gate 2) L3 vs L2 fingerprint distance (heuristic self-play probe, ${N_L3_PROBE} seeds) ...`);
  const probe = probeFingerprintAgreement(seeds(SEED_BASE_L3_GATE2, N_L3_PROBE), BOT_SEED_BASE_L3.gate2);
  const gate2Pass = probe.agreementRate < AGREEMENT_MAX;
  console.log(
    `     agreementRate=${pct(probe.agreementRate)} (${probe.agreements}/${probe.decisionPoints} decision points, ${probe.games} games) -> ${gate2Pass ? 'PASS' : 'FAIL'} (need < ${pct(AGREEMENT_MAX)})`,
  );

  const bothPass = gate1Pass && gate2Pass;
  let registered = false;
  let skipped = false;

  if (bothPass) {
    const registry = loadOrCreateRegistry(rootDir, GAME_ID);
    if (registry.getAnchor(STYLE2_L3_ANCHOR_ID)) {
      skipped = true;
      console.log(`  게이트 통과 — 스킵(이미 봉인): ${STYLE2_L3_ANCHOR_ID}`);
    } else {
      registry.registerAnchor({ anchorId: STYLE2_L3_ANCHOR_ID, kind: 'external', role: 'holdout' });
      saveRegistry(rootDir, GAME_ID, registry);
      registered = true;
      console.log(`  게이트 통과 — 등록: ${STYLE2_L3_ANCHOR_ID} (role=holdout)`);
    }
  } else {
    console.log('  게이트 실패 — L3 앵커 등록 skip.');
  }

  // Merge into the artifact main() just wrote, preserving the L1/L2 fields.
  const outDir = join(rootDir, 'runs', GAME_ID);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'anchor-ladder.json');
  const existing: Record<string, unknown> = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>)
    : {};
  const payload = {
    ...existing,
    l3Gate1: {
      ...gate1,
      n: N,
      seedBase: SEED_BASE_L3_GATE1,
      botSeedBase: BOT_SEED_BASE_L3.gate1,
      pass: gate1Pass,
      criterion: 'winRateCI.lower > 0.5',
    },
    l3Gate2: {
      ...probe,
      seedBase: SEED_BASE_L3_GATE2,
      botSeedBase: BOT_SEED_BASE_L3.gate2,
      pass: gate2Pass,
      criterion: `agreementRate < ${AGREEMENT_MAX}`,
    },
    l3Registered: registered ? [STYLE2_L3_ANCHOR_ID] : [],
    l3Skipped: skipped ? [STYLE2_L3_ANCHOR_ID] : [],
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`  저장: runs/${GAME_ID}/anchor-ladder.json (L3 필드 병합)`);
}

main();
runL3Gate();
