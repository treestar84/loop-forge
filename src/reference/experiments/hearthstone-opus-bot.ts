/**
 * hearthstone-opus-bot — a from-scratch heuristic Hearthstone bot designed in
 * ONE pass ("what would a strong player do?"), WITHOUT going through Loop
 * Forge's scoring / wave / gate machinery. This is the "just ask the LLM to
 * design a bot" arm of the benchmark experiment (docs/BENCHMARK-EXPERIMENT.md,
 * column A) — a comparison subject, deliberately kept OUT of the game adapter's
 * strategySurface so it is never confused with a pipeline-validated strategy.
 *
 * Layer: this file lives in `reference/` and imports only from `contract`,
 * `kernel`, and its sibling `../hearthstone` (types + CARD_DEFS) — the reference
 * layer's allowed edges (src/__tests__/dependency-rules.test.ts). All
 * randomness flows through `createRng(seed)` (tie-breaking only); no
 * Date.now()/Math.random() (determinism rule).
 *
 * Design (single-shot heuristic, no search). The engine asks for ONE action at
 * a time and re-asks until endTurn, so the bot is a per-action value maximiser
 * with two hard-priority overrides layered on top:
 *
 *   1. LETHAL — if the damage I can still push at the enemy hero this turn
 *      (ready minions going face + affordable Spark Bolts + hero power, all
 *      reachable because this reduced game has no Taunt) already meets the
 *      enemy hero's health, commit to face: minion swings first (free), then
 *      Spark Bolt, then hero power. Recomputed every call, so it drives the
 *      whole lethal sequence to completion.
 *   2. Otherwise SCORE every legal non-endTurn action and take the best while
 *      it is worth more than passing:
 *        - develop the board (a minion's tempo ≈ attack+health, plus its
 *          battlecry evaluated against its actual chosen target);
 *        - trade only when it is favourable (kill their minion without losing
 *          mine, or trade up into a bigger body), scaled UP when the enemy
 *          board threatens lethal soon (defense before greed);
 *        - point removal (Spark Bolt / Elven Archer ping / hero power) at the
 *          highest-value low-health enemy minion — a 1-damage ping on a
 *          Magma Rager (5/1) is worth far more than the same ping on the face;
 *        - push leftover attacks into the enemy hero.
 *      Hero-power-to-face is valued near zero on purpose: spending 2 mana for 1
 *      face damage instead of developing is a losing line (the wave's
 *      `heroPowerSpam` flag confirmed this empirically), so the bot only ever
 *      fires it to snipe a minion or to close out lethal.
 */

import type { BotFactory, PlayerId } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type {
  CardDef,
  HearthstoneChoice,
  HearthstoneObservation,
  MinionInstance,
} from '../hearthstone';
import { CARD_DEFS } from '../hearthstone';

const STARTING_HERO_HEALTH = 30;
const HERO_POWER_COST = 2;
const HERO_POWER_DAMAGE = 1;
const SPARK_BOLT_ID = 'spark-bolt';
const SPARK_BOLT_COST = 2;
const SPARK_BOLT_DAMAGE = 3;

const DEFS_BY_ID: ReadonlyMap<string, CardDef> = new Map(CARD_DEFS.map((d) => [d.id, d]));

/** Tempo proxy for a body on the board: a bigger stat line is worth more. */
function bodyValue(attack: number, health: number): number {
  return attack + health;
}

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

// --- Threat / pressure ----------------------------------------------------

/** How hard is the enemy board pressing me? Scales up removal/trade value so
 * the bot defends its life total before pressing its own advantage. */
function pressureMultiplier(observation: HearthstoneObservation): number {
  const enemyBoardAttack = observation.opponentBoard.reduce((sum, m) => sum + m.attack, 0);
  const myHealth = observation.myHero.health;
  if (enemyBoardAttack >= myHealth) return 2.0;
  if (enemyBoardAttack >= myHealth * 0.6) return 1.4;
  return 1.0;
}

// --- Lethal ---------------------------------------------------------------

/** Face damage I can still deliver THIS turn, given a shared mana pool. Every
 * source is reachable because this reduced game has no Taunt. */
