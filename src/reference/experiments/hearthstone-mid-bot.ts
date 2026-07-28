/**
 * hearthstone-mid-bot — L1 anchor rung (docs/GAP-ANALYSIS-11.md D3/Phase 1-C):
 * an independent, one-shot mid-skill design meant to sit strictly between
 * `baselines.heuristic` and the L2 anchor
 * (../experiments/hearthstone-opus-bot.ts) on the anchor ladder. Designed from
 * scratch by reading this game's adapter (../hearthstone.ts) — NOT by copying
 * hearthstone-opus-bot.ts's per-choice value model (pressure multiplier,
 * reachable-face-damage-with-spells lethal, or targeted-removal weighting),
 * per the task brief's "no logic copy" rule.
 *
 * L1 grade — "knows lethal-with-minions and clean trades, no removal math":
 *   1. LETHAL, minions only: if the sum of attack across every minion that
 *      currently has a legal face attack already meets or exceeds the enemy
 *      hero's health, commit to face (attack face this call; repeated calls
 *      keep pushing until either lethal lands or no face attack remains).
 *      Unlike the L2 anchor, this ignores Spark Bolt/hero power reach — a
 *      mid-skill player counts the swings on board, not the exact spell math.
 *   2. Otherwise, per decision:
 *      a. Prefer developing the board: among legal minion plays, play the
 *         affordable one with the biggest body (attack+health); damage
 *         spells target the highest-attack enemy minion they can kill
 *         outright, else the face; draw spells are always worth playing.
 *      b. Attack: take a trade that kills the enemy minion without losing my
 *         own, OR a trade where my minion dies but takes down a strictly
 *         costlier enemy minion (a "worth it" trade a mid-skill player would
 *         recognize on sight) — otherwise attack face; otherwise take any
 *         legal scratch attack.
 *      c. Hero power to face only when nothing above applies.
 * Deliberately missing (the ceiling that keeps this below the L2 anchor): no
 * pressure/defense scaling (never plays more cautiously when behind on
 * health), no valuation of battlecry effects beyond "always worth playing",
 * and no reachable-damage accounting for spells/hero power inside the lethal
 * check.
 *
 * Layer: reference/ — imports only contract/kernel types plus sibling
 * ../hearthstone for its exported types/CARD_DEFS (dependency-rules.test.ts's
 * reference-layer edges). Randomness flows through createRng(seed), used only
 * for deterministic tie-breaking (C1 determinism rule).
 */

import type { BotFactory, PlayerId } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type { CardDef, HearthstoneChoice, HearthstoneObservation, MinionInstance } from '../hearthstone';
import { CARD_DEFS } from '../hearthstone';

const DEFS_BY_ID: ReadonlyMap<string, CardDef> = new Map(CARD_DEFS.map((d) => [d.id, d]));

function enemyOf(self: PlayerId): PlayerId {
  return self === 0 ? 1 : 0;
}

function heroTargetId(player: PlayerId): string {
  return `hero:${player}`;
}

function findMinion(board: readonly MinionInstance[], id: string): MinionInstance | undefined {
  return board.find((m) => m.instanceId === id);
}

function handDef(observation: HearthstoneObservation, cardInstanceId: string): CardDef | undefined {
  const card = observation.myHand.find((c) => c.instanceId === cardInstanceId);
  return card ? DEFS_BY_ID.get(card.defId) : undefined;
}

function bodyValue(attack: number, health: number): number {
  return attack + health;
}

/** Minions-only reachable face damage this turn — no spells, no hero power. */
function minionFaceDamage(observation: HearthstoneObservation, legal: readonly HearthstoneChoice[]): number {
  const enemyHero = heroTargetId(enemyOf(observation.self));
  const attackerIds = new Set<string>();
  for (const c of legal) {
    if (c.kind === 'attack' && c.targetId === enemyHero) attackerIds.add(c.attackerId);
  }
  let total = 0;
  for (const id of attackerIds) {
    const m = findMinion(observation.myBoard, id);
    if (m) total += m.attack;
  }
  return total;
}

