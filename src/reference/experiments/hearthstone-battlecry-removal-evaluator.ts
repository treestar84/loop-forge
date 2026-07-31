/**
 * hearthstone-battlecry-removal-evaluator — GAP-11 Phase 7 2회전 B2
 * (상대정보 기반 축 A6). 타깃은 **이번 회전 자체의 채굴 데이터**로
 * 재선정했다(설계 브리프의 명시 지시 — 1회전 probe-bank가 지목한 축을
 * 그대로 재사용하지 않는다):
 *
 *   `runs/hearthstone/challenge-l2-round2/judgment-summary.json`의
 *   `probeBank.mismatchByChoiceKind` (hearthstone-loss-mining-round2.ts가
 *   자동 집계, 일회성 스크립트 아님) —
 *     play 68.7% (101/147), heroPower 68.2% (15/22), attack 61.3% (19/31)
 *   즉 v3(`ismcts-s128-tempo-w4`)의 잔여 불일치 135건 중 101건(75%)이 여전히
 *   `play` 축이다.
 *
 * 그 `play` 불일치의 구체적 내용을 probe-bank-round2.json에서 세어 보면,
 * L2(앵커)가 분기점에서 고른 147개의 play 중 30개가 **elven-archer**(1/1
 * 몸집에 "전투의 함성: 1 피해" 배틀크라이)였다 — 몸값이 아니라 배틀크라이
 * 제거값으로 존재하는 카드다. 여기서 현행 `hearthstoneChoiceEvaluator`
 * (../hearthstone.ts, ADR-0011)의 구조적 비대칭이 드러난다:
 *   - 적 하수인을 죽이는 **주문**  → `removal`(350) 밴드
 *   - 적 하수인을 죽이는 **영웅 능력** → `removal`(350) 밴드
 *   - 적 하수인을 죽이는 **하수인 배틀크라이** → `develop`(200) 밴드에
 *     가산점만(200 + 몸값 + 표적값 ≈ 205~215) — 결국 **큰 몸집 전개보다도
 *     낮게, 제거 밴드보다 항상 낮게** 평가된다.
 * 그 함수 자신의 doc comment는 3번 밴드를 "주문/배틀크라이/영웅 능력/등가
 * 교환으로 적 하수인을 잡는 수"라고 적어 놓았으므로, 이 비대칭은 명시된
 * 설계 의도와 구현의 어긋남이다.
 *
 * 이 평가함수는 그 한 가지만 교정한다: `hearthstoneChoiceEvaluator`를 그대로
 * 호출한 뒤, "표적 적 하수인을 확실히 죽이는 피해 배틀크라이 하수인 플레이"
 * 만 `removal` 밴드로 승격한다(밴드 내부 서열은 기존 removal 공식과 같은
 * `+ target.attack`, 여기에 몸값 절반을 타이브레이크로 더한다 — 밴드 간격
 * 150 대비 충분히 작아 밴드를 넘지 않는다). 나머지 선택지의 점수는 한 글자도
 * 바꾸지 않는다.
 *
 * B3(`hearthstone-blended-evaluator.ts`, 마나커브 적합도 합성)와는 기전이
 * 다르다: B3는 같은 밴드 안에서 `play`끼리의 마나 효율을 가르고, 이쪽은
 * `play` 하나를 다른 밴드로 옮긴다. 같은 최다 불일치 축(`play`)을 겨냥하지만
 * 서로 독립적인 처치라 한 웨이브에서 동시에 검증할 수 있다.
 *
 * Layer: reference/experiments/ — `contract` 타입과 형제 `../hearthstone`만
 * import(dependency-rules.test.ts). 입력에 대해 순수·결정적(C1).
 */

import type { PlayerId } from '../../contract/types';
import {
  CARD_DEFS,
  CHOICE_EVALUATOR_TIER,
  hearthstoneChoiceEvaluator,
  type CardDef,
  type HearthstoneChoice,
  type HearthstonePlayerState,
  type HearthstoneState,
} from '../hearthstone';

const CARD_DEFS_BY_ID: ReadonlyMap<string, CardDef> = new Map(CARD_DEFS.map((def) => [def.id, def]));

function otherPlayer(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

function getPlayer(state: HearthstoneState, id: PlayerId): HearthstonePlayerState {
  const player = state.players[id];
  if (!player) throw new Error(`getPlayer: no such player ${id}`);
  return player;
}

function cardDefInHand(ps: HearthstonePlayerState, cardInstanceId: string): CardDef | undefined {
  const card = ps.hand.find((c) => c.instanceId === cardInstanceId);
  return card ? CARD_DEFS_BY_ID.get(card.defId) : undefined;
}

export function hearthstoneBattlecryRemovalEvaluator(
  state: HearthstoneState,
  player: PlayerId,
  choices: readonly HearthstoneChoice[],
): readonly number[] {
  const base = hearthstoneChoiceEvaluator(state, player, choices);
  const opponent = otherPlayer(player);
  const ps = getPlayer(state, player);
  const opp = getPlayer(state, opponent);

  return choices.map((choice, index) => {
    const baseScore = base[index] ?? 0;
    if (choice.kind !== 'play' || choice.targetId === undefined) return baseScore;

    const def = cardDefInHand(ps, choice.cardInstanceId);
    if (!def || def.kind !== 'minion' || def.battlecry.kind !== 'damageEnemy') return baseScore;

    const target = opp.board.find((m) => m.instanceId === choice.targetId);
    if (!target || def.battlecry.amount < target.health) return baseScore;

    // 즉사(lethal) 밴드로 이미 올라간 수는 절대 끌어내리지 않는다.
    const promoted = CHOICE_EVALUATOR_TIER.removal + target.attack + (def.attack + def.health) * 0.5;
    return Math.max(baseScore, promoted);
  });
}
