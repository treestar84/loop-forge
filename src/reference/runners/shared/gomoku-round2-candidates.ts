/**
 * gomoku-round2-candidates — GAP-11 Phase 4-B candidate batch builder
 * (docs/GAP-ANALYSIS-11.md §5.5 Phase 4-B, following
 * ./gomoku-round1-candidates.ts's own precedent: a side-effect-free module a
 * runner imports, kept separate from the runner itself for the same reason
 * that file documents — every reference/runners/*.ts file's own `main()`
 * runs unconditionally at module scope).
 *
 * Design source: the main loop's own B3 deep-design spec (scratchpad
 * b3-round2-design-spec.md, reproduced in
 * src/reference/experiments/gomoku-combined-evaluator.ts's doc comment) —
 * implemented here verbatim, no changes. B1/B2/B4 are this executing agent's
 * own derivations (see each candidate's inline comment for its rationale).
 *
 * **필수 제약 (설계 명세의 "조립 문제" 절)**: composeBot의 MCTS 계열 플래그는
 * `apply()`가 `base`를 완전히 무시하므로(gomoku-mcts-flag.ts 각 스펙의 doc
 * comment), registry에 여러 MCTS 플래그를 나열해도 실제로 살아남는 것은
 * 마지막 플래그 하나뿐이다(round1 v6 재채굴, Phase 4-A의 핵심 발견). 그래서
 * 이번 라운드의 후보는 전부 **단일 자립(self-contained) 플래그** — 오프닝
 * 정책과 중반 prior를 한 후보 안에서 결합하고 싶다면(B2), 플래그를 나열하는
 * 대신 그 후보 자신의 `apply()` 안에서 오프닝→prior-MCTS 전환을 구현한다
 * (`gomokuOpeningThenPriorFlagSpec`, ./gomoku-round1-candidates.ts에서 재사용).
 *
 * 후보 배치 (6개, GAP-11 Phase 4-B 팀리드 배치):
 *   B3-deep x2 — 메인 루프 처치 1+2:
 *     - `mcts10-s256-combined-w16`: `gomokuCombinedEvaluator`(defensive +
 *       0.6*chain, ../../experiments/gomoku-combined-evaluator.ts) 고정
 *       priorWeight=16.
 *     - `mcts10-s256-combined-sched`: 동일 combined evaluator + 신규
 *       `MctsConfig.priorWeightSchedule`(search/mcts.ts) — 이 봇 인스턴스의
 *       첫 12개 결정은 w=48, 이후는 w=16. 설계 근거: LossReport의 첫 분기
 *       깊이 히스토그램이 라운드1/v6 양쪽 다 "{0-9: 전패}"로 초반에 집중돼
 *       있으므로, 그 구간에서만 지식 개입(prior)을 강하게 걸고 이후는
 *       통계(UCT)에 맡긴다(scratchpad 설계 명세의 "처치 2" 그대로).
 *   B1-exploit x2 — B3의 기계적 파생(팀리드 배치):
 *     - `mcts10-s256-combined-w16-c04`: combined evaluator의 chainWeight을
 *       0.6→0.4로 낮춘 변형(`makeGomokuCombinedEvaluator(0.4)`).
 *     - `mcts10-s256-combined-w48`: combined evaluator(기본 0.6 가중)를
 *       스케줄 없이 고정 w=48로 — "처치 2가 스케줄 없이도 이득이 있는가"의
 *       대조군.
 *   B2-opponent x1 (실행 에이전트 설계, 팀리드 지시: "라운드1 opening6을
 *     round2 프로브 은행으로 재검증해 개선, combined와 다른 축"):
 *     - `mcts11-s256-opening5-defensive-w16`: round1 B2와 같은 구조
 *       (오프닝 정책 → prior-MCTS 전환, `gomokuOpeningThenPriorFlagSpec`
 *       재사용) 이되 두 가지를 바꿨다 — (a) 오프닝 창을 6→5로: round2
 *       프로브 은행(probe-bank-round2.json, v6 vs L2 손실 채굴)의
 *       `decisionIndex` 분포를 직접 집계하면 200개 프로브 전부
 *       decisionIndex 0-4에 몰려 있다(0:64, 1:32, 2:59, 3:43, 4:2 — 5 이상
 *       0건). round1의 LossReport는 "게임 첫 10수 이내 분기"라는 더 성긴
 *       신호였지만, round2 프로브는 그보다 훨씬 이른 첫 5개 결정에 분기가
 *       모여 있음을 보여준다 — 오프닝 창을 그 실측 분포에 맞춘다.
 *       (b) 전환 후 엔진의 priorEvaluator를 combined가 아니라
 *       `gomokuDefensiveEvaluator` 단독으로 유지 — B3(combined = defensive+
 *       chain)와 다른 축이어야 한다는 팀리드 제약을 지키면서도, round1에서
 *       가장 높은 단독 수율을 낸 축(defensive)을 오프닝 정책과 결합해보는
 *       조합.
 *   B4-explore x1 (실행 에이전트 설계, 팀리드 지시: "축 매트릭스 미시도에서
 *     선택"):
 *     - `mcts12-s256-opusclone-w16`: `gomokuOpusCloneEvaluator`
 *       (../../experiments/gomoku-opus-clone-evaluator.ts) — 축 매트릭스에서
 *       이 게임에 실행 가능한 유일한 "미시도" 축인 A10(모방/이식)의 이
 *       게임 최초 시도. 지금까지의 모든 prior 후보(chain/defensive/combined)
 *       는 이산 티어 축이고, 이 후보는 L2 앵커 자신의 연속 위협-점수 함수를
 *       트리 prior로 이식한 것 — 점수 산출 방식 자체가 챔피언(v6=defensive,
 *       이산 티어)과 대비되는 축이라는 점에서 B4-explore의 "행동 지문 최대
 *       거리" 기준도 만족한다고 판단(자세한 근거는 그 파일 자신의 doc
 *       comment).
 */

