/**
 * janggi-transcendence-check — scratchpad/janggi-gap11-onramp-design-spec.md
 * steps 4-5: now that janggi-anchor-ladder.ts has registered
 * 'external-mid-l1' (feedback), 'external-opus-l2' (feedback), and
 * 'external-style2-l3' (holdout), measure where the just-adopted champion
 * v2 (`janggiPieceSafetyMobility`, `runs/janggi/registry.json`) actually
 * stands relative to those anchors.
 *
 * The design brief is explicit that this round is NOT "confirm v2 already
 * beats the external opus bot" (the splendor/wingspan pattern) — it is "find
 * out, for the first time, how far behind an external strong player v2 is".
 * v2 only ever demonstrated it beats `baselines.heuristic` (its own
 * adoption gate); nothing in that adoption measured it against L2. This
 * runner honestly measures that gap and, only if the numbers actually
 * clear each rung, escalates through the full transcendence ladder — it
 * does not skip stages even when a miss looks likely.
 *
 * Structure (step 4 informational, step 5 gated — same order as
 * gomoku-v7-transcendence-check.ts/gomoku-v9-large-confirm.ts's canonical
 * "trigger -> confirm -> L3 holdout" shape, but starting from a fresh
 * trigger since (unlike gomoku's v7/v9) no prior v2-vs-L2 measurement exists
 * anywhere for janggi):
 *   4. Challenge (informational only, no gating): v2 vs L1(mid), N=100, and
 *      v2 vs L2(opus), N=100 — separate fresh seed banks from step 5's
 *      ladder measurements below (comparabilityKey caution — these numbers
 *      are reported side by side with step 5's but must never be summed or
 *      averaged with it).
 *   5. Transcendence ladder (gated, order enforced — never skips a stage):
 *      a. Trigger: v2 vs L2, N=100, fresh seeds. Proceeds only if
 *         winRateCI.lower > 0.5.
 *      b. Confirm: v2 vs L2, N=200, fresh seeds. Proceeds only if (a) passed
 *         AND this also has winRateCI.lower > 0.5.
 *      c. L3 holdout: v2 vs L3(engine, role='holdout', reconfirmed via
 *         registry.getAnchor before use), N=100, fresh seeds. Final verdict
 *         requires winRateCI.lower > 0.5 here too.
 *   Any stage failing to clear winRateCI.lower > 0.5 stops the ladder there
 *   and the run is recorded honestly as "not transcended" (or "trigger not
 *   met" / "confirm not met") — the design brief explicitly expects this is
 *   the likely outcome and treats reaching-but-not-clearing every rung as a
 *   legitimate, useful result in its own right.
 *
 * All measurements below are gate-free `runHeadToHead` calls — no
 * LossReport/probe-bank generation, no trajectoryCollector, no mining. The
 * holdout anchor (L3) and its bot are only ever read, never updated; no
 * anchor bot is touched by this file.
 *
 * Fresh seed ranges (grepped every `1_0NN_NNN` literal across
 * `reference/runners/*.ts` before picking — occupied through
 * 1_028_101 by other games' anchor-ladder/L3/transcendence-check runners,
 * and this game's own janggi-anchor-ladder.ts just claimed
 * 1_030_000-1_034_099 plus bot-seed bases 1_030_101-1_031_103):
 *   - Challenge v2 vs L1: 1_035_000-1_035_099 (N=100), botSeedBase 1_035_101.
 *   - Challenge v2 vs L2: 1_036_000-1_036_099 (N=100), botSeedBase 1_036_101.
 *   - Ladder trigger v2 vs L2: 1_040_000-1_040_099 (N=100), botSeedBase
 *     1_040_101.
 *   - Ladder confirm v2 vs L2: 1_041_000-1_041_199 (N=200), botSeedBase
 *     1_041_101.
 *   - Ladder L3 holdout v2 vs L3: 1_042_000-1_042_099 (N=100), botSeedBase
 *     1_042_101.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import type { AnyBotFactory } from '../../contract/types';
import { eraseAdapter } from '../../loop/erase';
import { composeBot } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { loadOrCreateRegistry } from '../../artifacts/game-state';
import { janggiAdapter } from '../janggi';
import { janggiOpusBot } from '../experiments/janggi-opus-bot';
import { janggiMidBot } from '../experiments/janggi-mid-bot';
import { janggiEngineBot } from '../experiments/janggi-engine-bot';

const GAME_ID = 'janggi';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const EXPECTED_REGISTRY_VERSION = 'v2';
const L1_ANCHOR_ID = 'external-mid-l1';
const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_THRESHOLD = 0.5;

const CHALLENGE_N = 100;
const CHALLENGE_L1_SEED_BASE = 1_035_000;
const CHALLENGE_L1_BOT_SEED_BASE = 1_035_101;
const CHALLENGE_L2_SEED_BASE = 1_036_000;
const CHALLENGE_L2_BOT_SEED_BASE = 1_036_101;

const TRIGGER_N = 100;
const TRIGGER_SEED_BASE = 1_040_000;
const TRIGGER_BOT_SEED_BASE = 1_040_101;

const CONFIRM_N = 200;
const CONFIRM_SEED_BASE = 1_041_000;
const CONFIRM_BOT_SEED_BASE = 1_041_101;

const L3_N = 100;
const L3_SEED_BASE = 1_042_000;
const L3_BOT_SEED_BASE = 1_042_101;

function seeds(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function ciStr(result: HeadToHeadResult): string {
  return `[${pct(result.winRateCI.lower)}, ${pct(result.winRateCI.upper)}]`;
}

function main(): void {
  console.log('=== 장기 v2 GAP-11 편입: challenge + 초월 사다리 (메인 루프 설계 브리프) ===');

  const adapter = eraseAdapter(janggiAdapter);
  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== EXPECTED_REGISTRY_VERSION) {
    throw new Error(
      `janggi-transcendence-check: registry latest=${latest?.version ?? '(none)'} — expected ${EXPECTED_REGISTRY_VERSION}`,
    );
  }
  console.log(`   v2 flags=[${latest.flags.join(', ')}]`);
  const v2Bot = composeBot(adapter, latest.flags);

  for (const anchorId of [L1_ANCHOR_ID, L2_ANCHOR_ID]) {
    const anchor = registry.getAnchor(anchorId);
    if (anchor === undefined || anchor.role !== 'feedback') {
      throw new Error(
        `janggi-transcendence-check: anchor "${anchorId}" role=${anchor?.role ?? '(none)'} — expected role='feedback'`,
      );
    }
  }
  console.log(`   앵커 확인됨: ${L1_ANCHOR_ID}(feedback), ${L2_ANCHOR_ID}(feedback)`);

  // -----------------------------------------------------------------------
  // Step 4: challenge (informational only, no gating on these two numbers).
  // -----------------------------------------------------------------------
  console.log(
    `\n1) [challenge, 정보용] v2 vs L1(${L1_ANCHOR_ID}) (N=${CHALLENGE_N}, 신규 시드 ${CHALLENGE_L1_SEED_BASE}-${CHALLENGE_L1_SEED_BASE + CHALLENGE_N - 1})`,
  );
  const challengeL1: HeadToHeadResult = runHeadToHead(
    adapter,
    v2Bot,
    janggiMidBot as AnyBotFactory,
    seeds(CHALLENGE_L1_SEED_BASE, CHALLENGE_N),
    CHALLENGE_L1_BOT_SEED_BASE,
  );
  console.log(
    `   winRate=${pct(challengeL1.candidateWinRate)} CI=${ciStr(challengeL1)} drawRate=${pct(challengeL1.drawRate)} blocks=${challengeL1.blocks}`,
  );

  console.log(
    `2) [challenge, 정보용] v2 vs L2(${L2_ANCHOR_ID}) (N=${CHALLENGE_N}, 신규 시드 ${CHALLENGE_L2_SEED_BASE}-${CHALLENGE_L2_SEED_BASE + CHALLENGE_N - 1})`,
  );
  const challengeL2: HeadToHeadResult = runHeadToHead(
    adapter,
    v2Bot,
    janggiOpusBot as AnyBotFactory,
    seeds(CHALLENGE_L2_SEED_BASE, CHALLENGE_N),
    CHALLENGE_L2_BOT_SEED_BASE,
  );
  console.log(
    `   winRate=${pct(challengeL2.candidateWinRate)} CI=${ciStr(challengeL2)} drawRate=${pct(challengeL2.drawRate)} blocks=${challengeL2.blocks}`,
  );

  // -----------------------------------------------------------------------
  // Step 5: transcendence ladder (gated, order enforced).
  // -----------------------------------------------------------------------
  console.log(
    `\n3) [ladder a) 트리거] v2 vs L2 (N=${TRIGGER_N}, 신규 시드 ${TRIGGER_SEED_BASE}-${TRIGGER_SEED_BASE + TRIGGER_N - 1})`,
  );
  const triggerResult: HeadToHeadResult = runHeadToHead(
    adapter,
    v2Bot,
    janggiOpusBot as AnyBotFactory,
    seeds(TRIGGER_SEED_BASE, TRIGGER_N),
    TRIGGER_BOT_SEED_BASE,
  );
  console.log(
    `   winRate=${pct(triggerResult.candidateWinRate)} CI=${ciStr(triggerResult)} drawRate=${pct(triggerResult.drawRate)} blocks=${triggerResult.blocks}`,
  );
  const triggered = triggerResult.winRateCI.lower > TRANSCENDENCE_THRESHOLD;
  console.log(
    `   트리거 판정: winRateCI.lower=${pct(triggerResult.winRateCI.lower)} ${triggered ? '>' : '<='} ${pct(TRANSCENDENCE_THRESHOLD)} -> ${triggered ? '트리거됨' : '미달'}`,
  );

  let confirmResult: HeadToHeadResult | null = null;
  let confirmed = false;
  if (triggered) {
    console.log(
      `4) [ladder b) 확증] v2 vs L2 (N=${CONFIRM_N}, 신규 시드 ${CONFIRM_SEED_BASE}-${CONFIRM_SEED_BASE + CONFIRM_N - 1})`,
    );
    confirmResult = runHeadToHead(
      adapter,
      v2Bot,
      janggiOpusBot as AnyBotFactory,
      seeds(CONFIRM_SEED_BASE, CONFIRM_N),
      CONFIRM_BOT_SEED_BASE,
    );
    console.log(
      `   winRate=${pct(confirmResult.candidateWinRate)} CI=${ciStr(confirmResult)} drawRate=${pct(confirmResult.drawRate)} blocks=${confirmResult.blocks}`,
    );
    confirmed = confirmResult.winRateCI.lower > TRANSCENDENCE_THRESHOLD;
    console.log(
      `   확증 판정: winRateCI.lower=${pct(confirmResult.winRateCI.lower)} ${confirmed ? '>' : '<='} ${pct(TRANSCENDENCE_THRESHOLD)} -> ${confirmed ? '확증됨' : '미달'}`,
    );
  } else {
    console.log('4) [ladder b) 확증] 미실행 — 트리거 미달 (순서 건너뛰기 금지 규칙 준수)');
  }

  let l3Result: HeadToHeadResult | null = null;
  let l3AnchorConfirmed = false;
  let verdict: 'transcended' | 'not-transcended' | null = null;
  if (confirmed) {
    const l3Anchor = registry.getAnchor(L3_ANCHOR_ID);
    if (l3Anchor === undefined || l3Anchor.role !== 'holdout') {
      throw new Error(
        `janggi-transcendence-check: L3 anchor "${L3_ANCHOR_ID}" role=${l3Anchor?.role ?? '(none)'} — expected role='holdout' (홀드아웃 가드 재확인 실패)`,
      );
    }
    l3AnchorConfirmed = true;
    console.log(`   L3 앵커(${L3_ANCHOR_ID}) role='holdout' 확인됨.`);
    console.log(
      `5) [ladder c) L3 홀드아웃] v2 vs L3 (N=${L3_N}, 신규 시드 ${L3_SEED_BASE}-${L3_SEED_BASE + L3_N - 1}, 게이트 없음, trajectoryCollector 미사용)`,
    );
    l3Result = runHeadToHead(
      adapter,
      v2Bot,
      janggiEngineBot as AnyBotFactory,
      seeds(L3_SEED_BASE, L3_N),
      L3_BOT_SEED_BASE,
    );
    console.log(
      `   winRate=${pct(l3Result.candidateWinRate)} CI=${ciStr(l3Result)} drawRate=${pct(l3Result.drawRate)} blocks=${l3Result.blocks}`,
    );
    verdict = l3Result.winRateCI.lower > TRANSCENDENCE_THRESHOLD ? 'transcended' : 'not-transcended';
    console.log(`   최종 판정: ${verdict}`);
    // 홀드아웃 가드: trajectoryCollector를 넘기지 않았으므로 이 판의 궤적은
    // 수집되지 않는다 — mineLosses/mineDraws/buildProbeBank 등 어떤 후속
    // 함수도 이 결과에서 LossReport나 프로브를 만들 재료가 없다. 앵커 봇도
    // 갱신하지 않는다(읽기만 한다).
  } else if (triggered) {
    console.log('5) [ladder c) L3 홀드아웃] 미실행 — 확증 미달 (순서 건너뛰기 금지 규칙 준수)');
  } else {
    console.log('5) [ladder c) L3 홀드아웃] 미실행 — 트리거 미달 (순서 건너뛰기 금지 규칙 준수)');
  }

  const summary = {
    gameId: GAME_ID,
    registryVersion: EXPECTED_REGISTRY_VERSION,
    registryFlags: latest.flags,
    generatedAt: new Date().toISOString(),
    designSpecPath: 'scratchpad/janggi-gap11-onramp-design-spec.md (main-loop Fable, steps 4-5)',
    purpose:
      'v2가 heuristic만 이긴 것이지 외부 Opus봇(L2)을 이긴다는 증거는 없었음 — 처음으로 v2 대 L1/L2/L3의 실제 격차를 정직하게 측정.',
    challenge: {
      note: '정보용 측정 — 아래 초월 사다리와 별개 시드 뱅크, comparabilityKey 주의(합산/평균 금지).',
      vsL1: {
        anchorId: L1_ANCHOR_ID,
        n: CHALLENGE_N,
        seedBase: CHALLENGE_L1_SEED_BASE,
        botSeedBase: CHALLENGE_L1_BOT_SEED_BASE,
        winRate: challengeL1.candidateWinRate,
        winRateCI: challengeL1.winRateCI,
        drawRate: challengeL1.drawRate,
        blocks: challengeL1.blocks,
      },
      vsL2: {
        anchorId: L2_ANCHOR_ID,
        n: CHALLENGE_N,
        seedBase: CHALLENGE_L2_SEED_BASE,
        botSeedBase: CHALLENGE_L2_BOT_SEED_BASE,
        winRate: challengeL2.candidateWinRate,
        winRateCI: challengeL2.winRateCI,
        drawRate: challengeL2.drawRate,
        blocks: challengeL2.blocks,
      },
    },
    transcendenceLadder: {
      threshold: TRANSCENDENCE_THRESHOLD,
      trigger: {
        anchorId: L2_ANCHOR_ID,
        n: TRIGGER_N,
        seedBase: TRIGGER_SEED_BASE,
        botSeedBase: TRIGGER_BOT_SEED_BASE,
        winRate: triggerResult.candidateWinRate,
        winRateCI: triggerResult.winRateCI,
        drawRate: triggerResult.drawRate,
        blocks: triggerResult.blocks,
        triggered,
      },
      ...(confirmResult !== null
        ? {
            confirm: {
              anchorId: L2_ANCHOR_ID,
              n: CONFIRM_N,
              seedBase: CONFIRM_SEED_BASE,
              botSeedBase: CONFIRM_BOT_SEED_BASE,
              winRate: confirmResult.candidateWinRate,
              winRateCI: confirmResult.winRateCI,
              drawRate: confirmResult.drawRate,
              blocks: confirmResult.blocks,
              confirmed,
            },
          }
        : { confirmReason: '트리거 미달로 확증 단계 미실행.' }),
      ...(l3Result !== null
        ? {
            l3Holdout: {
              anchorId: L3_ANCHOR_ID,
              anchorRoleConfirmed: l3AnchorConfirmed,
              n: L3_N,
              seedBase: L3_SEED_BASE,
              botSeedBase: L3_BOT_SEED_BASE,
              winRate: l3Result.candidateWinRate,
              winRateCI: l3Result.winRateCI,
              drawRate: l3Result.drawRate,
              blocks: l3Result.blocks,
              verdict,
              note: '홀드아웃 가드: LossReport/probe-bank 생성 없음(trajectoryCollector 미사용), 앵커 봇 갱신 없음 — 승률/CI 숫자만 기록.',
            },
          }
        : {
            l3HoldoutReason: confirmed
              ? '(도달 불가 — 코드 경로 오류)'
              : triggered
                ? '확증 단계 미달로 L3 홀드아웃 미실행.'
                : '트리거 단계 미달로 L3 홀드아웃 미실행.',
          }),
    },
    finalVerdict:
      verdict ??
      (triggered ? (confirmed ? '(도달 불가)' : 'not-transcended-at-confirm') : 'not-transcended-at-trigger'),
  };

  const outDir = join(ROOT_DIR, 'runs', GAME_ID);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'v2-transcendence-check.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\n6) 저장: runs/${GAME_ID}/v2-transcendence-check.json`);
}

main();
