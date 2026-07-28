/**
 * hearthstone-anchor-ladder — measurement gate for the L1/L2 anchor ladder
 * (docs/GAP-ANALYSIS-11.md D3/Phase 1-C, docs/adr/0012): registers this
 * game's mid-skill bot (../experiments/hearthstone-mid-bot.ts) as the
 * 'external-mid-l1' anchor and the existing Opus bot
 * (../experiments/hearthstone-opus-bot.ts) as the 'external-opus-l2' anchor,
 * but ONLY after both gates below pass — anchors are permanently frozen once
 * registered (BaselineRegistry's registerAnchor doc comment), so a bad
 * registration cannot be corrected by re-running this file.
 *
 * Gate 1 (L1 > heuristic): runHeadToHead(midBot, baselines.heuristic) over a
 *   fixed seed block. Passes iff winRateCI.lower > 0.5.
 * Gate 2 (L1 < L2): runHeadToHead(midBot, opusBot) over a second, non-
 *   overlapping seed block. Passes iff winRateCI.upper < 0.5.
 *
 * Seeds are drawn from 994_000+ (gate 1) and 995_000+ (gate 2) — a fresh
 * range distinct from hearthstone-benchmark.ts's SEED_BASE=55_000 (N up to
 * 1600, i.e. 55_000-56_599).
 *
 * Idempotent across reruns: `getAnchor` is checked before every
 * `registerAnchor` call, so a second run against an already-sealed anchor
 * skips registration instead of throwing.
 *
 * Note on registry pitfall (task brief "주의" section): registry.latest()
 * for this game may compose dynamic strategy flags via `withStrategyFlags`,
 * which breaks when composed onto this reference adapter directly — this
 * runner never touches that path (it only ever plays heuristic/midBot/opusBot
 * against each other via runHeadToHead), so it is unaffected.
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
import { hearthstoneAdapter } from '../hearthstone';
import { hearthstoneOpusBot } from '../experiments/hearthstone-opus-bot';
import { hearthstoneMidBot } from '../experiments/hearthstone-mid-bot';
import { hearthstoneTempoBot } from '../experiments/hearthstone-tempo-bot';

const GAME_ID = 'hearthstone';
const N = 100;

const SEED_BASE_GATE1 = 994_000;
const SEED_BASE_GATE2 = 995_000;
const BOT_SEED_BASE = { gate1: 983_101, gate2: 983_102 } as const;

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
  const adapter = eraseAdapter(hearthstoneAdapter);
  const midBot = hearthstoneMidBot;
  const heuristic = hearthstoneAdapter.baselines.heuristic;
  const opusBot = hearthstoneOpusBot;

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
 * L3 게이트 (GAP-11 Phase 1-D, D3/ADR-0012) — 위 main()의 L1/L2 래더와 독립.
 * '제3의 스타일' 고수봇(../experiments/hearthstone-tempo-bot.ts)을 판정용
 * 홀드아웃 앵커 'external-style2-l3'로 등록한다.
 *
 * Gate 1 (L3 > heuristic): runHeadToHead over seeds 1_000_000+ (N=100).
 *   Passes iff winRateCI.lower > 0.5.
 * Gate 2 (지문 거리): heuristic 자기대국 20판(seeds 1_001_000+)의 모든 결정 지점에서
 *   L3와 L2에게 같은 (decisionPoint, observation, legal)을 질의해 선택 일치율을 잰다.
 *   Passes iff agreementRate < 0.7 (스타일이 실제로 다름).
 * L2와의 승률 게이트는 두지 않는다 — 홀드아웃 판정 앵커는 비이행성을 허용한다.
 */
const SEED_BASE_L3_GATE1 = 1_000_000;
const SEED_BASE_L3_GATE2 = 1_001_000;
const L3_BOT_SEED_BASE = { gate1: 986_101, gate2: 986_102 } as const;
const L3_GATE1_N = 100;
const L3_GATE2_GAMES = 20;
const L3_AGREEMENT_MAX = 0.7;
const STYLE2_L3_ANCHOR_ID = 'external-style2-l3';

interface AgreementProbe {
  readonly points: number;
  readonly agreements: number;
  readonly agreementRate: number;
  readonly games: number;
}

