/**
 * gomoku-round5-candidates — GAP-11 오목 5회전 후보 배치 빌더(메인 루프 Fable의
 * 설계 브리프 scratchpad/gomoku-round5-design-spec.md + 이 라운드 자신의 채굴
 * 실측), following ./gomoku-round4-candidates.ts's own side-effect-free
 * candidate-builder convention.
 *
 * **이 라운드 채굴(gomoku-loss-mining-round5.ts, N=100 신규 시드 810,000+)의
 * 실측이 후보 설계의 유일한 근거다**:
 *   - v7 vs L2 = 52.0% [46.8-57.3], 무승부 58.0% (3/4회전과 같은 대등 구간).
 *   - 패배 76/200, 그중 발산이 있는 판의 **첫 분기 깊이는 다시 초반 집중**
 *     (0-9: 28, 10-19: 3, 20-29: 7, 50-59: 1, 70-79: 2) — round4가 "53%만
 *     초반, 나머지는 10~109 분산"이라 본 것과 달리 이번 표본은 초반 비중이 더
 *     크다. probe-bank-round5.json(52개 프로브)의 decisionIndex 분포도 같은
 *     이야기를 한다: 0-9에 32개, 10-29에 14개, 50 이상은 6개뿐.
 *   - **무승부 수렴 확정 시점(이번 라운드 신규 분석)**: 무승부 40판에서 열린 3
 *     이상의 강제 위협을 만들 수 있었던 **마지막 수순의 평균이 140.5수**
 *     (히스토그램 120-129:2, 130-139:13, 140-149:19, 150-159:6), 그 이후
 *     평균 80.6수는 아무도 강제 위협을 못 만드는 죽은 꼬리다(평균 길이 222.1).
 *     → 무승부에 개입할 수 있는 창은 **대략 60~140수 구간**이고, 그 뒤는
 *     무엇을 해도 늦다. B3의 ramp 구간이 이 실측에서 그대로 나온다.
 *
 * 후보 배치 (5):
 *   - **B3-deep `mcts15-s256-drawaverse-w16`** (메인 루프 지정 본안): v7의
 *     클론 evaluator는 그대로 두고, 무승부로 수렴 중인 국면에서만 "자기 공격을
 *     키우는 수"를 탐색 랭킹에서 우대한다
 *     (../../experiments/gomoku-draw-averse-evaluator.ts). round4의
 *     clone-tiebreak(동점 두 수 중 클론과 같은 것을 고름)와 다른 개입이다 —
 *     이건 무승부로 가는 수 **자체**를 덜 선호하는 랭킹 편향(A8 신규 축).
 *     ramp 구간 [60, 140]과 attackEmphasis=1.0은 위 채굴 실측에서 결정했다
 *     (140 = 강제 위협 가능한 마지막 수순의 실측 평균; 그 이후는 죽은 꼬리라
 *     최대 강도를 그 지점에 맞춘다. attackEmphasis=1.0이면 ramp=1에서 자기
 *     공격 항의 실효 가중이 1→2가 되고 상대 위협 항(0.95)은 그대로라, "방어를
 *     버리지는 않되 공격을 두 배로 본다"가 된다).
 *   - **B1-exploit x2 `mcts16-s256-opening{3,5}-clone-w16`**: A7 오프닝 북의
 *     저비용 버전(round4 자체 권고 "B1으로 격하"). 기존
 *     `gomokuOpeningThenPriorFlagSpec`(./gomoku-round1-candidates.ts) 재사용 —
 *     신규 인프라 없음(round4가 이미 확인). round1의 opening6/round2의
 *     opening5와 달리 전환 후 엔진의 prior를 **챔피언과 동일한 클론**으로 두어,
 *     "오프닝 정책만 추가했을 때 v7 대비 순증분이 있는가"를 분리 측정한다.
 *     창 3/5 두 값은 이번 프로브의 decisionIndex 분포(0-9 집중, 특히 0-8에 30개)
 *     를 사이에 두고 고른 기계적 스윕.
 *   - **B2-opponent `mcts17-s256-clone-earlyprior-sched`**: 이번 라운드 프로브가
 *     지목한 결정 구간(0-9, 그리고 21-24의 2차 뭉치)에서만 클론 prior의 개입
 *     강도를 올린다(w=64 / 10-29구간 w=32 / 이후 w=16, `priorWeightSchedule`).
 *     **설계 브리프는 이 버킷을 "중후반 국지적 전술"에 겨냥하라고 했지만, 이번
 *     라운드 자신의 채굴은 그 전제와 반대 방향을 가리켰다**(위 실측) — 프로토콜
 *     상 B2는 "그 라운드의 채굴이 지목한 표적"을 겨냥하는 버킷이므로 신규
 *     데이터를 따랐고, 이 불일치 자체를 라운드 기록에 남긴다.
 *   - **B4-explore `mcts18-s256-clone-rootoverride`**: 축 매트릭스 미시도 조합
 *     **A4(루트 오버라이드) × A10(클론)**. A4는 과거 forkAwareness 기하로만
 *     시도돼 0%였고(mcts3-s256-override), 클론 위협 함수로는 한 번도 시도된 적이
 *     없다. 설계 근거: 이번 채굴에서 패배판 place 불일치율이 3.9%(52/1319)까지
 *     내려갔다 — 남은 패배는 "전략 격차"가 아니라 드문 국지적 전술 실수이고,
 *     그런 실수는 결정적 위협(열린 4 이상)이 256회 시뮬레이션 평균에 희석될 때
 *     생긴다. 그래서 루트에서 클론 점수 기준 결정적 위협이 있으면 탐색을 건너뛰고
 *     그 수를 그대로 둔다. ADR-0009 주의: A3(전술 프리체크, tacticalDepth)와
 *     겹치는 부분은 즉승/즉방어 티어뿐이고, 여기서 새로 더한 것은 (a) 열린 4
 *     티어까지의 확장과 (b) 판정 근거가 클론의 연속 위협 점수라는 점이다 —
 *     A1/A2/A3 재시도가 아니라 A4×A10 신규 결합이다.
 */

