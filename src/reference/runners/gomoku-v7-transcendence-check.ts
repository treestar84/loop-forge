/**
 * gomoku-v7-transcendence-check — team lead instruction: confirm registry v7's
 * transcendence status with a formal protocol run, distinct from the
 * incidental measurement surfaced as a byproduct of gomoku-loss-mining-round4.ts
 * (runs/gomoku/challenge-l2-round4/judgment-summary.json's measurement1:
 * v7 vs L2 N=100, winRate=55.0%, CI=[50.5%, 59.8%] — a mining-run byproduct,
 * not a formal confirmatory measurement).
 *
 * Follows gomoku-portfolio-round2-confirm.ts's precedent shape:
 *   1. Formal v7 vs L2 (external-opus-l2) head-to-head, N=200, fresh seeds,
 *      gate-free (`runHeadToHead`, no LossReport/probe-bank generation).
 *   2. If (and only if) winRateCI.lower > 0.5, run the L3 holdout
 *      transcendence check: v7 vs gomoku-positional-bot (external-style2-l3,
 *      role='holdout', reconfirmed via `registry.getAnchor` before use — the
 *      holdout guard), N=100, fresh seeds, gate-free. No trajectoryCollector,
 *      no mineLosses/mineDraws, no probe-bank writes from this data — pure
 *      win-rate/CI aggregation only, per the holdout-guard principle
 *      (holdout/graduation seed banks and anchor bots must never be
 *      touched/updated by mining machinery).
 *
 * Fresh seed ranges (grepped every N{2,3}_NNN literal across
 * reference/runners/gomoku*.ts and reference/runners/*.ts before picking —
 * prior gomoku ranges occupy 50_000-90_699 (3-column benchmarks),
 * 300_000-301_099/400_000-401_099 (loss-mining round1/round2,
 * prior-diagnostic), 520_000-538_999 (portfolio round1/round2 + confirm),
 * 700_000-700_099 (gomoku.ts noise floor), 800_000-801_099 (loss-mining
 * round4), 981_101-997_999 (anchor-ladder gate/bot seeds); other games use
 * 900_000/910_000 as identity-seed bases, avoided here too even though
 * cross-game seed spaces don't interact):
 *   - confirmatory v7 vs L2: 920_000-920_199 (N=200).
 *   - L3 holdout (only if triggered): 921_000-921_099 (N=100).
 * Bot seed bases (independent space, also fresh — confirmed unused via
 * grep): 978_101 (confirmatory), 978_201 (L3 holdout).
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

const EXPECTED_REGISTRY_VERSION = 'v7';
const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_TRIGGER_THRESHOLD = 0.5;

const CONFIRM_N = 200;
const CONFIRM_SEED_BASE = 920_000;
const CONFIRM_BOT_SEED_BASE = 978_101;

const L3_N = 100;
const L3_SEED_BASE = 921_000;
const L3_BOT_SEED_BASE = 978_201;

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
  console.log('=== 오목 registry v7 초월 판정 확증 (팀리드 지시) ===');

  const bareAdapter = eraseAdapter(gomokuAdapter);
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
  if (latest === undefined || latest.version !== EXPECTED_REGISTRY_VERSION) {
    throw new Error(
      `gomoku-v7-transcendence-check: registry latest=${latest?.version ?? '(none)'} — expected ${EXPECTED_REGISTRY_VERSION}`,
    );
  }
  console.log(`   v7 flags=[${latest.flags.join(', ')}]`);
  const v7Bot = composeBot(adapter, latest.flags);

  console.log(`1) v7 vs L2(${L2_ANCHOR_ID}) 정식 확증 측정 (N=${CONFIRM_N}, 신규 시드 ${CONFIRM_SEED_BASE}-${CONFIRM_SEED_BASE + CONFIRM_N - 1})`);
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
    `2) 초월 트리거 검사: winRateCI.lower=${pct(confirmResult.winRateCI.lower)} ${triggered ? '>' : '<='} ${pct(TRANSCENDENCE_TRIGGER_THRESHOLD)} -> ${triggered ? '트리거됨' : '미달'}`,
  );

  let l3Result: HeadToHeadResult | null = null;
  let l3AnchorConfirmed = false;
  if (triggered) {
    const l3Anchor = registry.getAnchor(L3_ANCHOR_ID);
    if (l3Anchor === undefined || l3Anchor.role !== 'holdout') {
      throw new Error(
        `gomoku-v7-transcendence-check: L3 anchor "${L3_ANCHOR_ID}" role=${l3Anchor?.role ?? '(none)'} — expected role='holdout' (홀드아웃 가드 재확인 실패)`,
      );
    }
    l3AnchorConfirmed = true;
    console.log(`   L3 앵커(${L3_ANCHOR_ID}) role='holdout' 확인됨.`);
    console.log(`   L3 홀드아웃 초월 판정 실행 (N=${L3_N}, 신규 시드 ${L3_SEED_BASE}-${L3_SEED_BASE + L3_N - 1}, 게이트 없음, trajectoryCollector 미사용)`);
    l3Result = runHeadToHead(adapter, v7Bot, gomokuPositionalBot, seeds(L3_SEED_BASE, L3_N), L3_BOT_SEED_BASE);
    console.log(
      `   v7 vs L3(${L3_ANCHOR_ID}): winRate=${pct(l3Result.candidateWinRate)} CI=${ciStr(l3Result)} drawRate=${pct(l3Result.drawRate)} blocks=${l3Result.blocks}`,
    );
    // 홀드아웃 가드: options.trajectoryCollector를 넘기지 않았으므로 이 판의
    // 궤적은 수집되지 않는다 — mineLosses/mineDraws/buildProbeBank 등 어떤
    // 후속 함수도 이 결과에서 LossReport나 프로브를 만들 재료가 없다.
  } else {
    console.log('   미달 — L3 홀드아웃 판정 미실행 (4회전 후보 설계로 넘어갈 준비, 별도 지시 대기)');
  }

  const verdict: 'transcended' | 'not-transcended' | null =
    l3Result === null ? null : l3Result.winRateCI.lower > TRANSCENDENCE_TRIGGER_THRESHOLD ? 'transcended' : 'not-transcended';

  const summary = {
    gameId: GAME_ID,
    registryVersion: EXPECTED_REGISTRY_VERSION,
    generatedAt: new Date().toISOString(),
    confirmatoryMeasurement: {
      note:
        '팀리드 지시에 따른 정식 확증(N=200) — runHeadToHead 게이트 없는 순수 집계. runs/gomoku/challenge-l2-round4/judgment-summary.json의 measurement1(4회전 채굴 러너 부산물, N=100, 55.0%)과는 별개의 정식 프로토콜 측정.',
      anchorId: L2_ANCHOR_ID,
      n: CONFIRM_N,
      seedBase: CONFIRM_SEED_BASE,
      winRate: confirmResult.candidateWinRate,
      winRateCI: confirmResult.winRateCI,
      drawRate: confirmResult.drawRate,
      blocks: confirmResult.blocks,
    },
    triggered,
    threshold: TRANSCENDENCE_TRIGGER_THRESHOLD,
    ...(triggered && l3Result !== null
      ? {
          transcendence: {
            ranAt: new Date().toISOString(),
            l3AnchorId: L3_ANCHOR_ID,
            l3AnchorRoleConfirmed: l3AnchorConfirmed,
            n: L3_N,
            seedBase: L3_SEED_BASE,
            winRate: l3Result.candidateWinRate,
            winRateCI: l3Result.winRateCI,
            drawRate: l3Result.drawRate,
            blocks: l3Result.blocks,
            verdict,
            note: '홀드아웃 가드: LossReport/probe-bank 생성 없음(trajectoryCollector 미사용) — 승률/CI 숫자만 기록.',
          },
        }
      : {
          reason: `확증 측정(N=${CONFIRM_N})에서 winRateCI.lower > ${TRANSCENDENCE_TRIGGER_THRESHOLD}에 도달하지 못함 — L3 홀드아웃 미실행.`,
        }),
  };

  const outDir = join(ROOT_DIR, 'runs', GAME_ID);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'v7-transcendence-check.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`3) 저장: runs/${GAME_ID}/v7-transcendence-check.json`);
}

main();