function chooseLethal(observation: HearthstoneObservation, legal: readonly HearthstoneChoice[]): HearthstoneChoice | undefined {
  const enemyHero = heroTargetId(enemyOf(observation.self));
  return legal.find((c) => c.kind === 'attack' && c.targetId === enemyHero);
}

function choosePlay(observation: HearthstoneObservation, plays: readonly Extract<HearthstoneChoice, { kind: 'play' }>[]): HearthstoneChoice | undefined {
  const enemyHero = heroTargetId(enemyOf(observation.self));

  let best: HearthstoneChoice | undefined;
  let bestValue = -Infinity;
  for (const choice of plays) {
    const def = handDef(observation, choice.cardInstanceId);
    if (!def) continue;
    let value: number;
    if (def.kind === 'spell') {
      if (def.effect.kind === 'damageEnemy') {
        // Prefer a target this spell can outright kill; otherwise face.
        const target = choice.targetId !== undefined ? findMinion(observation.opponentBoard, choice.targetId) : undefined;
        const killsMinion = target !== undefined && def.effect.amount >= target.health;
        value = killsMinion ? bodyValue(target.attack, target.health) + 5 : choice.targetId === enemyHero ? def.effect.amount : 0;
      } else {
        value = def.effect.count; // draw spells: always worth playing.
      }
    } else {
      value = bodyValue(def.attack, def.health);
    }
    if (value > bestValue) {
      bestValue = value;
      best = choice;
    }
  }
  return best;
}

function chooseAttack(observation: HearthstoneObservation, attacks: readonly Extract<HearthstoneChoice, { kind: 'attack' }>[]): HearthstoneChoice | undefined {
  const enemyHero = heroTargetId(enemyOf(observation.self));

  const cleanKills: HearthstoneChoice[] = [];
  const worthTrades: HearthstoneChoice[] = [];
  for (const c of attacks) {
    const target = findMinion(observation.opponentBoard, c.targetId);
    if (!target) continue;
    const attacker = findMinion(observation.myBoard, c.attackerId);
    if (!attacker) continue;
    const kills = attacker.attack >= target.health;
    const dies = target.attack >= attacker.health;
    if (kills && !dies) {
      cleanKills.push(c);
    } else if (kills && dies) {
      // Worth it if I take down a strictly bigger investment than I lose.
      const targetBody = bodyValue(target.attack, target.health);
      const attackerBody = bodyValue(attacker.attack, attacker.maxHealth);
      if (targetBody > attackerBody) worthTrades.push(c);
    }
  }
  if (cleanKills.length > 0) return cleanKills[0];
  if (worthTrades.length > 0) return worthTrades[0];

  const faceAttacks = attacks.filter((c) => c.targetId === enemyHero);
  if (faceAttacks.length > 0) return faceAttacks[0];

  return attacks[0];
}

export const hearthstoneMidBot: BotFactory<HearthstoneObservation, HearthstoneChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'hearthstone-mid-l1',
    decide(_decisionPoint, observation, legal) {
      if (observation.opponentHero.health > 0 && minionFaceDamage(observation, legal) >= observation.opponentHero.health) {
        const lethal = chooseLethal(observation, legal);
        if (lethal) return lethal;
      }

      const plays = legal.filter((c): c is Extract<HearthstoneChoice, { kind: 'play' }> => c.kind === 'play');
      if (plays.length > 0) {
        const play = choosePlay(observation, plays);
        if (play) return play;
      }

      const attacks = legal.filter((c): c is Extract<HearthstoneChoice, { kind: 'attack' }> => c.kind === 'attack');
      if (attacks.length > 0) {
        const attack = chooseAttack(observation, attacks);
        if (attack) return attack;
      }

      const heroPowers = legal.filter((c): c is Extract<HearthstoneChoice, { kind: 'heroPower' }> => c.kind === 'heroPower');
      if (heroPowers.length > 0) {
        const enemyHero = heroTargetId(enemyOf(observation.self));
        return heroPowers.find((c) => c.targetId === enemyHero) ?? (heroPowers[0] as HearthstoneChoice);
      }

      return (legal.find((c) => c.kind === 'endTurn') ?? legal[rng.nextInt(legal.length)]) as HearthstoneChoice;
    },
  };
};
