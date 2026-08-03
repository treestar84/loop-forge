/**
 * splendor-anchor-ladder — measurement gate for the L1/L2 anchor ladder
 * (docs/GAP-ANALYSIS-11.md D3/Phase 1-C, docs/adr/0012), same structure as
 * dominion-anchor-ladder.ts/gomoku-anchor-ladder.ts/hearthstone-anchor-ladder.ts:
 * registers this game's mid-skill bot (../experiments/splendor-mid-bot.ts) as
 * the 'external-mid-l1' anchor and the existing Opus bot
 * (../experiments/splendor-opus-bot.ts) as the 'external-opus-l2' anchor, but
 * ONLY after both gates below pass — anchors are permanently frozen once
 * registered (BaselineRegistry's registerAnchor doc comment), so a bad
 * registration cannot be corrected by re-running this file.
 *
 * Gate 1 intent: L1 sits strictly between `baselines.heuristic` and L2(opus)
 * in skill. Gate 2 intent: same statement, the other bot.
 *
 * **Deviation from the dominion/gomoku/hearthstone precedent, recorded
 * honestly per the task brief's "결과가 어느 쪽이든 정직 기록" rule**: those
 * three ladders all hardcode "L1 beats heuristic, L1 loses to L2" because in
 * all three games heuristic < L2(opus). An exploratory probe here
 * (`runHeadToHead(heuristic, opusBot)`, N=100, seeds 1_014_000-1_014_099,
 * botSeedBase 1_010_103 — logged as `orderProbe` in the output JSON) found
 * the OPPOSITE for splendor: `baselines.heuristic` beats
 * `splendor-opus-bot.ts` outright (66.0% win rate, CI [58.5%, 73.5%], clearly
 * above 0.5). That makes the literal "L1 beats heuristic AND L1 loses to L2"
 * gate logically impossible to pass by design (it would require
 * heuristic < L1 < L2 < heuristic, a transitivity violation) — not a bug in
 * this runner, a real fact about splendor-opus-bot.ts's play quality
 * relative to the plain heuristic baseline. So this runner measures the
 * heuristic-vs-L2 order FIRST and gates L1 against whichever direction is
 * empirically true:
 *   - If heuristic beats L2 (the case found here): Gate 1 requires L1 to
 *     LOSE to heuristic (winRateCI.upper < 0.5) and Gate 2 requires L1 to
 *     BEAT L2 (winRateCI.lower > 0.5) — i.e. heuristic > L1(mid) > L2(opus).
 *   - If L2 beats heuristic (the dominion/gomoku/hearthstone case): the gate
 *     falls back to the precedent's literal direction (L1 beats heuristic,
 *     L1 loses to L2).
 * Either way the substantive requirement — L1 is an independently-designed
 * bot whose skill measurably sits strictly between the two existing anchors —
 * is preserved; only the win/lose polarity per matchup is resolved from data
 * instead of assumed.
 *
 * Seed choice: every existing splendor runner's seed literal was grepped
 * first (splendor-benchmark.ts: SEED_BASE=50_000, N up to 2000 ->
 * 50_000-51_999, botSeedBase 810_001/820_002/830_003; splendor-benchmark-v3.ts:
 * SEED_BASE=60_000, N up to 400 -> 60_000-60_399, botSeedBase
 * 960_101/960_102/960_103; splendor.ts's noise-floor probe: 800_000+/900_000+).
 * Cross-game anchor-ladder/L3/loss-mining/portfolio runners across
 * dominion/gomoku/hearthstone collectively occupy 981_101-999_999 and
 * 1_000_000-1_001_099 (see dominion-anchor-ladder.ts, gomoku-anchor-ladder.ts,
 * hearthstone-anchor-ladder.ts, gomoku-v9-large-confirm.ts's doc comments for
 * the itemized ranges) — this file picks a fresh block above all of that:
 *   - Order probe (heuristic vs L2): seeds 1_014_000-1_014_099.
 *   - L1 Gate 1 (mid vs heuristic): seeds 1_010_000-1_010_099.
 *   - L1 Gate 2 (mid vs L2):        seeds 1_011_000-1_011_099.
 *   - L3 Gate 1 (engine vs heuristic): seeds 1_012_000-1_012_099.
 *   - L3 Gate 2 (fingerprint probe, heuristic self-play): seeds
 *     1_013_000-1_013_019 (20 games).
 * Bot seed bases (independent space, also grepped clear): gate1: 1_010_101,
 * gate2: 1_010_102 (L1 ladder); l3Gate1: 1_011_101, l3Gate2: 1_011_102 (L3
 * ladder); orderProbe: 1_010_103.
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
import { splendorAdapter } from '../splendor';
import { splendorOpusBot } from '../experiments/splendor-opus-bot';
import { splendorMidBot } from '../experiments/splendor-mid-bot';
import { splendorEngineBot } from '../experiments/splendor-engine-bot';

const GAME_ID = 'splendor';
const N = 100;

const SEED_BASE_GATE1 = 1_010_000;
const SEED_BASE_GATE2 = 1_011_000;
const SEED_BASE_ORDER_PROBE = 1_014_000;
const BOT_SEED_BASE = { gate1: 1_010_101, gate2: 1_010_102, orderProbe: 1_010_103 } as const;

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
  const adapter = eraseAdapter(splendorAdapter);
  const midBot = splendorMidBot;
  const heuristic = splendorAdapter.baselines.heuristic;
  const opusBot = splendorOpusBot;

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

  // heuristicBeatsL2: require heuristic > L1(mid) > L2 (splendor's actual
  // finding). Otherwise (l2BeatsHeuristic, the dominion/gomoku/hearthstone
  // case, or inconclusive): fall back to the documented precedent polarity
  // (L1 beats heuristic, L1 loses to L2).
  const gate1Criterion = heuristicBeatsL2 ? 'winRateCI.upper < 0.5 (heuristic > L2 order)' : 'winRateCI.lower > 0.5 (precedent order)';
  const gate2Criterion = heuristicBeatsL2 ? 'winRateCI.lower > 0.5 (heuristic > L2 order)' : 'winRateCI.upper < 0.5 (precedent order)';

  console.log(`  Gate 1) L1(mid) vs heuristic ... (criterion: ${gate1Criterion})`);
  const gate1 = runHeadToHead(adapter, midBot, heuristic, seeds(SEED_BASE_GATE1, N), BOT_SEED_BASE.gate1);
  const gate1Pass = heuristicBeatsL2 ? gate1.winRateCI.upper < 0.5 : gate1.winRateCI.lower > 0.5;
  console.log(
    `     winRate=${pct(gate1.candidateWinRate)} CI=${ci(gate1)} blocks=${gate1.blocks} -> ${gate1Pass ? 'PASS' : 'FAIL'}`,
  );

  console.log(`  Gate 2) L1(mid) vs L2(opus) ... (criterion: ${gate2Criterion})`);
  const gate2 = runHeadToHead(adapter, midBot, opusBot, seeds(SEED_BASE_GATE2, N), BOT_SEED_BASE.gate2);
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
      note: 'heuristic vs L2(opus) — decides gate polarity. heuristicBeatsL2 true means splendor deviates from the dominion/gomoku/hearthstone precedent (there, L2 always beats heuristic).',
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
 * The L3 bot (../experiments/splendor-engine-bot.ts) is a *third style*
 * ("엔진 우선 + 귀족 타일 정렬", per the task's design brief), written without
 * reading splendor-opus-bot.ts, and is registered with role 'holdout' — it
 * exists to judge candidates, never to give them feedback.
 *
 *   Gate 1 (L3 > heuristic): runHeadToHead over seeds 1_012_000+.
 *     Passes iff winRateCI.lower > 0.5.
 *   Gate 2 (fingerprint distance from L2): replay heuristic self-play games
 *     over seeds 1_013_000+, and at every decision point ask L3 and L2 what
 *     they would do (the game itself is always advanced by the heuristic, so
 *     both are probed on an identical, style-neutral state distribution).
 *     Passes iff the encoded choices agree on fewer than AGREEMENT_MAX of
 *     those points — an L3 that mostly mirrors L2 is not an independent
 *     judge.
 *
 * There is deliberately NO win-rate gate against L2: a holdout anchor is
 * defined by style independence, not by being stronger or weaker than the
 * feedback tier.
 *
 * Same permanence caveat as main(): registerAnchor seals the id forever, so
 * getAnchor is checked first and registration is skipped when either gate
 * fails.
 */