import type { AnyGameAdapter, StrategyFlagSpec } from '../../../contract/types';
import { composeBot } from '../../../loop/compose';
import type { BucketId } from '../../../artifacts/portfolio';
import type { MctsConfig } from '../../../search/mcts';
import { gomokuCombinedEvaluator, makeGomokuCombinedEvaluator } from '../../experiments/gomoku-combined-evaluator';
import { gomokuDefensiveEvaluator } from '../../experiments/gomoku-defensive-evaluator';
import { gomokuOpusCloneEvaluator } from '../../experiments/gomoku-opus-clone-evaluator';
import { GOMOKU_CHAMPION_ROLLOUT_FLAGS, gomokuMctsFlagSpecFor } from './gomoku-mcts-flag';
import {
  erasePriorEvaluator,
  gomokuOpeningThenPriorFlagSpec,
  type RoundCandidate,
} from './gomoku-round1-candidates';

export type { RoundCandidate };

/** round2 프로브 은행 decisionIndex 분포 실측(이 파일 doc comment) — round1의 6에서 5로 좁힌 근거. */
const OPENING_WINDOW_V2 = 5;

/** B3 처치 2 — 첫 12개 결정은 w48, 이후 w16 (이 파일 doc comment, scratchpad 설계 명세 그대로). */
const SCHEDULE_HIGH_WEIGHT_DECISIONS = 12;
const SCHEDULE_EARLY_WEIGHT = 48;
const SCHEDULE_LATE_WEIGHT = 16;
function combinedPriorSchedule(decisionIndex: number): number {
  return decisionIndex < SCHEDULE_HIGH_WEIGHT_DECISIONS ? SCHEDULE_EARLY_WEIGHT : SCHEDULE_LATE_WEIGHT;
}

/**
 * Rebuild this round's full 6-candidate batch (B3x2, B1x2, B2x1, B4x1)
 * against `bareAdapter` — see this module's own doc comment for the full
 * per-candidate design rationale.
 */
export function buildRound2Candidates(bareAdapter: AnyGameAdapter): readonly RoundCandidate[] {
  const championRollout = composeBot(bareAdapter, [...GOMOKU_CHAMPION_ROLLOUT_FLAGS]);

  const combinedConfig = (priorWeight: number, label: string, extra?: Partial<MctsConfig>): MctsConfig => ({
    simulations: 256,
    uctC: 1.4,
    rolloutCount: 1,
    label,
    rolloutFactory: championRollout,
    priorWeight,
    priorEvaluator: erasePriorEvaluator(gomokuCombinedEvaluator),
    ...extra,
  });

  const b3: RoundCandidate[] = [
    {
      flag: 'mcts10-s256-combined-w16',
      bucket: 'B3-deep',
      spec: gomokuMctsFlagSpecFor(bareAdapter, combinedConfig(16, 's256-combined-w16'), 'mcts10-s256-combined-w16'),
    },
    {
      flag: 'mcts10-s256-combined-sched',
      bucket: 'B3-deep',
      spec: gomokuMctsFlagSpecFor(
        bareAdapter,
        combinedConfig(SCHEDULE_EARLY_WEIGHT, 's256-combined-sched', { priorWeightSchedule: combinedPriorSchedule }),
        'mcts10-s256-combined-sched',
      ),
    },
  ];

  const b1: RoundCandidate[] = [
    {
      flag: 'mcts10-s256-combined-w16-c04',
      bucket: 'B1-exploit',
      spec: gomokuMctsFlagSpecFor(
        bareAdapter,
        {
          simulations: 256,
          uctC: 1.4,
          rolloutCount: 1,
          label: 's256-combined-w16-c04',
          rolloutFactory: championRollout,
          priorWeight: 16,
          priorEvaluator: erasePriorEvaluator(makeGomokuCombinedEvaluator(0.4)),
        },
        'mcts10-s256-combined-w16-c04',
      ),
    },
    {
      flag: 'mcts10-s256-combined-w48',
      bucket: 'B1-exploit',
      spec: gomokuMctsFlagSpecFor(bareAdapter, combinedConfig(48, 's256-combined-w48'), 'mcts10-s256-combined-w48'),
    },
  ];

  const b2: RoundCandidate[] = [
    {
      flag: 'mcts11-s256-opening5-defensive-w16',
      bucket: 'B2-opponent',
      spec: gomokuOpeningThenPriorFlagSpec(
        bareAdapter,
        OPENING_WINDOW_V2,
        {
          simulations: 256,
          uctC: 1.4,
          rolloutCount: 1,
          label: 's256-opening5-defensive-w16',
          rolloutFactory: championRollout,
          priorWeight: 16,
          priorEvaluator: erasePriorEvaluator(gomokuDefensiveEvaluator),
        },
        'mcts11-s256-opening5-defensive-w16',
      ),
    },
  ];

  const b4: RoundCandidate[] = [
    {
      flag: 'mcts12-s256-opusclone-w16',
      bucket: 'B4-explore',
      spec: gomokuMctsFlagSpecFor(
        bareAdapter,
        {
          simulations: 256,
          uctC: 1.4,
          rolloutCount: 1,
          label: 's256-opusclone-w16',
          rolloutFactory: championRollout,
          priorWeight: 16,
          priorEvaluator: erasePriorEvaluator(gomokuOpusCloneEvaluator),
        },
        'mcts12-s256-opusclone-w16',
      ),
    },
  ];

  return [...b3, ...b1, ...b2, ...b4];
}