function reachableFaceDamage(
  observation: HearthstoneObservation,
  legal: readonly HearthstoneChoice[],
): number {
  const enemy = enemyOf(observation.self);
  const enemyHero = heroTargetId(enemy);

  const faceAttackers = new Set<string>();
  for (const c of legal) {
    if (c.kind === 'attack' && c.targetId === enemyHero) faceAttackers.add(c.attackerId);
  }
  let minionDamage = 0;
  for (const id of faceAttackers) {
    const m = findMinion(observation.myBoard, id);
    if (m) minionDamage += m.attack;
  }

  let mana = observation.myMana.current;
  const sparkInHand = observation.myHand.filter((c) => c.defId === SPARK_BOLT_ID).length;
  const sparksAffordable = Math.min(sparkInHand, Math.floor(mana / SPARK_BOLT_COST));
  mana -= sparksAffordable * SPARK_BOLT_COST;
  const spellDamage = sparksAffordable * SPARK_BOLT_DAMAGE;

  const heroPowerDamage =
    !observation.myHeroPowerUsed && mana >= HERO_POWER_COST ? HERO_POWER_DAMAGE : 0;

  return minionDamage + spellDamage + heroPowerDamage;
}

/** Given lethal is reachable, return the next action that pushes face damage,
 * cheapest resource first (free minion swing → Spark Bolt → hero power). */
function nextLethalAction(
  observation: HearthstoneObservation,
  legal: readonly HearthstoneChoice[],
): HearthstoneChoice | undefined {
  const enemyHero = heroTargetId(enemyOf(observation.self));
  const faceAttack = legal.find((c) => c.kind === 'attack' && c.targetId === enemyHero);
  if (faceAttack) return faceAttack;
  const sparkFace = legal.find(
    (c) =>
      c.kind === 'play' &&
      c.targetId === enemyHero &&
      handDef(observation, c.cardInstanceId)?.id === SPARK_BOLT_ID,
  );
  if (sparkFace) return sparkFace;
  const heroFace = legal.find((c) => c.kind === 'heroPower' && c.targetId === enemyHero);
  return heroFace;
}

// --- Targeted-damage value ------------------------------------------------

/** Value of dealing `amount` damage to `targetId` (a hero or a minion). */
function damageValue(
  observation: HearthstoneObservation,
  amount: number,
  targetId: string,
  pressure: number,
): number {
  const enemyHero = heroTargetId(enemyOf(observation.self));
  if (targetId === enemyHero) {
    return amount * FACE_WEIGHT;
  }
  const m = findMinion(observation.opponentBoard, targetId);
  if (!m) return 0;
  if (amount >= m.health) {
    return (bodyValue(m.attack, m.health) + KILL_BONUS + m.attack * ATTACK_REMOVAL_BONUS) * pressure;
  }
  return amount * CHIP_ON_MINION;
}

// --- Weights (set by judgement, never tuned through the pipeline) ----------

const FACE_WEIGHT = 1.0; // one point of face damage ≈ one unit of value
const KILL_BONUS = 2.0; // clean removal is worth extra tempo
const TRADE_BASE = 1.0; // small nudge to make an even trade non-negative
const ATTACK_REMOVAL_BONUS = 0.3; // prefer killing high-attack threats
const CHIP_ON_MINION = 0.4; // damaging but not killing a minion is weak
const DRAW_VALUE = 1.0; // per card drawn
const HERO_POWER_FACE_VALUE = 0.5; // deliberately tiny: don't waste 2 mana for 1 face

// --- Per-choice scoring ---------------------------------------------------

function scorePlay(
  observation: HearthstoneObservation,
  choice: Extract<HearthstoneChoice, { kind: 'play' }>,
  pressure: number,
): number {
  const def = handDef(observation, choice.cardInstanceId);
  if (!def) return 0;

  if (def.kind === 'spell') {
    if (def.effect.kind === 'damageEnemy') {
      if (choice.targetId === undefined) return 0;
      return damageValue(observation, def.effect.amount, choice.targetId, pressure);
    }
    // drawCard: card advantage, discounted when the hand is already full-ish.
    const handRoom = Math.max(0, 10 - observation.myHand.length);
    return Math.min(def.effect.count, handRoom) * DRAW_VALUE;
  }

  // Minion: tempo of the body plus its battlecry against the chosen target.
  let value = bodyValue(def.attack, def.health) + (def.charge ? 0.5 : 0);
  switch (def.battlecry.kind) {
    case 'none':
      break;
    case 'damageEnemy':
      if (choice.targetId !== undefined) {
        value += damageValue(observation, def.battlecry.amount, choice.targetId, pressure);
      }
      break;
    case 'drawCard':
      value += def.battlecry.count * DRAW_VALUE;
      break;
    case 'buffFriendlyMinion': {
      const target = choice.targetId ? findMinion(observation.myBoard, choice.targetId) : undefined;
      const readyNow = target && !target.summoningSick && !target.hasAttacked ? 0.5 : 0;
      const attackBias = target ? target.attack * 0.05 : 0;
      value += 1.0 + readyNow + attackBias;
      break;
    }
    case 'healOwnHero': {
      const missing = STARTING_HERO_HEALTH - observation.myHero.health;
      const healed = Math.max(0, Math.min(def.battlecry.amount, missing));
      value += healed * (pressure > 1 ? 0.4 : 0.1);
      break;
    }
    default:
      break;
  }
  return value;
}