const SEED_BASE_L3_GATE1 = 1_012_000;
const SEED_BASE_L3_GATE2 = 1_013_000;
const BOT_SEED_BASE_L3 = { gate1: 1_011_101, gate2: 1_011_102 } as const;
const N_L3_GATE1 = 100;
const N_L3_PROBE = 20;
const AGREEMENT_MAX = 0.7;
const STYLE2_L3_ANCHOR_ID = 'external-style2-l3';

interface FingerprintProbe {
  readonly games: number;
  readonly decisionPoints: number;
  readonly agreements: number;
  readonly agreementRate: number;
}

/**
 * Walk heuristic-vs-heuristic games and count how often L3 and L2 would pick
 * the same encoded choice. Only the heuristic's choice is ever applied, so
 * neither probed bot steers the trajectory toward its own comfortable states.
 */
function probeFingerprintAgreement(probeSeeds: readonly number[], botSeedBase: number): FingerprintProbe {
  const heuristic = splendorAdapter.baselines.heuristic;
  let decisionPoints = 0;
  let agreements = 0;

  for (const seed of probeSeeds) {
    const botSeed = botSeedBase + seed;
    const driver = heuristic(botSeed);
    const l3 = splendorEngineBot(botSeed);
    const l2 = splendorOpusBot(botSeed);

    let state = splendorAdapter.createInitialState(seed);
    let decision = splendorAdapter.currentDecision(state);
    while (decision !== null) {
      const observation = splendorAdapter.getObservation(state, decision.player);
      const legal = splendorAdapter.getLegalChoices(state);

      decisionPoints += 1;
      const l3Choice = splendorAdapter.encodeChoice(l3.decide(decision.decisionPoint, observation, legal));
      const l2Choice = splendorAdapter.encodeChoice(l2.decide(decision.decisionPoint, observation, legal));
      if (l3Choice === l2Choice) agreements += 1;

      state = splendorAdapter.applyChoice(state, driver.decide(decision.decisionPoint, observation, legal));
      decision = splendorAdapter.currentDecision(state);
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
  const adapter = eraseAdapter(splendorAdapter);

  console.log(`=== ${GAME_ID} L3 holdout anchor gate ===`);

  console.log(`  Gate 1) L3(engine) vs heuristic (N=${N_L3_GATE1}) ...`);
  const gate1 = runHeadToHead(
    adapter,
    splendorEngineBot,
    splendorAdapter.baselines.heuristic,
    seeds(SEED_BASE_L3_GATE1, N_L3_GATE1),
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
      n: N_L3_GATE1,
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
