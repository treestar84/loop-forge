/**
 * gomoku-anchor-ladder — measurement gate for the L1/L2 anchor ladder
 * (docs/GAP-ANALYSIS-11.md D3/Phase 1-C, docs/adr/0012): registers this
 * game's mid-skill bot (../experiments/gomoku-mid-bot.ts) as the 'external-
 * mid-l1' anchor and the existing Opus bot (../experiments/gomoku-opus-bot.ts)
 * as the 'external-opus-l2' anchor, but ONLY after both gates below pass —
 * anchors are permanently frozen once registered (BaselineRegistry's
 * registerAnchor doc comment), so a bad registration cannot be corrected by
 * re-running this file.
 *
 * Gate 1 (L1 > heuristic): runHeadToHead(midBot, baselines.heuristic) over a
 *   fixed seed block. Passes iff winRateCI.lower > 0.5.
 * Gate 2 (L1 < L2): runHeadToHead(midBot, opusBot) over a second, non-
 *   overlapping seed block. Passes iff winRateCI.upper < 0.5.
 *
 * Seeds are drawn from 990_000+ (gate 1) and 991_000+ (gate 2) — a fresh
 * range distinct from every existing gomoku benchmark runner's seed base
 * (gomoku-benchmark.ts/-v4/-v4-full/-v5 collectively occupy 50_000-91_299;
 * see each file's own SEED_BASE constant).
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
import { mkdirSync, writeFileSync } from 'node:fs';

import { eraseAdapter } from '../../loop/erase';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { loadOrCreateRegistry, saveRegistry } from '../../artifacts/game-state';
import { gomokuAdapter } from '../gomoku';
import { gomokuOpusBot } from '../experiments/gomoku-opus-bot';
import { gomokuMidBot } from '../experiments/gomoku-mid-bot';

const GAME_ID = 'gomoku';
const N = 100;

const SEED_BASE_GATE1 = 990_000;
const SEED_BASE_GATE2 = 991_000;
const BOT_SEED_BASE = { gate1: 981_101, gate2: 981_102 } as const;

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
  const adapter = eraseAdapter(gomokuAdapter);
  const midBot = gomokuMidBot;
  const heuristic = gomokuAdapter.baselines.heuristic;
  const opusBot = gomokuOpusBot;

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

main();
