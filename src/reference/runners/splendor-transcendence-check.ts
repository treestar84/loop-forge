/**
 * splendor-transcendence-check — GAP-11 정규 편입(E2-A), 메인 루프 설계 브리프
 * `scratchpad/splendor-gap11-onramp-design-spec.md` 그대로 구현한다. 구조는
 * `./gomoku-v7-transcendence-check.ts`(같은 종류 작업의 정본 선례, N=100 트리거
 * → N=200 확증 → L3 홀드아웃)를 그대로 따른다. `gomoku-v9-large-confirm.ts`가
 * 아니라 v7의 3단 사다리 전체를 새로 도는 쪽을 골랐다 — v9-large-confirm은
 * "이미 트리거·확증·L3를 다 거친 후보의 표본만 5배로 키우는 순수 재측정"이고,
 * 스플렌더 v3 챔피언은 이 저장소에서 GAP-11 정규 사다리를 도는 것이 이번이
 * 처음이라 트리거부터 시작해야 한다(브리프 §3 "순서 엄수").
 *
 * 별도 파일로 분리(래더 러너에 통합하지 않음) — 이유: dominion/gomoku/
 * hearthstone-anchor-ladder.ts는 앵커 "등록" 전용이고, 사다리(트리거→확증→
 * L3)는 언제나 별도 파일(gomoku-v7-transcendence-check.ts,
 * gomoku-v9-large-confirm.ts)로 분리되어 있다 — 앵커 등록은 1회성 봉인 이벤트,
 * 사다리 판정은 그 봉인된 앵커를 대상으로 반복 가능한 측정이라는 서로 다른
 * 생명주기를 갖기 때문. 이 파일은 splendor-anchor-ladder.ts가 등록한
 * external-mid-l1/external-opus-l2/external-style2-l3 앵커를 소비만 한다.
 *
 * 구조:
 *   1. Challenge 계측(게이트 없음, gate-free): v3 챔피언 vs L1(mid), vs
 *      L2(opus) — N=100씩, 신규 시드 뱅크. registry.getAnchor로 두 앵커가
 *      role='feedback'으로 봉인되어 있는지 재확인한 뒤, 실제 대전은 항상
 *      splendorMidBot/splendorOpusBot 팩토리를 직접 사용한다(BaselineRegistry.
 *      resolveAnchor는 kind==='external'에 대해 명시적으로 던진다 — 호출자가
 *      직접 봇 팩토리를 공급해야 한다는 그 파일의 doc comment 그대로,
 *      gomoku-v9-large-confirm.ts의 L3 사용 패턴과 동일).
 *   2. vs L2 challenge의 winRateCI.lower > 0.5 -> 트리거 통과 -> N=200 확증
 *      (다른 신규 시드 뱅크). 미달이면 여기서 멈추고 정직 기록.
 *   3. 확증도 winRateCI.lower > 0.5 -> L3 홀드아웃 N=100(role='holdout'
 *      재확인 후, gate-free, trajectoryCollector 미사용 — LossReport/프로브
 *      생성 금지, 앵커 봇 갱신 금지). 미달이면 여기서 멈춘다.
 *   4. L3에서도 winRateCI.lower > 0.5 -> verdict 'transcended'. 아니면
 *      'not-transcended'(과적합 실측 — GAP-11 Phase 4 규칙).
 *
 * **옛 3열 벤치마크와 비교 금지**: docs/BENCHMARK-LEADERBOARD.md의 v3 vs Opus
 * 88.7%(N=400, 2026-07-28, splendor-benchmark-v3.ts)는 이 파일의 challenge/
 * 확증/L3 수치와 시드 뱅크가 다르고 comparabilityKey가 다르다
 * (docs/INTERPRETATION.md 제1규칙) — 나란히 두고 "개선/악화"를 논하지 않는다.
 * 이 파일이 재는 것은 오직 "정규 GAP-11 프로토콜(challenge -> trigger ->
 * confirm -> L3 holdout) 위에서 v3가 초월 확정되는가"이다.
 *
 * 시드 뱅크(기존 splendor 러너 전부 grep 확인 — splendor-benchmark.ts:
 * 50_000-51_999/810_001-3/820_002/830_003, splendor-benchmark-v3.ts:
 * 60_000-60_399/960_101-3, splendor.ts 노이즈 플로어: 800_000+/900_000+,
 * splendor-anchor-ladder.ts: 1_010_000-1_014_099/1_010_101-3/1_011_101-2):
 *   - Challenge vs L1: 1_015_000-1_015_099 (N=100), botSeedBase 1_015_101.
 *   - Challenge/트리거 vs L2: 1_016_000-1_016_099 (N=100), botSeedBase
 *     1_016_101.
 *   - 확증 vs L2: 1_017_000-1_017_199 (N=200), botSeedBase 1_017_101.
 *   - L3 홀드아웃: 1_018_000-1_018_099 (N=100), botSeedBase 1_018_101.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import type { AnyBotFactory } from '../../contract/types';
import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { loadOrCreateRegistry } from '../../artifacts/game-state';
import { splendorAdapter } from '../splendor';
import { splendorOpusBot } from '../experiments/splendor-opus-bot';
import { splendorMidBot } from '../experiments/splendor-mid-bot';
import { splendorEngineBot } from '../experiments/splendor-engine-bot';
import { splendorIsmctsChampionRolloutFlagSpec } from './shared/splendor-ismcts-flag';

const GAME_ID = 'splendor';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const EXPECTED_REGISTRY_VERSION = 'v3';
const L1_ANCHOR_ID = 'external-mid-l1';
const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_THRESHOLD = 0.5;

const CHALLENGE_L1_N = 100;
const CHALLENGE_L1_SEED_BASE = 1_015_000;
const CHALLENGE_L1_BOT_SEED_BASE = 1_015_101;

const CHALLENGE_L2_N = 100;
const CHALLENGE_L2_SEED_BASE = 1_016_000;
const CHALLENGE_L2_BOT_SEED_BASE = 1_016_101;

const CONFIRM_N = 200;
const CONFIRM_SEED_BASE = 1_017_000;
const CONFIRM_BOT_SEED_BASE = 1_017_101;

const L3_N = 100;
const L3_SEED_BASE = 1_018_000;
const L3_BOT_SEED_BASE = 1_018_101;

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
  console.log('=== 스플렌더 GAP-11 정규 편입 (E2-A): challenge -> 초월 사다리 ===');

  const bareAdapter = eraseAdapter(splendorAdapter);
  const adapter = withStrategyFlags(bareAdapter, [splendorIsmctsChampionRolloutFlagSpec(bareAdapter)]);

  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== EXPECTED_REGISTRY_VERSION) {
    throw new Error(
      `splendor-transcendence-check: registry latest=${latest?.version ?? '(none)'} — expected ${EXPECTED_REGISTRY_VERSION}`,
    );
  }
  console.log(`   v3 champion flags=[${latest.flags.join(', ')}]`);
  const v3Bot = composeBot(adapter, latest.flags);

  const l1Anchor = registry.getAnchor(L1_ANCHOR_ID);
  const l2Anchor = registry.getAnchor(L2_ANCHOR_ID);
  if (l1Anchor === undefined || l1Anchor.role !== 'feedback') {
    throw new Error(`splendor-transcendence-check: L1 anchor "${L1_ANCHOR_ID}" role=${l1Anchor?.role ?? '(none)'} — expected role='feedback'`);
  }
  if (l2Anchor === undefined || l2Anchor.role !== 'feedback') {
    throw new Error(`splendor-transcendence-check: L2 anchor "${L2_ANCHOR_ID}" role=${l2Anchor?.role ?? '(none)'} — expected role='feedback'`);
  }
  console.log(`   L1(${L1_ANCHOR_ID})/L2(${L2_ANCHOR_ID}) role='feedback' 확인됨.`);

  console.log(
    `1) Challenge) v3 vs L1(mid) (N=${CHALLENGE_L1_N}, 신규 시드 ${CHALLENGE_L1_SEED_BASE}-${CHALLENGE_L1_SEED_BASE + CHALLENGE_L1_N - 1}, gate-free) ...`,
  );
  const challengeL1: HeadToHeadResult = runHeadToHead(
    adapter,
    v3Bot,
    splendorMidBot as AnyBotFactory,
    seeds(CHALLENGE_L1_SEED_BASE, CHALLENGE_L1_N),
    CHALLENGE_L1_BOT_SEED_BASE,
  );
  console.log(
    `   winRate=${pct(challengeL1.candidateWinRate)} CI=${ciStr(challengeL1)} drawRate=${pct(challengeL1.drawRate)} blocks=${challengeL1.blocks}`,
  );

  console.log(
    `2) Challenge/트리거) v3 vs L2(opus) (N=${CHALLENGE_L2_N}, 신규 시드 ${CHALLENGE_L2_SEED_BASE}-${CHALLENGE_L2_SEED_BASE + CHALLENGE_L2_N - 1}, gate-free) ...`,
  );
  const startedAt = Date.now();
  const challengeL2: HeadToHeadResult = runHeadToHead(
    adapter,
    v3Bot,
    splendorOpusBot as AnyBotFactory,
    seeds(CHALLENGE_L2_SEED_BASE, CHALLENGE_L2_N),
    CHALLENGE_L2_BOT_SEED_BASE,
  );
  const challengeL2ElapsedMs = Date.now() - startedAt;
  console.log(
    `   winRate=${pct(challengeL2.candidateWinRate)} CI=${ciStr(challengeL2)} drawRate=${pct(challengeL2.drawRate)} blocks=${challengeL2.blocks} (${(challengeL2ElapsedMs / 1000).toFixed(0)}s)`,
  );

  const triggered = challengeL2.winRateCI.lower > TRANSCENDENCE_THRESHOLD;
  console.log(
    `   트리거 검사: winRateCI.lower=${pct(challengeL2.winRateCI.lower)} ${triggered ? '>' : '<='} ${pct(TRANSCENDENCE_THRESHOLD)} -> ${triggered ? '트리거됨' : '미달'}`,
  );

  let confirmResult: HeadToHeadResult | null = null;
  let confirmed = false;
  let l3Result: HeadToHeadResult | null = null;
  let verdict: 'transcended' | 'not-transcended' | null = null;

  if (triggered) {
    console.log(
      `3) 확증) v3 vs L2(opus) (N=${CONFIRM_N}, 신규 시드 ${CONFIRM_SEED_BASE}-${CONFIRM_SEED_BASE + CONFIRM_N - 1}, gate-free) ...`,
    );
    const confirmStartedAt = Date.now();
    confirmResult = runHeadToHead(
      adapter,
      v3Bot,
      splendorOpusBot as AnyBotFactory,
      seeds(CONFIRM_SEED_BASE, CONFIRM_N),
      CONFIRM_BOT_SEED_BASE,
    );
    const confirmElapsedMs = Date.now() - confirmStartedAt;
    console.log(
      `   winRate=${pct(confirmResult.candidateWinRate)} CI=${ciStr(confirmResult)} drawRate=${pct(confirmResult.drawRate)} blocks=${confirmResult.blocks} (${(confirmElapsedMs / 1000).toFixed(0)}s)`,
    );
    confirmed = confirmResult.winRateCI.lower > TRANSCENDENCE_THRESHOLD;
    console.log(
      `   확증 검사: winRateCI.lower=${pct(confirmResult.winRateCI.lower)} ${confirmed ? '>' : '<='} ${pct(TRANSCENDENCE_THRESHOLD)} -> ${confirmed ? '통과' : '미달'}`,
    );

    if (confirmed) {
      const l3Anchor = registry.getAnchor(L3_ANCHOR_ID);
      if (l3Anchor === undefined || l3Anchor.role !== 'holdout') {
        throw new Error(
          `splendor-transcendence-check: L3 anchor "${L3_ANCHOR_ID}" role=${l3Anchor?.role ?? '(none)'} — expected role='holdout' (홀드아웃 가드 재확인 실패)`,
        );
      }
      console.log(`   L3 앵커(${L3_ANCHOR_ID}) role='holdout' 확인됨.`);
      console.log(
        `4) L3 홀드아웃) v3 vs L3(engine) (N=${L3_N}, 신규 시드 ${L3_SEED_BASE}-${L3_SEED_BASE + L3_N - 1}, gate-free, trajectoryCollector 미사용) ...`,
      );
      l3Result = runHeadToHead(
        adapter,
        v3Bot,
        splendorEngineBot as AnyBotFactory,
        seeds(L3_SEED_BASE, L3_N),
        L3_BOT_SEED_BASE,
      );
      console.log(
        `   winRate=${pct(l3Result.candidateWinRate)} CI=${ciStr(l3Result)} drawRate=${pct(l3Result.drawRate)} blocks=${l3Result.blocks}`,
      );
      verdict = l3Result.winRateCI.lower > TRANSCENDENCE_THRESHOLD ? 'transcended' : 'not-transcended';
      console.log(`   L3 판정: ${verdict}`);
      // 홀드아웃 가드: trajectoryCollector를 넘기지 않았으므로 이 판들에서
      // LossReport/probe-bank는 생성되지 않는다. 앵커 봇도 갱신하지 않는다
      // (읽기만 한다).
    } else {
      console.log('4) 확증 미달 — L3 홀드아웃 판정 미실행 (순서 건너뛰기 금지 규칙 준수).');
    }
  } else {
    console.log('3) 트리거 미달 — 확증/L3 홀드아웃 판정 미실행 (순서 건너뛰기 금지 규칙 준수).');
  }

  const summary = {
    gameId: GAME_ID,
    registryVersion: EXPECTED_REGISTRY_VERSION,
    registryFlags: latest.flags,
    generatedAt: new Date().toISOString(),
    designSpecPath: 'scratchpad/splendor-gap11-onramp-design-spec.md (main-loop Fable, 그대로 구현)',
    purpose:
      'GAP-11 정규 인프라(앵커 래더 L1/L2/L3, challenge 계측, 홀드아웃 초월 판정) 위에 기존 v3 챔피언을 올려 초월 판정을 확정 — 새 전략 설계 없음.',
    comparabilityNote:
      '이 결과는 docs/BENCHMARK-LEADERBOARD.md의 옛 3열 벤치마크(splendor-benchmark-v3.ts, N=400, v3 vs Opus 88.7%, 2026-07-28)와 시드 뱅크·프로토콜이 다르다. 나란히 두고 개선/악화로 해석하지 않는다(docs/INTERPRETATION.md 제1규칙).',
    challenge: {
      note: 'runHeadToHead 게이트 없는 순수 집계 — LossReport/probe-bank 생성 없음.',
      vsL1: {
        anchorId: L1_ANCHOR_ID,
        n: CHALLENGE_L1_N,
        seedBase: CHALLENGE_L1_SEED_BASE,
        botSeedBase: CHALLENGE_L1_BOT_SEED_BASE,
        winRate: challengeL1.candidateWinRate,
        winRateCI: challengeL1.winRateCI,
        drawRate: challengeL1.drawRate,
        blocks: challengeL1.blocks,
      },
      vsL2: {
        anchorId: L2_ANCHOR_ID,
        n: CHALLENGE_L2_N,
        seedBase: CHALLENGE_L2_SEED_BASE,
        botSeedBase: CHALLENGE_L2_BOT_SEED_BASE,
        winRate: challengeL2.candidateWinRate,
        winRateCI: challengeL2.winRateCI,
        drawRate: challengeL2.drawRate,
        blocks: challengeL2.blocks,
        elapsedMs: challengeL2ElapsedMs,
      },
    },
    triggered,
    threshold: TRANSCENDENCE_THRESHOLD,
    ...(triggered && confirmResult !== null
      ? {
          confirmatory: {
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
      : triggered
        ? {}
        : { reason: `challenge/트리거(N=${CHALLENGE_L2_N})에서 winRateCI.lower > ${TRANSCENDENCE_THRESHOLD}에 도달하지 못함 — 확증/L3 미실행.` }),
    ...(confirmed && l3Result !== null
      ? {
          transcendence: {
            l3AnchorId: L3_ANCHOR_ID,
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
      : triggered && !confirmed
        ? { reason: `확증(N=${CONFIRM_N})에서 winRateCI.lower > ${TRANSCENDENCE_THRESHOLD}에 도달하지 못함 — L3 홀드아웃 미실행.` }
        : {}),
  };

  const outDir = join(ROOT_DIR, 'runs', GAME_ID);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'transcendence-check.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`5) 저장: runs/${GAME_ID}/transcendence-check.json`);
}

main();
