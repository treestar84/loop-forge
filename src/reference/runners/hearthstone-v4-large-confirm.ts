/**
 * hearthstone-v4-large-confirm — 하스스톤 챔피언 v4(`ismcts-s128-tempo-w4`
 * 단독, v3과 내용 동일 — no-op 승격, GAP-ANALYSIS-11 E6 참고)의 **대규모
 * 확증 측정**. 메인 루프 Fable의 설계 브리프
 * `scratchpad/hearthstone-v4-large-confirm-design-spec.md` 그대로 구현한다.
 *
 * **새 후보/평가함수 설계가 아니다 — 순수 통계 재측정이다.**
 * `docs/TROUBLESHOOTING.md` §13(E9)에 성문화된 원칙: 같은 후보가 2회 이상
 * CI 하한만 0.5 문턱에서 걸리면, 새 설계를 시도하기 전에 먼저 훨씬 큰
 * N(5~10배)으로 재확인한다. 같은 후보(v4=`ismcts-s128-tempo-w4`)는 이미
 * 독립된 두 문맥에서 측정됐다:
 *   - 2회전 재채굴(`hearthstone-loss-mining-round2.ts`) N=100: 51.0%
 *     [44.5%, 57.0%]
 *   - 2회전 challenge(`hearthstone-portfolio-round2.ts`) N=40: 51.2%
 *     [42.5%, 60.0%]
 * 점추정은 두 번 다 50%를 넘겼지만 CI 하한이 둘 다 50% 아래다 — E9이 말하는
 * "점추정은 일관되게 넘는데 하한만 근접실패" 패턴이다. 표본만 N=1000으로
 * 키워(약 10배) "진짜 50%를 넘는 실력인지"를 가른다.
 *
 * 구조는 오목의 같은 종류 작업 `./gomoku-v9-large-confirm.ts`(정본 선례)를
 * 그대로 따른다:
 *   1. `runHeadToHead`(gate-free — LossReport/probe-bank 생성 없음,
 *      trajectoryCollector 미사용)로 v4 vs L2(external-opus-l2), N=1000,
 *      완전히 새 시드 뱅크.
 *   2. winRateCI.lower > 0.5일 **때만** L3 홀드아웃(external-style2-l3,
 *      `registry.getAnchor`로 role='holdout' 재확인 후 사용), N=100, 역시
 *      새 시드 뱅크, gate-free. 순서를 건너뛰지 않는다.
 *   3. 하한이 여전히 0.5 미달이면 그대로 기록한다 — "표본을 10배 키워도
 *      하한이 0.5를 못 넘었다"는 것 자체가 강한 정보다. 이 경우 새 설계는
 *      시작하지 않는다(다음 라운드에서 메인 루프가 판단).
 *
 * Fresh seed ranges — `reference/runners/hearthstone*.ts`(+
 * `shared/hearthstone*.ts`)의 모든 N{2,3}_NNN 리터럴을 grep해 확인한 뒤
 * (기존 점유 구간: 1_000/1_001, 500_000-501_099, 505_000-507_099,
 * 520_000-527_099, 530_000-537_099, 810_000, 910_000/910_001, 950_10x,
 * 983_10x, 986_10x, 987_1xx-987_3xx, 988_1xx-988_7xx, 992_1xx-992_3xx,
 * 993_1xx-993_7xx, 994_000+, 995_000+) 완전히 새 구간을 골랐다:
 *   - 대규모 확증 v4 vs L2: 600_000-600_999 (N=1000).
 *   - L3 홀드아웃 (트리거 통과 시에만): 602_000-602_099 (N=100).
 * Bot seed bases (독립 공간, 역시 grep으로 미사용 확인): 996_101(확증),
 * 996_201(L3 홀드아웃).
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
import { hearthstoneAdapter } from '../hearthstone';
import { hearthstoneOpusBot } from '../experiments/hearthstone-opus-bot';
import { hearthstoneTempoBot } from '../experiments/hearthstone-tempo-bot';
import { hearthstoneIsmctsFlagSpecFor, hearthstoneTempoPriorConfig } from './shared/hearthstone-ismcts-flag';

const GAME_ID = 'hearthstone';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const EXPECTED_REGISTRY_VERSION = 'v4';
const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_TRIGGER_THRESHOLD = 0.5;

const CONFIRM_N = 1000;
const CONFIRM_SEED_BASE = 600_000;
const CONFIRM_BOT_SEED_BASE = 996_101;

const L3_N = 100;
const L3_SEED_BASE = 602_000;
const L3_BOT_SEED_BASE = 996_201;

const CHAMPION_FLAG = 'ismcts-s128-tempo-w4';

/** 기존 두 측정(같은 후보, 다른 시드 뱅크) — 보고용 참조값. */
const PRIOR_MEASUREMENTS = [
  { label: '2회전 재채굴', n: 100, winRate: 0.51, ciLower: 0.445, ciUpper: 0.57 },
  { label: '2회전 challenge', n: 40, winRate: 0.512, ciLower: 0.425, ciUpper: 0.6 },
] as const;

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
  console.log('=== 하스스톤 v4 대규모 확증 (N=1000, 메인 루프 지시, E9 원칙) ===');

  const bareAdapter = eraseAdapter(hearthstoneAdapter);
  const adapter = withStrategyFlags(bareAdapter, [
    hearthstoneIsmctsFlagSpecFor(
      bareAdapter,
      hearthstoneTempoPriorConfig(4, 's128-tempo-w4'),
      CHAMPION_FLAG,
      'IS-MCTS s128 + tempo-band prior(priorWeight=4) — 하스스톤 챔피언 v4.',
    ),
  ]);

  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== EXPECTED_REGISTRY_VERSION) {
    throw new Error(
      `hearthstone-v4-large-confirm: registry latest=${latest?.version ?? '(none)'} — expected ${EXPECTED_REGISTRY_VERSION}`,
    );
  }
  console.log(`   v4 flags=[${latest.flags.join(', ')}]`);
  const v4Bot = composeBot(adapter, latest.flags);

  console.log('   기존 두 측정(같은 후보, 다른 시드 뱅크 — comparabilityKey 주의):');
  for (const prior of PRIOR_MEASUREMENTS) {
    console.log(
      `     ${prior.label} N=${prior.n}: ${pct(prior.winRate)} [${pct(prior.ciLower)}, ${pct(prior.ciUpper)}]`,
    );
  }

  console.log(
    `1) v4 vs L2(${L2_ANCHOR_ID}) 대규모 확증 (N=${CONFIRM_N}, 신규 시드 ${CONFIRM_SEED_BASE}-${CONFIRM_SEED_BASE + CONFIRM_N - 1})`,
  );
  const startedAt = Date.now();
  const confirmResult: HeadToHeadResult = runHeadToHead(
    adapter,
    v4Bot,
    hearthstoneOpusBot as AnyBotFactory,
    seeds(CONFIRM_SEED_BASE, CONFIRM_N),
    CONFIRM_BOT_SEED_BASE,
  );
  const confirmElapsedMs = Date.now() - startedAt;
  console.log(
    `   winRate=${pct(confirmResult.candidateWinRate)} CI=${ciStr(confirmResult)} drawRate=${pct(confirmResult.drawRate)} blocks=${confirmResult.blocks} (${(confirmElapsedMs / 1000).toFixed(0)}s)`,
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
        `hearthstone-v4-large-confirm: L3 anchor "${L3_ANCHOR_ID}" role=${l3Anchor?.role ?? '(none)'} — expected role='holdout' (홀드아웃 가드 재확인 실패)`,
      );
    }
    l3AnchorConfirmed = true;
    console.log(`   L3 앵커(${L3_ANCHOR_ID}) role='holdout' 확인됨.`);
    console.log(
      `   L3 홀드아웃 초월 판정 실행 (N=${L3_N}, 신규 시드 ${L3_SEED_BASE}-${L3_SEED_BASE + L3_N - 1}, 게이트 없음, trajectoryCollector 미사용)`,
    );
    l3Result = runHeadToHead(
      adapter,
      v4Bot,
      hearthstoneTempoBot as AnyBotFactory,
      seeds(L3_SEED_BASE, L3_N),
      L3_BOT_SEED_BASE,
    );
    console.log(
      `   v4 vs L3(${L3_ANCHOR_ID}): winRate=${pct(l3Result.candidateWinRate)} CI=${ciStr(l3Result)} drawRate=${pct(l3Result.drawRate)} blocks=${l3Result.blocks}`,
    );
    // 홀드아웃 가드: options.trajectoryCollector를 넘기지 않았으므로 이 판의
    // 궤적은 수집되지 않는다 — mineLosses/mineDraws/buildProbeBank 등 어떤
    // 후속 함수도 이 결과에서 LossReport나 프로브를 만들 재료가 없다.
    // 앵커 봇도 갱신하지 않는다(읽기만 한다).
  } else {
    console.log('   미달 — L3 홀드아웃 판정 미실행 (순서 건너뛰기 금지 규칙 준수)');
  }

  const verdict: 'transcended' | 'not-transcended' | null =
    l3Result === null
      ? null
      : l3Result.winRateCI.lower > TRANSCENDENCE_TRIGGER_THRESHOLD
        ? 'transcended'
        : 'not-transcended';

  const summary = {
    gameId: GAME_ID,
    registryVersion: EXPECTED_REGISTRY_VERSION,
    registryFlags: latest.flags,
    generatedAt: new Date().toISOString(),
    designSpecPath: 'scratchpad/hearthstone-v4-large-confirm-design-spec.md (main-loop Fable, 그대로 구현)',
    purpose:
      '새 후보/평가함수 설계 없음 — 챔피언 v4의 vs L2 실력이 진짜 50%를 넘는지 표본을 약 10배(N=1000)로 키워 가르는 순수 통계 재측정(E9 원칙).',
    priorMeasurements: PRIOR_MEASUREMENTS,
    comparabilityNote:
      '기존 두 측정과 이번 측정은 같은 후보(ismcts-s128-tempo-w4)·같은 상대(external-opus-l2)이지만 시드 뱅크가 전부 다르다. 표본 변동 범위 안에서 나란히 읽는 것은 정당하나, 차이를 빼서 "개선/악화"로 해석하면 안 된다(docs/INTERPRETATION.md 제1규칙).',
    confirmatoryMeasurement: {
      note: 'runHeadToHead 게이트 없는 순수 집계 — LossReport/probe-bank 생성 없음.',
      anchorId: L2_ANCHOR_ID,
      n: CONFIRM_N,
      seedBase: CONFIRM_SEED_BASE,
      botSeedBase: CONFIRM_BOT_SEED_BASE,
      winRate: confirmResult.candidateWinRate,
      winRateCI: confirmResult.winRateCI,
      drawRate: confirmResult.drawRate,
      blocks: confirmResult.blocks,
      elapsedMs: confirmElapsedMs,
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
          reason: `대규모 확증(N=${CONFIRM_N})에서 winRateCI.lower > ${TRANSCENDENCE_TRIGGER_THRESHOLD}에 도달하지 못함 — L3 홀드아웃 미실행.`,
        }),
  };

  const outDir = join(ROOT_DIR, 'runs', GAME_ID);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'v4-large-confirm.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`3) 저장: runs/${GAME_ID}/v4-large-confirm.json`);
}

main();
