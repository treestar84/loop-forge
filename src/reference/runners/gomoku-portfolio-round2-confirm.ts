/**
 * gomoku-portfolio-round2-confirm — GAP-11 Phase 4-B follow-up (team lead
 * instruction after portfolio-round2.json's first challenge measurement):
 * v7's composed bot (registry v7, promoted by gomoku-portfolio-round2.ts —
 * `[...v6.flags, mcts10-s256-combined-w16, mcts10-s256-combined-w16-c04,
 * mcts12-s256-opusclone-w16]`, which composeBot's "later MCTS flag ignores
 * base" rule collapses to `mcts12-s256-opusclone-w16` alone at runtime, same
 * as every prior registry version's own composed-bot behavior) landed at
 * vs-L2 winRate=50.6% (N=40, CI=[41.9%, 59.4%]) — a near-miss on the
 * transcendence trigger's CI-lower-bound-over-0.5 threshold, close enough
 * that N=40's own sampling noise could be hiding the true answer either way.
 *
 * This script:
 *   1. Re-measures v7 vs L2 at N=200 (fresh, non-overlapping seeds) —
 *      confirmatory, not exploratory: the point estimate and CI reported
 *      here are what the transcendence trigger check below is actually
 *      gated on, not the original N=40 number.
 *   2. If (and only if) the confirmatory winRateCI.lower > 0.5, runs the L3
 *      holdout head-to-head (gomoku-positional-bot.ts,
 *      'external-style2-l3') at N=100 fresh seeds, gate-free
 *      (`runHeadToHead`, no LossReport/probe-bank generation from the
 *      result — same holdout guard gomoku-portfolio-round2.ts's own
 *      transcendence section documents).
 *   3. Updates `runs/gomoku/portfolio-round2.json`'s `transcendence` field
 *      in place (every other field in that file is left untouched) —
 *      superseding the original N=40-based "not triggered" verdict with
 *      the confirmatory result, honestly recorded either way.
 *
 * Fresh seeds (non-overlapping with every range gomoku-portfolio-round2.ts's
 * own doc comment lists, including its own reserved-but-unused
 * 536_000-536_099 transcendence range): confirmatory measurement
 * 537_000-537_199 (N=200), L3 holdout (only if triggered) 538_000-538_099
 * (N=100). Bot seed bases: 989_601 (confirmatory), 989_701 (L3).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { loadOrCreateRegistry } from '../../artifacts/game-state';
import { gomokuAdapter } from '../gomoku';
import { gomokuOpusBot } from '../experiments/gomoku-opus-bot';
import { gomokuPositionalBot } from '../experiments/gomoku-positional-bot';
import {
  GOMOKU_MCTS_CONFIG,
  GOMOKU_MCTS_FLAG,
  GOMOKU_MCTS_HR_CONFIG,
  GOMOKU_MCTS_HR_FLAG,
  GOMOKU_MCTS2_S256_CONFIG,
  GOMOKU_MCTS2_S256_FLAG,
  GOMOKU_MCTS2_S256_HR_CONFIG,
  GOMOKU_MCTS2_S256_HR_FLAG,
  gomokuMctsFlagSpecFor,
  gomokuMcts2S256CrFlagSpec,
  gomokuMcts2S512CrFlagSpec,
} from './shared/gomoku-mcts-flag';
import { buildCandidates as buildRound1Candidates } from './shared/gomoku-round1-candidates';
import { buildRound2Candidates } from './shared/gomoku-round2-candidates';

const GAME_ID = 'gomoku';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_TRIGGER_THRESHOLD = 0.5;

const CONFIRM_N = 200;
const CONFIRM_SEED_BASE = 537_000;
const CONFIRM_BOT_SEED_BASE = 989_601;

const L3_N = 100;
const L3_SEED_BASE = 538_000;
const L3_BOT_SEED_BASE = 989_701;

function seeds(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function ciStr(result: { readonly winRateCI: { readonly lower: number; readonly upper: number } }): string {
  return `[${pct(result.winRateCI.lower)}, ${pct(result.winRateCI.upper)}]`;
}

function main(): void {
  console.log('=== gomoku portfolio round2 v7 확증 측정 (GAP-11 Phase 4-B 후속 지시) ===');

  const bareAdapter = eraseAdapter(gomokuAdapter);
  // Same full v6/v7-flag-resolving adapter reconstruction gomoku-portfolio-round2.ts
  // itself uses (that file's own doc comment) — v7 = v6's flags plus this
  // round's 3 adopted flags, so the adapter needs every dynamic flag both
  // rounds can name.
  const round1Candidates = buildRound1Candidates(bareAdapter);
  const round2Candidates = buildRound2Candidates(bareAdapter);
  const adapter = withStrategyFlags(bareAdapter, [
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_CONFIG, GOMOKU_MCTS_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_HR_CONFIG, GOMOKU_MCTS_HR_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_CONFIG, GOMOKU_MCTS2_S256_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_HR_CONFIG, GOMOKU_MCTS2_S256_HR_FLAG),
    gomokuMcts2S256CrFlagSpec(bareAdapter),
    gomokuMcts2S512CrFlagSpec(bareAdapter),
    ...round1Candidates.map((candidate) => candidate.spec),
    ...round2Candidates.map((candidate) => candidate.spec),
  ]);

  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== 'v7') {
    throw new Error(
      `gomoku-portfolio-round2-confirm: registry latest=${latest?.version ?? '(none)'} — expected v7 (run gomoku-portfolio-round2.ts's promotion first)`,
    );
  }
  console.log(`   v7 flags=[${latest.flags.join(', ')}]`);
  const v7Bot = composeBot(adapter, latest.flags);

  console.log(`1) v7 vs L2 확증 측정 (N=${CONFIRM_N}, 신규 시드 ${CONFIRM_SEED_BASE}-${CONFIRM_SEED_BASE + CONFIRM_N - 1})`);
  const confirmResult: HeadToHeadResult = runHeadToHead(
    adapter,
    v7Bot,
    gomokuOpusBot,
    seeds(CONFIRM_SEED_BASE, CONFIRM_N),
    CONFIRM_BOT_SEED_BASE,
  );
  console.log(
    `   winRate=${pct(confirmResult.candidateWinRate)} CI=${ciStr(confirmResult)} drawRate=${pct(confirmResult.drawRate)} blocks=${confirmResult.blocks}`,
  );

  const triggered = confirmResult.winRateCI.lower > TRANSCENDENCE_TRIGGER_THRESHOLD;
  console.log(
    `2) 초월 판정 트리거 검사: winRateCI.lower=${pct(confirmResult.winRateCI.lower)} ${triggered ? '>' : '<='} ${pct(TRANSCENDENCE_TRIGGER_THRESHOLD)} -> ${triggered ? '트리거됨' : '미달'}`,
  );

  let l3Result: HeadToHeadResult | null = null;
  if (triggered) {
    console.log(`   L3 홀드아웃 판정 실행 (N=${L3_N}, 신규 시드 ${L3_SEED_BASE}-${L3_SEED_BASE + L3_N - 1}, 게이트 없음)`);
    l3Result = runHeadToHead(adapter, v7Bot, gomokuPositionalBot, seeds(L3_SEED_BASE, L3_N), L3_BOT_SEED_BASE);
    console.log(
      `   L3(${L3_ANCHOR_ID}) vs v7: winRate=${pct(l3Result.candidateWinRate)} CI=${ciStr(l3Result)} blocks=${l3Result.blocks}`,
    );
    // 홀드아웃 가드: trajectoryCollector 없이 호출했으므로 궤적 자체가 수집되지
    // 않는다 — LossReport/probe-bank 생성 재료가 없다(승률 숫자만 기록).
  } else {
    console.log('   미달 — L3 홀드아웃 판정 미실행');
  }

  console.log('3) runs/gomoku/portfolio-round2.json의 transcendence 필드 갱신 (다른 필드는 그대로 유지)');
  const summaryPath = join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round2.json');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>;
  summary.transcendence = {
    triggered,
    threshold: TRANSCENDENCE_TRIGGER_THRESHOLD,
    confirmatoryMeasurement: {
      note:
        '원래 challenge N=40 측정(vs L2 50.6%, CI=[41.9%, 59.4%])이 트리거 임계값 부근이라 팀리드 지시로 N=200 확증 측정을 재실행 — 이 값이 실제 트리거 판정 기준.',
      subject: 'v7 (registry v7 composed bot)',
      anchorId: L2_ANCHOR_ID,
      n: CONFIRM_N,
      winRate: confirmResult.candidateWinRate,
      winRateCI: confirmResult.winRateCI,
      drawRate: confirmResult.drawRate,
      blocks: confirmResult.blocks,
    },
    ...(triggered && l3Result !== null
      ? {
          entries: [
            {
              flag: 'v7 (composed bot, effectively mcts12-s256-opusclone-w16 under composeBot override semantics)',
              wasAdopted: true,
              triggeredBy: { l2WinRate: confirmResult.candidateWinRate, l2WinRateCILower: confirmResult.winRateCI.lower },
              l3AnchorId: L3_ANCHOR_ID,
              l3WinRate: l3Result.candidateWinRate,
              l3WinRateCI: l3Result.winRateCI,
              l3Blocks: l3Result.blocks,
              n: L3_N,
              note: '홀드아웃 가드: LossReport/probe-bank 생성 없음 — 승률 숫자만 기록.',
            },
          ],
        }
      : {
          reason: `확증 측정(N=${CONFIRM_N})에서도 winRateCI.lower > 0.5에 도달하지 못함 — L3 홀드아웃 미실행.`,
        }),
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`   저장: runs/${GAME_ID}/portfolio-round2.json`);
}

main();