/** Replays heuristic self-play and asks L3/L2 what they would do at each decision point. */
function probeFingerprintAgreement(seedList: readonly number[], botSeed: number): AgreementProbe {
  const l3 = hearthstoneTempoBot(botSeed);
  const l2 = hearthstoneOpusBot(botSeed);
  const driver = hearthstoneAdapter.baselines.heuristic(botSeed);

  let points = 0;
  let agreements = 0;

  for (const seed of seedList) {
    let state = hearthstoneAdapter.createInitialState(seed);
    let pending = hearthstoneAdapter.currentDecision(state);
    while (pending !== null) {
      const observation = hearthstoneAdapter.getObservation(state, pending.player);
      const legal = hearthstoneAdapter.getLegalChoices(state);

      const l3Key = hearthstoneAdapter.encodeChoice(l3.decide(pending.decisionPoint, observation, legal));
      const l2Key = hearthstoneAdapter.encodeChoice(l2.decide(pending.decisionPoint, observation, legal));
      points += 1;
      if (l3Key === l2Key) agreements += 1;

      state = hearthstoneAdapter.applyChoice(state, driver.decide(pending.decisionPoint, observation, legal));
      pending = hearthstoneAdapter.currentDecision(state);
    }
  }

  return {
    points,
    agreements,
    agreementRate: points === 0 ? 0 : agreements / points,
    games: seedList.length,
  };
}

function runL3Gate(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const adapter = eraseAdapter(hearthstoneAdapter);
  const heuristic = hearthstoneAdapter.baselines.heuristic;

  console.log(`=== ${GAME_ID} L3 holdout gate (GAP-11 Phase 1-D) ===`);

  console.log(`  Gate 1) L3(tempo) vs heuristic (N=${L3_GATE1_N}) ...`);
  const gate1 = runHeadToHead(
    adapter,
    hearthstoneTempoBot,
    heuristic,
    seeds(SEED_BASE_L3_GATE1, L3_GATE1_N),
    L3_BOT_SEED_BASE.gate1,
  );
  const gate1Pass = gate1.winRateCI.lower > 0.5;
  console.log(
    `     winRate=${pct(gate1.candidateWinRate)} CI=${ci(gate1)} blocks=${gate1.blocks} -> ${gate1Pass ? 'PASS' : 'FAIL'} (need CI lower > 0.5)`,
  );

  console.log(`  Gate 2) 지문 거리: L3 vs L2 선택 일치율 (heuristic 자기대국 ${L3_GATE2_GAMES}판) ...`);
  const probe = probeFingerprintAgreement(seeds(SEED_BASE_L3_GATE2, L3_GATE2_GAMES), L3_BOT_SEED_BASE.gate2);
  const gate2Pass = probe.agreementRate < L3_AGREEMENT_MAX;
  console.log(
    `     agreementRate=${pct(probe.agreementRate)} (${probe.agreements}/${probe.points} points, ${probe.games} games) -> ${gate2Pass ? 'PASS' : 'FAIL'} (need < ${L3_AGREEMENT_MAX})`,
  );

  const bothPass = gate1Pass && gate2Pass;
  let l3Registered = false;
  let l3Skipped = false;

  if (bothPass) {
    const registry = loadOrCreateRegistry(rootDir, GAME_ID);
    if (registry.getAnchor(STYLE2_L3_ANCHOR_ID)) {
      l3Skipped = true;
      console.log(`  게이트 통과 — ${STYLE2_L3_ANCHOR_ID} 이미 봉인되어 등록 skip.`);
    } else {
      registry.registerAnchor({ anchorId: STYLE2_L3_ANCHOR_ID, kind: 'external', role: 'holdout' });
      saveRegistry(rootDir, GAME_ID, registry);
      l3Registered = true;
      console.log(`  게이트 통과 — 등록: ${STYLE2_L3_ANCHOR_ID} (role=holdout, 영구 봉인).`);
    }
  } else {
    console.log('  게이트 실패 — L3 앵커 등록 skip.');
  }

  const outDir = join(rootDir, 'runs', GAME_ID);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'anchor-ladder.json');
  let existing: Record<string, unknown> = {};
  if (existsSync(outPath)) {
    existing = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>;
  }
  const payload = {
    ...existing,
    l3GeneratedAt: new Date().toISOString(),
    l3AnchorId: STYLE2_L3_ANCHOR_ID,
    l3SeedBaseGate1: SEED_BASE_L3_GATE1,
    l3SeedBaseGate2: SEED_BASE_L3_GATE2,
    l3BotSeedBase: L3_BOT_SEED_BASE,
    l3Gate1: { ...gate1, n: L3_GATE1_N, pass: gate1Pass, criterion: 'winRateCI.lower > 0.5' },
    l3Gate2: { ...probe, pass: gate2Pass, criterion: `agreementRate < ${L3_AGREEMENT_MAX}` },
    l3BothPass: bothPass,
    l3Registered,
    l3Skipped,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`  저장: runs/${GAME_ID}/anchor-ladder.json (L3 필드 병합)`);
}

main();
runL3Gate();