import type { AnyGameAdapter, PlayerId, StrategyFlagSpec } from '../../../contract/types';
import { composeBot } from '../../../loop/compose';
import type { BucketId } from '../../../artifacts/portfolio';
import type { MctsConfig } from '../../../search/mcts';
import {
  GOMOKU_DECISIVE_THREAT_SCORE,
  makeGomokuDrawAverseEvaluator,
} from '../../experiments/gomoku-draw-averse-evaluator';
import { gomokuOpusCloneEvaluator, gomokuOwnThreatScores } from '../../experiments/gomoku-opus-clone-evaluator';
import type { GomokuMove, GomokuState } from '../../gomoku';
import { GOMOKU_CHAMPION_ROLLOUT_FLAGS, gomokuMctsFlagSpecFor } from './gomoku-mcts-flag';
import {
  erasePriorEvaluator,
  gomokuOpeningThenPriorFlagSpec,
  type RoundCandidate,
} from './gomoku-round1-candidates';

export type { RoundCandidate };

export const GOMOKU_DRAWAVERSE_FLAG = 'mcts15-s256-drawaverse-w16';
export const GOMOKU_OPENING3_CLONE_FLAG = 'mcts16-s256-opening3-clone-w16';
export const GOMOKU_OPENING5_CLONE_FLAG = 'mcts16-s256-opening5-clone-w16';
export const GOMOKU_CLONE_EARLYPRIOR_FLAG = 'mcts17-s256-clone-earlyprior-sched';
export const GOMOKU_CLONE_ROOTOVERRIDE_FLAG = 'mcts18-s256-clone-rootoverride';

/** 이 라운드 설계 상수 — 전부 위 doc comment의 채굴 실측에서 나왔다. */
export const ROUND5_DESIGN_CONSTANTS = {
  drawZoneStartMoveCount: 60,
  drawZoneFullMoveCount: 140,
  attackEmphasis: 1.0,
  openingWindows: [3, 5],
  earlyPriorSchedule: { earlyDecisions: 10, earlyWeight: 64, midDecisions: 30, midWeight: 32, lateWeight: 16 },
  rootOverrideThreshold: GOMOKU_DECISIVE_THREAT_SCORE,
} as const;

function clonePriorConfig(championRollout: ReturnType<typeof composeBot>, label: string, extra?: Partial<MctsConfig>): MctsConfig {
  return {
    simulations: 256,
    uctC: 1.4,
    rolloutCount: 1,
    label,
    rolloutFactory: championRollout,
    priorWeight: 16,
    priorEvaluator: erasePriorEvaluator(gomokuOpusCloneEvaluator),
    ...extra,
  };
}

/** B2's schedule — 프로브 decisionIndex 분포(0-9 집중, 21-24 2차 뭉치)에 맞춘 계단. */
function earlyPriorSchedule(decisionIndex: number): number {
  const s = ROUND5_DESIGN_CONSTANTS.earlyPriorSchedule;
  if (decisionIndex < s.earlyDecisions) return s.earlyWeight;
  if (decisionIndex < s.midDecisions) return s.midWeight;
  return s.lateWeight;
}

/**
 * B4's `MctsConfig.rootOverride` (search/mcts.ts) — 클론 위협 점수 기준으로
 * (1) 내가 즉시 이기거나 결정적 위협(열린 4 이상)을 만들 수 있으면 그 수,
 * (2) 아니면 상대가 그럴 수 있는 자리면 그 자리를 막는 수, (3) 둘 다 아니면
 * null(탐색에 맡김). 동점은 배열 순서 첫 항목으로 결정적으로 깨진다(legal
 * 목록 자체가 상태 해시로 셔플된 결정적 순서 — reference/gomoku.ts).
 */
