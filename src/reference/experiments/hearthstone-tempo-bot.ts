/**
 * hearthstone-tempo-bot — L3 홀드아웃 앵커 ('external-style2-l3').
 *
 * 설계 시 L2(hearthstone-opus-bot.ts)·L1(hearthstone-mid-bot.ts) 소스를
 * 참조하지 않았다 (GAP-11 D3 / docs/adr/0012): L1·L2와 독립적인 "제3의
 * 스타일"이어야 판정용 홀드아웃으로서 의미가 있기 때문이다. 그래서 카드
 * 평가조차 hearthstone.ts의 비공개 헬퍼를 재사용하지 않고 이 파일 안에서
 * 독립적으로 구현한다(공개 export인 CARD_DEFS/타입만 사용).
 *
 * 스타일: 밸류 교환이 아니라 "보드 장악·템포". 매 결정에서 아래 순서로 첫
 * 매치를 고른다.
 *   1) 전개 — legal `play` 중 미니언 우선, 그중 코스트 최댓값(= 마나를 가장
 *      많이 소진). 미니언이 없으면 주문 중 코스트 최댓값.
 *   2) 공격 — (a) 유리한 교환(내 공격력 ≥ 상대 체력 이고 상대 공격력 < 내
 *      체력)이 있으면 그중 "가장 공격력 높은 상대 미니언"을 제거. (b) 없으면
 *      명치를 때린다(공격력 최대 미니언으로).
 *   3) 영웅 능력 — legal에 있으면 사용(legal 자체가 마나·1회 제한을 이미 걸러줌).
 *   4) 그 외 — endTurn.
 *
 * 1수 앞 계산·탐색 없음(순수 산술 비교). 완전 결정론: 동률은 코스트/공격력
 * 내림차순 → defId/instanceId 알파벳 오름차순으로 깨므로 RNG조차 필요 없다.
 * Date.now()/Math.random() 미사용(determinism rule).
 *
 * Layer: reference/experiments/ 이므로 `contract`와 형제 `../hearthstone`
 * (타입 + CARD_DEFS)만 import한다 (src/__tests__/dependency-rules.test.ts).
 */

import type { BotFactory } from '../../contract/types';
import {
  CARD_DEFS,
  type CardDef,
  type HearthstoneChoice,
  type HearthstoneObservation,
  type MinionInstance,
} from '../hearthstone';

type PlayChoice = Extract<HearthstoneChoice, { readonly kind: 'play' }>;
type AttackChoice = Extract<HearthstoneChoice, { readonly kind: 'attack' }>;
type HeroPowerChoice = Extract<HearthstoneChoice, { readonly kind: 'heroPower' }>;

const HERO_POWER_DAMAGE = 1;

const CARD_DEFS_BY_ID: ReadonlyMap<string, CardDef> = new Map(CARD_DEFS.map((def) => [def.id, def]));

function isHeroTarget(targetId: string | undefined): boolean {
  return targetId !== undefined && targetId.startsWith('hero:');
}

function handDef(observation: HearthstoneObservation, cardInstanceId: string): CardDef | undefined {
  const card = observation.myHand.find((c) => c.instanceId === cardInstanceId);
  return card ? CARD_DEFS_BY_ID.get(card.defId) : undefined;
}

function minionById(
  board: readonly MinionInstance[],
  targetId: string | undefined,
): MinionInstance | undefined {
  return targetId === undefined ? undefined : board.find((m) => m.instanceId === targetId);
}

/**
 * Among `choices` (all plays of the SAME card) that damage an enemy target for
 * `amount`, prefer a kill on the highest-attack enemy minion; otherwise face.
 */
function pickDamageTargetedPlay(
  choices: readonly PlayChoice[],
  observation: HearthstoneObservation,
  amount: number,
): PlayChoice {
  let bestKill: { choice: PlayChoice; minion: MinionInstance } | undefined;
  for (const choice of choices) {
    const minion = minionById(observation.opponentBoard, choice.targetId);
    if (!minion || minion.health > amount) continue;
    if (
      bestKill === undefined ||
      minion.attack > bestKill.minion.attack ||
      (minion.attack === bestKill.minion.attack && minion.instanceId < bestKill.minion.instanceId)
    ) {
      bestKill = { choice, minion };
    }
  }
  if (bestKill) return bestKill.choice;
  const face = choices.find((choice) => isHeroTarget(choice.targetId));
  return face ?? (choices[0] as PlayChoice);
}

/** Buff the friendly minion with the highest attack (tempo: push damage through). */
function pickBuffTargetedPlay(
  choices: readonly PlayChoice[],
  observation: HearthstoneObservation,
): PlayChoice {
  let best: { choice: PlayChoice; minion: MinionInstance } | undefined;
  for (const choice of choices) {
    const minion = minionById(observation.myBoard, choice.targetId);
    if (!minion) continue;
    if (
      best === undefined ||
      minion.attack > best.minion.attack ||
      (minion.attack === best.minion.attack && minion.instanceId < best.minion.instanceId)
    ) {
      best = { choice, minion };
    }
  }
  return best?.choice ?? (choices[0] as PlayChoice);
}

