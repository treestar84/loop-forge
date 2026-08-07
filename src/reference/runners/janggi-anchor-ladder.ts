/**
 * janggi-anchor-ladder — measurement gate for the L1/L2 anchor ladder
 * (docs/GAP-ANALYSIS-11.md D3/Phase 1-C, docs/adr/0012), same structure as
 * dominion-anchor-ladder.ts/gomoku-anchor-ladder.ts/hearthstone-anchor-ladder.ts/
 * splendor-anchor-ladder.ts/wingspan-anchor-ladder.ts:
 * scratchpad/janggi-gap11-onramp-design-spec.md steps 1-3. Registers this
 * game's mid-skill bot (../experiments/janggi-mid-bot.ts) as the
 * 'external-mid-l1' anchor and the existing Opus bot
 * (../experiments/janggi-opus-bot.ts) as the 'external-opus-l2' anchor, but
 * ONLY after both gates below pass — anchors are permanently frozen once
 * registered (BaselineRegistry's registerAnchor doc comment), so a bad
 * registration cannot be corrected by re-running this file.
 *
 * Gate 1 intent: L1 sits strictly between `baselines.heuristic` and L2(opus)
 * in skill. Gate 2 intent: same statement, the other bot.
 *
 * Gate-0 order probe (splendor/wingspan-anchor-ladder.ts's lesson, per this
 * task's design brief — "Gate 0 극성 판정 포함"): measure heuristic vs
 * L2(opus) FIRST with its own fresh seed bank and gate Gates 1/2 against
 * whichever direction is empirically true, rather than assuming a fixed
 * precedent direction. The design brief flags that GAP-11-ROUNDS.md's older,
 * unreliable "78.0% Opus 승률" note suggests janggi likely follows the
 * dominion/gomoku/hearthstone precedent (L2 > heuristic), but this runner
 * measures rather than assumes it.
 *
 * Seed choice: every existing janggi runner's seed literal was grepped first
 * (janggi.ts's own runner: seeds 1-90/1000-1029/2000-2029; janggi-mcts-*:
 * 8000-10005; janggi-mcts2-*: 30000-33005; janggi-benchmark.ts: 50000-51999 +
 * botSeedBase 700001-700003/800000/900000-900099; a8-wave-1 (GAP-11-ROUNDS.md):
 * 40000-40029/41000-41009/42000-42009). Cross-game anchor-ladder/L3/
 * transcendence-check runners across dominion/gomoku/hearthstone/splendor/
 * wingspan collectively occupy 981_101-999_999 and 1_000_000-1_028_101 (see
 * dominion-anchor-ladder.ts, gomoku-anchor-ladder.ts,
 * hearthstone-anchor-ladder.ts, gomoku-v9-large-confirm.ts,
 * splendor-anchor-ladder.ts, wingspan-anchor-ladder.ts's doc comments for the
 * itemized ranges) — this file picks a fresh block above all of that:
 *   - Order probe (heuristic vs L2): seeds 1_034_000-1_034_099.
 *   - L1 Gate 1 (mid vs heuristic): seeds 1_030_000-1_030_099.
 *   - L1 Gate 2 (mid vs L2):        seeds 1_031_000-1_031_099.
 *   - L3 Gate 1 (engine vs heuristic): seeds 1_032_000-1_032_099.
 *   - L3 Gate 2 (fingerprint probe, heuristic self-play): seeds
 *     1_033_000-1_033_019 (20 games).
 * Bot seed bases (independent space, also grepped clear): gate1: 1_030_101,
 * gate2: 1_030_102 (L1 ladder); orderProbe: 1_030_103; l3Gate1: 1_031_101,
 * l3Gate2: 1_031_102, floorProbe: 1_031_103 (L3 ladder).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import type { BotFactory } from '../../contract/types';
import { eraseAdapter } from '../../loop/erase';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { evaluateFingerprintGate, type FingerprintGateResult } from '../../loop/fingerprint-gate';
import { loadOrCreateRegistry, saveRegistry } from '../../artifacts/game-state';
import { janggiAdapter, type JanggiChoice, type JanggiObservation } from '../janggi';
import { janggiOpusBot } from '../experiments/janggi-opus-bot';
import { janggiMidBot } from '../experiments/janggi-mid-bot';
import { janggiEngineBot } from '../experiments/janggi-engine-bot';

const GAME_ID = 'janggi';
const N = 100;

const SEED_BASE_GATE1 = 1_030_000;
const SEED_BASE_GATE2 = 1_031_000;
const SEED_BASE_ORDER_PROBE = 1_034_000;
const BOT_SEED_BASE = { gate1: 1_030_101, gate2: 1_030_102, orderProbe: 1_030_103 } as const;

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
  const adapter = eraseAdapter(janggiAdapter);
  const midBot = janggiMidBot;
  const heuristic = janggiAdapter.baselines.heuristic;
  const opusBot = janggiOpusBot;

  console.log(`=== ${GAME_ID} anchor ladder gate (N=${N} seeds/gate) ===`);

  console.log('  Gate 0) order probe: heuristic vs L2(opus) — decides which polarity Gates 1/2 require ...');
  const orderProbe = runHeadToHead(
    adapter,
    heuristic,
    opusBot,
    seeds(SEED_BASE_ORDER_PROBE, N),
    BOT_SEED_BASE.orderProbe,
  );
  const heuristicBeatsL2 = orderProbe.winRateCI.lower > 0.5;
  const l2BeatsHeuristic = orderProbe.winRateCI.upper < 0.5;
  console.log(
    `     heuristic winRate vs L2=${pct(orderProbe.candidateWinRate)} CI=${ci(orderProbe)} blocks=${orderProbe.blocks} -> ${heuristicBeatsL2 ? 'heuristic > L2' : l2BeatsHeuristic ? 'L2 > heuristic (precedent case)' : 'inconclusive'}`,
  );

  // heuristicBeatsL2: require heuristic > L1(mid) > L2 (the splendor/wingspan
  // case). Otherwise (l2BeatsHeuristic, the dominion/gomoku/hearthstone case,
  // or inconclusive): fall back to the documented precedent polarity (L1
  // beats heuristic, L1 loses to L2).
  const gate1Criterion = heuristicBeatsL2 ? 'winRateCI.upper < 0.5 (heuristic > L2 order)' : 'winRateCI.lower > 0.5 (precedent order)';
  const gate2Criterion = heuristicBeatsL2 ? 'winRateCI.lower > 0.5 (heuristic > L2 order)' : 'winRateCI.upper < 0.5 (precedent order)';

  console.log(`  Gate 1) L1(mid) vs heuristic ... (criterion: ${gate1Criterion})`);
  const gate1 = runHeadToHead(adapter, midBot as BotFactory<JanggiObservation, JanggiChoice>, heuristic, seeds(SEED_BASE_GATE1, N), BOT_SEED_BASE.gate1);
  const gate1Pass = heuristicBeatsL2 ? gate1.winRateCI.upper < 0.5 : gate1.winRateCI.lower > 0.5;
  console.log(
    `     winRate=${pct(gate1.candidateWinRate)} CI=${ci(gate1)} blocks=${gate1.blocks} -> ${gate1Pass ? 'PASS' : 'FAIL'}`,
  );

  console.log(`  Gate 2) L1(mid) vs L2(opus) ... (criterion: ${gate2Criterion})`);
  const gate2 = runHeadToHead(adapter, midBot as BotFactory<JanggiObservation, JanggiChoice>, opusBot, seeds(SEED_BASE_GATE2, N), BOT_SEED_BASE.gate2);
  const gate2Pass = heuristicBeatsL2 ? gate2.winRateCI.lower > 0.5 : gate2.winRateCI.upper < 0.5;
  console.log(
    `     winRate=${pct(gate2.candidateWinRate)} CI=${ci(gate2)} blocks=${gate2.blocks} -> ${gate2Pass ? 'PASS' : 'FAIL'}`,
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
    seedBaseOrderProbe: SEED_BASE_ORDER_PROBE,
    seedBaseGate1: SEED_BASE_GATE1,
    seedBaseGate2: SEED_BASE_GATE2,
    botSeedBase: BOT_SEED_BASE,
    orderProbe: {
      ...orderProbe,
      note: 'heuristic vs L2(opus) — decides gate polarity. heuristicBeatsL2 true means janggi deviates from the dominion/gomoku/hearthstone precedent (there, L2 always beats heuristic).',
      heuristicBeatsL2,
      l2BeatsHeuristic,
    },
    gate1: { ...gate1, pass: gate1Pass, criterion: gate1Criterion },
    gate2: { ...gate2, pass: gate2Pass, criterion: gate2Criterion },
    bothPass,
    registered,
    skipped,
  };
  writeFileSync(join(outDir, 'anchor-ladder.json'), JSON.stringify(payload, null, 2));
  console.log(`  저장: runs/${GAME_ID}/anchor-ladder.json`);
}

/**
 * L3 holdout anchor gate (docs/GAP-ANALYSIS-11.md D3 Phase 1-D / docs/adr/0012).
 * The L3 bot (../experiments/janggi-engine-bot.ts) is a *third style*
 * ("수비 우선(안전 기물 교환만) + 궁 방어 최우선 + 병사 조직적 전진", per the
 * task's design brief), written without reading janggi-opus-bot.ts, and is
 * registered with role 'holdout' — it exists to judge candidates, never to
 * give them feedback.
 *
 *   Gate 1 (L3 > heuristic): runHeadToHead over seeds 1_032_000+.
 *     Passes iff winRateCI.lower > 0.5.
 *   Gate 2 (fingerprint distance from L2, CALIBRATED per docs/adr/0015):
 *     replay heuristic self-play games over seeds 1_033_000+, and at every
 *     decision point ask L3 and L2 what they would do (the game itself is
 *     always advanced by the heuristic, so both are probed on an identical,
 *     style-neutral state distribution) -> agreement. Separately, over the
 *     SAME seeds/decision points, measure the natural agreement floor for
 *     this game between two obviously-independent bots (plain heuristic vs
 *     L2) -> floor. `evaluateFingerprintGate(agreement, floor)`
 *     (../../loop/fingerprint-gate.ts) then applies ADR-0015's two-stage
 *     verdict: fast-pass if agreement < 70%, else pass iff the normalized
 *     excess agreement above the floor, (agreement-floor)/(1-floor), is < 0.5
 *     — "L3 sits closer to an independent bot pair than to being the same
 *     bot as L2".
 *
 * There is deliberately NO win-rate gate against L2: a holdout anchor is
 * defined by style independence, not by being stronger or weaker than the
 * feedback tier.
 *
 * Same permanence caveat as main(): registerAnchor seals the id forever, so
 * getAnchor is checked first and registration is skipped when either gate
 * fails.
 */