function scoreAttack(
  observation: HearthstoneObservation,
  choice: Extract<HearthstoneChoice, { kind: 'attack' }>,
  pressure: number,
): number {
  const attacker = findMinion(observation.myBoard, choice.attackerId);
  if (!attacker) return 0;

  const enemyHero = heroTargetId(enemyOf(observation.self));
  if (choice.targetId === enemyHero) {
    return attacker.attack * FACE_WEIGHT;
  }

  const target = findMinion(observation.opponentBoard, choice.targetId);
  if (!target) return 0;

  const kills = attacker.attack >= target.health;
  const dies = target.attack >= attacker.health;
  const targetBody = bodyValue(target.attack, target.health);
  const attackerBody = bodyValue(attacker.attack, attacker.health);
  const removalBonus = target.attack * ATTACK_REMOVAL_BONUS;

  if (kills && !dies) return (targetBody + KILL_BONUS + removalBonus) * pressure;
  if (kills && dies) return (targetBody - attackerBody + TRADE_BASE + removalBonus) * pressure;
  if (!kills && dies) return -(attackerBody * 0.5); // lose my minion, kill nothing
  return attacker.attack * CHIP_ON_MINION; // scratch damage; face is usually better
}

function scoreHeroPower(
  observation: HearthstoneObservation,
  choice: Extract<HearthstoneChoice, { kind: 'heroPower' }>,
  pressure: number,
): number {
  const enemyHero = heroTargetId(enemyOf(observation.self));
  if (choice.targetId === enemyHero) {
    return HERO_POWER_DAMAGE * HERO_POWER_FACE_VALUE;
  }
  // Ping a minion — only genuinely good when it secures a kill.
  return damageValue(observation, HERO_POWER_DAMAGE, choice.targetId, pressure);
}

function scoreChoice(
  observation: HearthstoneObservation,
  choice: HearthstoneChoice,
  pressure: number,
): number {
  switch (choice.kind) {
    case 'play':
      return scorePlay(observation, choice, pressure);
    case 'attack':
      return scoreAttack(observation, choice, pressure);
    case 'heroPower':
      return scoreHeroPower(observation, choice, pressure);
    case 'endTurn':
      return 0;
    default:
      return 0;
  }
}

export const hearthstoneOpusBot: BotFactory<HearthstoneObservation, HearthstoneChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'hearthstone-opus',
    decide(_decisionPoint, observation, legal) {
      // Priority 1: lethal — commit to face if the enemy hero is already dead
      // to this turn's reachable damage.
      if (observation.opponentHero.health > 0) {
        const reach = reachableFaceDamage(observation, legal);
        if (reach >= observation.opponentHero.health) {
          const action = nextLethalAction(observation, legal);
          if (action) return action;
        }
      }

      // Priority 2: value-maximising action, ending the turn once nothing beats
      // passing. Ties broken deterministically via the seeded RNG.
      const pressure = pressureMultiplier(observation);
      let best: HearthstoneChoice[] = [];
      let bestScore = 0; // endTurn's implicit value: stop when nothing is positive
      for (const choice of legal) {
        if (choice.kind === 'endTurn') continue;
        const score = scoreChoice(observation, choice, pressure);
        if (score > bestScore) {
          bestScore = score;
          best = [choice];
        } else if (score === bestScore && bestScore > 0) {
          best.push(choice);
        }
      }

      if (best.length === 0) {
        return (legal.find((c) => c.kind === 'endTurn') ?? legal[0]) as HearthstoneChoice;
      }
      if (best.length === 1) return best[0] as HearthstoneChoice;
      return best[rng.nextInt(best.length)] as HearthstoneChoice;
    },
  };
};