/** Picks which single card to deploy this call: minion > spell, then cost desc. */
function pickPlay(
  legal: readonly HearthstoneChoice[],
  observation: HearthstoneObservation,
): PlayChoice | undefined {
  const plays = legal.filter((c): c is PlayChoice => c.kind === 'play');
  if (plays.length === 0) return undefined;

  let bestId: string | undefined;
  let bestDef: CardDef | undefined;
  for (const play of plays) {
    const def = handDef(observation, play.cardInstanceId);
    if (!def) continue;
    if (bestDef === undefined) {
      bestId = play.cardInstanceId;
      bestDef = def;
      continue;
    }
    const isMinion = def.kind === 'minion';
    const bestIsMinion = bestDef.kind === 'minion';
    const better =
      isMinion !== bestIsMinion
        ? isMinion
        : def.cost !== bestDef.cost
          ? def.cost > bestDef.cost
          : def.id !== bestDef.id
            ? def.id < bestDef.id
            : play.cardInstanceId < (bestId as string);
    if (better) {
      bestId = play.cardInstanceId;
      bestDef = def;
    }
  }
  if (bestDef === undefined || bestId === undefined) return plays[0];

  const cardPlays = plays
    .filter((play) => play.cardInstanceId === bestId)
    .slice()
    .sort((a, b) => (a.targetId ?? '').localeCompare(b.targetId ?? ''));
  if (cardPlays.length === 1) return cardPlays[0];

  if (bestDef.kind === 'spell') {
    return bestDef.effect.kind === 'damageEnemy'
      ? pickDamageTargetedPlay(cardPlays, observation, bestDef.effect.amount)
      : (cardPlays[0] as PlayChoice);
  }
  if (bestDef.battlecry.kind === 'damageEnemy') {
    return pickDamageTargetedPlay(cardPlays, observation, bestDef.battlecry.amount);
  }
  if (bestDef.battlecry.kind === 'buffFriendlyMinion') {
    return pickBuffTargetedPlay(cardPlays, observation);
  }
  return cardPlays[0];
}

/** Favorable trade first (kill without dying), then face with the biggest attacker. */
function pickAttack(
  legal: readonly HearthstoneChoice[],
  observation: HearthstoneObservation,
): AttackChoice | undefined {
  const attacks = legal.filter((c): c is AttackChoice => c.kind === 'attack');
  if (attacks.length === 0) return undefined;

  let bestTrade: { choice: AttackChoice; target: MinionInstance; attacker: MinionInstance } | undefined;
  let bestFace: { choice: AttackChoice; attacker: MinionInstance } | undefined;

  for (const attack of attacks) {
    const attacker = minionById(observation.myBoard, attack.attackerId);
    if (!attacker) continue;

    if (isHeroTarget(attack.targetId)) {
      if (
        bestFace === undefined ||
        attacker.attack > bestFace.attacker.attack ||
        (attacker.attack === bestFace.attacker.attack && attacker.instanceId < bestFace.attacker.instanceId)
      ) {
        bestFace = { choice: attack, attacker };
      }
      continue;
    }

    const target = minionById(observation.opponentBoard, attack.targetId);
    if (!target) continue;
    if (attacker.attack < target.health || target.attack >= attacker.health) continue;
    if (
      bestTrade === undefined ||
      target.attack > bestTrade.target.attack ||
      (target.attack === bestTrade.target.attack && attacker.attack > bestTrade.attacker.attack) ||
      (target.attack === bestTrade.target.attack &&
        attacker.attack === bestTrade.attacker.attack &&
        attack.attackerId + '>' + attack.targetId <
          bestTrade.choice.attackerId + '>' + bestTrade.choice.targetId)
    ) {
      bestTrade = { choice: attack, target, attacker };
    }
  }

  return bestTrade?.choice ?? bestFace?.choice;
}

/** Ping a minion the hero power can finish off, else face. */
function pickHeroPower(
  legal: readonly HearthstoneChoice[],
  observation: HearthstoneObservation,
): HeroPowerChoice | undefined {
  const powers = legal.filter((c): c is HeroPowerChoice => c.kind === 'heroPower');
  if (powers.length === 0) return undefined;

  let bestKill: { choice: HeroPowerChoice; minion: MinionInstance } | undefined;
  for (const power of powers) {
    const minion = minionById(observation.opponentBoard, power.targetId);
    if (!minion || minion.health > HERO_POWER_DAMAGE) continue;
    if (
      bestKill === undefined ||
      minion.attack > bestKill.minion.attack ||
      (minion.attack === bestKill.minion.attack && minion.instanceId < bestKill.minion.instanceId)
    ) {
      bestKill = { choice: power, minion };
    }
  }
  if (bestKill) return bestKill.choice;
  return powers.find((power) => isHeroTarget(power.targetId)) ?? powers[0];
}

export const hearthstoneTempoBot: BotFactory<HearthstoneObservation, HearthstoneChoice> = (_seed) => ({
  id: 'hearthstone-tempo-l3',
  decide(_decisionPoint, observation, legal) {
    const play = pickPlay(legal, observation);
    if (play) return play;

    const attack = pickAttack(legal, observation);
    if (attack) return attack;

    const heroPower = pickHeroPower(legal, observation);
    if (heroPower) return heroPower;

    const endTurn = legal.find((choice) => choice.kind === 'endTurn');
    return endTurn ?? (legal[0] as HearthstoneChoice);
  },
});
