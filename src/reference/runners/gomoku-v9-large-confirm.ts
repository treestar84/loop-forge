/**
 * gomoku-v9-large-confirm — 오목 챔피언 v9(`mcts17-s256-clone-earlyprior-sched`
 * 단독)의 **대규모 확증 측정**. 메인 루프 Fable의 설계 브리프
 * `scratchpad/gomoku-v9-large-n-confirm-design-spec.md` 그대로 구현한다.
 *
 * **새 전략 설계가 아니다 — 순수 통계 재측정이다.** 같은 후보의 독립 측정이
 * 이미 세 번 있고(round5 N=100 트리거 55.5% [51.0–59.8], round5 N=200 확증
 * 53.1% [49.8–56.5], round6 N=100 재확인 54.3% [49.8–58.8]) 점추정은 세 번
 * 다 50%를 넘겼지만 CI 하한이 두 번 연속 정확히 49.8%에서 걸렸다. 설계는
 * 그대로 두고 표본만 5배로 키워(N=1000) "진짜 50%를 넘는 실력인지"를 가른다.
 *
 * 구조는 `./gomoku-v7-transcendence-check.ts`(같은 종류 작업의 정본 선례)를
 * 그대로 따른다:
 *   1. `runHeadToHead`(gate-free — LossReport/probe-bank 생성 없음,
 *      trajectoryCollector 미사용)로 v9 vs L2(external-opus-l2), N=1000,
 *      완전히 새 시드 뱅크.
 *   2. winRateCI.lower > 0.5일 **때만** L3 홀드아웃(external-style2-l3,
 *      `registry.getAnchor`로 role='holdout' 재확인 후 사용), N=100, 역시
 *      새 시드 뱅크, gate-free. 순서를 건너뛰지 않는다.
 *   3. 하한이 여전히 0.5 미달이면 그대로 기록한다 — "표본을 5배 키워도
 *      하한이 0.5를 못 넘었다"는 것 자체가 강한 정보다.
 *
 * Fresh seed ranges — `reference/runners/gomoku*.ts`(+ shared/gomoku*.ts)의
 * 모든 N{2,3}_NNN 리터럴을 grep해 확인한 뒤 완전히 새 구간을 골랐다. 기존
 * 점유 구간: 50_000–90_699(3열 벤치마크), 300_000–301_099/400_000–401_099/
 * 410_000(loss-mining round1/round2, prior-diagnostic), 520_000–553_099
 * (portfolio round1–round4 계열), 556_000–564_099(round5),
 * 566_000–574_099(round6), 600_000, 700_000–700_099(gomoku.ts noise floor),
 * 800_000–801_099/810_000/811_000(loss-mining round4/round5),
 * 900_000/910_000(타 게임 identity-seed 관례라 회피), 920_000–921_099
 * (v7-transcendence-check), 981_101–997_999(anchor-ladder 게이트/봇 시드):
 *   - 대규모 확증 v9 vs L2: 580_000–580_999 (N=1000).
 *   - L3 홀드아웃 (트리거 통과 시에만): 582_000–582_099 (N=100).
 * Bot seed bases (독립 공간, 역시 grep으로 미사용 확인 — 994_x는 round6,
 * 995_x는 도미니언 4회전, 998_000/999_000은 도미니언 앵커 사다리가 점유):
 *   998_101 (확증), 998_201 (L3 홀드아웃).
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
import { buildRound5Candidates } from './shared/gomoku-round5-candidates';

const GAME_ID = 'gomoku';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const EXPECTED_REGISTRY_VERSION = 'v9';
const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_TRIGGER_THRESHOLD = 0.5;

const CONFIRM_N = 1000;
const CONFIRM_SEED_BASE = 580_000;
const CONFIRM_BOT_SEED_BASE = 998_101;

const L3_N = 100;
const L3_SEED_BASE = 582_000;
const L3_BOT_SEED_BASE = 998_201;

/** 기존 세 측정(같은 후보, 다른 시드 뱅크) — 보고용 참조값. */
const PRIOR_MEASUREMENTS = [
  { label: 'round5 트리거', n: 100, winRate: 0.555, ciLower: 0.51, ciUpper: 0.598 },
  { label: 'round5 확증', n: 200, winRate: 0.531, ciLower: 0.498, ciUpper: 0.565 },
  { label: 'round6 재확인', n: 100, winRate: 0.543, ciLower: 0.498, ciUpper: 0.588 },
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
  console.log('=== 오목 v9 대규모 확증 (N=1000, 메인 루프 지시) ===');

  const bareAdapter = eraseAdapter(gomokuAdapter);
  const round1Candidates = buildRound1Candidates(bareAdapter);
  const round2Candidates = buildRound2Candidates(bareAdapter);
  const round5Candidates = buildRound5Candidates(bareAdapter);
  const adapter = withStrategyFlags(bareAdapter, [
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_CONFIG, GOMOKU_MCTS_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_HR_CONFIG, GOMOKU_MCTS_HR_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_CONFIG, GOMOKU_MCTS2_S256_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_HR_CONFIG, GOMOKU_MCTS2_S256_HR_FLAG),
    gomokuMcts2S256CrFlagSpec(bareAdapter),
    gomokuMcts2S512CrFlagSpec(bareAdapter),
    ...round1Candidates.map((candidate) => candidate.spec),
    ...round2Candidates.map((candidate) => candidate.spec),
    ...round5Candidates.map((candidate) => candidate.spec),
  ]);

  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== EXPECTED_REGISTRY_VERSION) {
    throw new Error(
      `gomoku-v9-large-confirm: registry latest=${latest?.version ?? '(none)'} — expected ${EXPECTED_REGISTRY_VERSION}`,
    );
  }
  console.log(`   v9 flags=[${latest.flags.join(', ')}]`);
  const v9Bot = composeBot(adapter, latest.flags);

  console.log('   기존 세 측정(같은 후보, 다른 시드 뱅크 — comparabilityKey 주의):');
  for (const prior of PRIOR_MEASUREMENTS) {
    console.log(
      `     ${prior.label} N=${prior.n}: ${pct(prior.winRate)} [${pct(prior.ciLower)}, ${pct(prior.ciUpper)}]`,
    );
  }

  console.log(
    `1) v9 vs L2(${L2_ANCHOR_ID}) 대규모 확증 (N=${CONFIRM_N}, 신규 시드 ${CONFIRM_SEED_BASE}-${CONFIRM_SEED_BASE + CONFIRM_N - 1})`,
  );
  const startedAt = Date.now();
  const confirmResult: HeadToHeadResult = runHeadToHead(
    adapter,
    v9Bot,
    gomokuOpusBot as AnyBotFactory,
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
        `gomoku-v9-large-confirm: L3 anchor "${L3_ANCHOR_ID}" role=${l3Anchor?.role ?? '(none)'} — expected role='holdout' (홀드아웃 가드 재확인 실패)`,
      );
    }
    l3AnchorConfirmed = true;
    console.log(`   L3 앵커(${L3_ANCHOR_ID}) role='holdout' 확인됨.`);
    console.log(
      `   L3 홀드아웃 초월 판정 실행 (N=${L3_N}, 신규 시드 ${L3_SEED_BASE}-${L3_SEED_BASE + L3_N - 1}, 게이트 없음, trajectoryCollector 미사용)`,
    );
    l3Result = runHeadToHead(
      adapter,
      v9Bot,
      gomokuPositionalBot as AnyBotFactory,
      seeds(L3_SEED_BASE, L3_N),
      L3_BOT_SEED_BASE,
    );
    console.log(
      `   v9 vs L3(${L3_ANCHOR_ID}): winRate=${pct(l3Result.candidateWinRate)} CI=${ciStr(l3Result)} drawRate=${pct(l3Result.drawRate)} blocks=${l3Result.blocks}`,
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
    designSpecPath: 'scratchpad/gomoku-v9-large-n-confirm-design-spec.md (main-loop Fable, 그대로 구현)',
    purpose:
      '새 전략 설계 없음 — 챔피언 v9의 vs L2 실력이 진짜 50%를 넘는지 표본을 5배(N=1000)로 키워 가르는 순수 통계 재측정.',
    priorMeasurements: PRIOR_MEASUREMENTS,
    comparabilityNote:
      '기존 세 측정과 이번 측정은 같은 후보(mcts17-s256-clone-earlyprior-sched)·같은 상대(external-opus-l2)이지만 시드 뱅크가 전부 다르다. 표본 변동 범위 안에서 나란히 읽는 것은 정당하나, 차이를 빼서 "개선/악화"로 해석하면 안 된다(docs/INTERPRETATION.md 제1규칙).',
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
  const outPath = join(outDir, 'v9-large-confirm.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`3) 저장: runs/${GAME_ID}/v9-large-confirm.json`);
}

main();