export function gomokuCloneTacticalRootOverride(
  _adapter: AnyGameAdapter,
  state: unknown,
  legal: readonly unknown[],
  player: PlayerId,
): unknown | null {
  const gomokuState = state as GomokuState;
  const moves = legal as readonly GomokuMove[];
  if (moves.length === 0) {
    return null;
  }
  const opponent: PlayerId = player === 0 ? 1 : 0;
  const own = gomokuOwnThreatScores(gomokuState, player, moves);
  const theirs = gomokuOwnThreatScores(gomokuState, opponent, moves);

  let bestOwnIndex = 0;
  let bestTheirIndex = 0;
  for (let index = 1; index < moves.length; index += 1) {
    if ((own[index] as number) > (own[bestOwnIndex] as number)) bestOwnIndex = index;
    if ((theirs[index] as number) > (theirs[bestTheirIndex] as number)) bestTheirIndex = index;
  }
  if ((own[bestOwnIndex] as number) >= GOMOKU_DECISIVE_THREAT_SCORE) {
    return moves[bestOwnIndex] ?? null;
  }
  if ((theirs[bestTheirIndex] as number) >= GOMOKU_DECISIVE_THREAT_SCORE) {
    return moves[bestTheirIndex] ?? null;
  }
  return null;
}

/**
 * Rebuild this round's 5-candidate batch against `bareAdapter` — see this
 * module's own doc comment for the full per-candidate design rationale and
 * the mined evidence behind every constant.
 */
export function buildRound5Candidates(bareAdapter: AnyGameAdapter): readonly RoundCandidate[] {
  const championRollout = composeBot(bareAdapter, [...GOMOKU_CHAMPION_ROLLOUT_FLAGS]);

  const drawAverse = makeGomokuDrawAverseEvaluator({
    drawZoneStartMoveCount: ROUND5_DESIGN_CONSTANTS.drawZoneStartMoveCount,
    drawZoneFullMoveCount: ROUND5_DESIGN_CONSTANTS.drawZoneFullMoveCount,
    attackEmphasis: ROUND5_DESIGN_CONSTANTS.attackEmphasis,
  });

  const b3: RoundCandidate = {
    flag: GOMOKU_DRAWAVERSE_FLAG,
    bucket: 'B3-deep' as BucketId,
    spec: gomokuMctsFlagSpecFor(
      bareAdapter,
      clonePriorConfig(championRollout, 's256-drawaverse-w16', { priorEvaluator: erasePriorEvaluator(drawAverse) }),
      GOMOKU_DRAWAVERSE_FLAG,
    ),
  };

  const b1: RoundCandidate[] = [
    {
      flag: GOMOKU_OPENING3_CLONE_FLAG,
      bucket: 'B1-exploit' as BucketId,
      spec: gomokuOpeningThenPriorFlagSpec(
        bareAdapter,
        3,
        clonePriorConfig(championRollout, 's256-opening3-clone-w16'),
        GOMOKU_OPENING3_CLONE_FLAG,
      ),
    },
    {
      flag: GOMOKU_OPENING5_CLONE_FLAG,
      bucket: 'B1-exploit' as BucketId,
      spec: gomokuOpeningThenPriorFlagSpec(
        bareAdapter,
        5,
        clonePriorConfig(championRollout, 's256-opening5-clone-w16'),
        GOMOKU_OPENING5_CLONE_FLAG,
      ),
    },
  ];

  const b2: RoundCandidate = {
    flag: GOMOKU_CLONE_EARLYPRIOR_FLAG,
    bucket: 'B2-opponent' as BucketId,
    spec: gomokuMctsFlagSpecFor(
      bareAdapter,
      clonePriorConfig(championRollout, 's256-clone-earlyprior-sched', {
        priorWeight: ROUND5_DESIGN_CONSTANTS.earlyPriorSchedule.earlyWeight,
        priorWeightSchedule: earlyPriorSchedule,
      }),
      GOMOKU_CLONE_EARLYPRIOR_FLAG,
    ),
  };

  const b4: RoundCandidate = {
    flag: GOMOKU_CLONE_ROOTOVERRIDE_FLAG,
    bucket: 'B4-explore' as BucketId,
    spec: gomokuMctsFlagSpecFor(
      bareAdapter,
      clonePriorConfig(championRollout, 's256-clone-rootoverride', { rootOverride: gomokuCloneTacticalRootOverride }),
      GOMOKU_CLONE_ROOTOVERRIDE_FLAG,
    ),
  };

  return [b3, ...b1, b2, b4];
}