const SEED_BASE_L3_GATE1 = 1_032_000;
const SEED_BASE_L3_GATE2 = 1_033_000;
// floorProbe reuses SEED_BASE_L3_GATE2's game seeds (ADR-0015/brief: "동일
// 프로토콜, 동일 시드" — the floor and the L3-vs-L2 agreement must be
// measured over the identical decision points to be comparable), but needs
// its own bot-seed-base slot so its two bot instances (heuristic, L2) don't
// collide with l3Gate2's (engine, L2) instances.
const BOT_SEED_BASE_L3 = { gate1: 1_031_101, gate2: 1_031_102, floorProbe: 1_031_103 } as const;
const N_L3_GATE1 = 100;
const N_L3_PROBE = 20;
const STYLE2_L3_ANCHOR_ID = 'external-style2-l3';

interface FingerprintProbe {
  readonly games: number;
  readonly decisionPoints: number;
  readonly agreements: number;
  readonly agreementRate: number;
}

/**
 * Walk heuristic-vs-heuristic games and count how often `botAFactory` and
 * `botBFactory` would pick the same encoded choice at each decision point.
 * Only the heuristic driver's own choice is ever applied to advance the
 * game, so neither probed bot steers the trajectory toward its own
 * comfortable states — both are probed on an identical, style-neutral state
 * distribution. Generalized (per docs/adr/0015) so the same protocol can
 * measure both l3Gate2's agreement (L3 vs L2) and the calibration floor
 * (plain heuristic vs L2).
 */
function probeFingerprintAgreement(
  probeSeeds: readonly number[],
  botSeedBase: number,
  botAFactory: BotFactory<JanggiObservation, JanggiChoice>,
  botBFactory: BotFactory<JanggiObservation, JanggiChoice>,
): FingerprintProbe {
  const heuristic = janggiAdapter.baselines.heuristic;
  let decisionPoints = 0;
  let agreements = 0;

  for (const seed of probeSeeds) {
    const botSeed = botSeedBase + seed;
    const driver = heuristic(botSeed);
    const botA = botAFactory(botSeed);
    const botB = botBFactory(botSeed);

    let state = janggiAdapter.createInitialState(seed);
    let decision = janggiAdapter.currentDecision(state);
    while (decision !== null) {
      const observation = janggiAdapter.getObservation(state, decision.player);
      const legal = janggiAdapter.getLegalChoices(state);

      decisionPoints += 1;
      const aChoice = janggiAdapter.encodeChoice(botA.decide(decision.decisionPoint, observation, legal));
      const bChoice = janggiAdapter.encodeChoice(botB.decide(decision.decisionPoint, observation, legal));
      if (aChoice === bChoice) agreements += 1;

      state = janggiAdapter.applyChoice(state, driver.decide(decision.decisionPoint, observation, legal));
      decision = janggiAdapter.currentDecision(state);
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
  const adapter = eraseAdapter(janggiAdapter);

  console.log(`=== ${GAME_ID} L3 holdout anchor gate ===`);

  console.log(`  Gate 1) L3(engine) vs heuristic (N=${N_L3_GATE1}) ...`);
  const gate1 = runHeadToHead(
    adapter,
    janggiEngineBot as BotFactory<JanggiObservation, JanggiChoice>,
    janggiAdapter.baselines.heuristic,
    seeds(SEED_BASE_L3_GATE1, N_L3_GATE1),
    BOT_SEED_BASE_L3.gate1,
  );
  const gate1Pass = gate1.winRateCI.lower > 0.5;
  console.log(
    `     winRate=${pct(gate1.candidateWinRate)} CI=${ci(gate1)} blocks=${gate1.blocks} -> ${gate1Pass ? 'PASS' : 'FAIL'} (need CI lower > 0.5)`,
  );

  console.log(`  Gate 2) L3 vs L2 fingerprint distance (heuristic self-play probe, ${N_L3_PROBE} seeds, calibrated per docs/adr/0015) ...`);
  const probe = probeFingerprintAgreement(
    seeds(SEED_BASE_L3_GATE2, N_L3_PROBE),
    BOT_SEED_BASE_L3.gate2,
    janggiEngineBot,
    janggiOpusBot,
  );
  console.log(
    `     agreement(L3,L2)=${pct(probe.agreementRate)} (${probe.agreements}/${probe.decisionPoints} decision points, ${probe.games} games)`,
  );

  console.log(`  Gate 2 floor) heuristic vs L2 (SAME seeds/decision points as above — this game's natural agreement floor) ...`);
  const floorProbe = probeFingerprintAgreement(
    seeds(SEED_BASE_L3_GATE2, N_L3_PROBE),
    BOT_SEED_BASE_L3.floorProbe,
    janggiAdapter.baselines.heuristic,
    janggiOpusBot,
  );
  console.log(
    `     agreement(heuristic,L2)=${pct(floorProbe.agreementRate)} (${floorProbe.agreements}/${floorProbe.decisionPoints} decision points, ${floorProbe.games} games)`,
  );

  const gateResult: FingerprintGateResult = evaluateFingerprintGate(probe.agreementRate, floorProbe.agreementRate);
  const gate2Pass = gateResult.pass;
  console.log(
    `     verdict: ${gateResult.fastPass ? `fast-pass (agreement < 70%)` : `calibrated (excess=${pct(gateResult.excess)}, need < 50%)`} -> ${gate2Pass ? 'PASS' : 'FAIL'}`,
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
      n: N_L3_GATE1,
      seedBase: SEED_BASE_L3_GATE1,
      botSeedBase: BOT_SEED_BASE_L3.gate1,
      pass: gate1Pass,
      criterion: 'winRateCI.lower > 0.5',
    },
    l3Gate2: {
      agreement: probe,
      seedBase: SEED_BASE_L3_GATE2,
      botSeedBase: BOT_SEED_BASE_L3.gate2,
      floor: {
        ...floorProbe,
        botSeedBase: BOT_SEED_BASE_L3.floorProbe,
        note: 'agreement(heuristic,L2) over the SAME seeds/decision points as agreement(L3,L2) — this game\'s natural agreement floor per docs/adr/0015.',
      },
      gate: gateResult,
      pass: gate2Pass,
      criterion: 'evaluateFingerprintGate(agreement(L3,L2), floor) per docs/adr/0015 — fast-pass if agreement<0.7, else excess=(agreement-floor)/(1-floor)<0.5',
    },
    l3Registered: registered ? [STYLE2_L3_ANCHOR_ID] : [],
    l3Skipped: skipped ? [STYLE2_L3_ANCHOR_ID] : [],
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`  저장: runs/${GAME_ID}/anchor-ladder.json (L3 필드 병합)`);
}

main();
runL3Gate();
