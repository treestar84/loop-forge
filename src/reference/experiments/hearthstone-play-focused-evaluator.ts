/**
 * hearthstone-play-focused-evaluator — GAP-11 Phase 7 B2 (opponent-targeted
 * axis, main-loop design brief's own instruction): a one-off analysis of
 * `runs/hearthstone/probe-bank.json`'s 200 probes (classified by
 * `encodeChoice` prefix — `play`/`attack`/`heroPower`, this adapter has no
 * mulligan decision point) found `play` mismatches most often against the
 * v2 synthetic bot (play 61.4% of 127, attack 56.8% of 44, heroPower 48.3%
 * of 29 — scratch script, deleted after use per the design brief's own
 * instruction; these three percentages are this round's only record of it).
 *
 * Deliberately a DIFFERENT approach from B3's `hearthstoneChoiceEvaluator`
 * (../hearthstone.ts, ADR-0011) rather than a weight sweep of it: this
 * evaluator scores `attack`/`heroPower`/`endTurn` choices with a flat,
 * undifferentiated baseline (no lethal override, no trade/removal
 * distinction) so the entire tree-prior signal concentrates on
 * discriminating `play` choices well — an isolation test of whether the
 * `play` axis specifically, on its own, is worth improving. Play choices are
 * valued by mana-curve fit (how much of the current turn's mana a card
 * spends, rewarding efficient use over `hearthstoneChoiceEvaluator`'s flat
 * tempo-only body value) plus a kill-priority battlecry bonus. May fail to
 * beat B3 — a valid data point either way per the design brief.
 *
 * Layer: reference/experiments/ — imports only `contract`/`kernel` types
 * plus sibling `../hearthstone` (types + CARD_DEFS), per
 * src/__tests__/dependency-rules.test.ts's reference-layer edges. Pure,
 * deterministic function of its inputs (no Date.now()/Math.random(), C1).
 */

import type { PlayerId } from '../../contract/types';
import {
  CARD_DEFS,
  type CardDef,
  type HearthstoneChoice,
  type HearthstonePlayerState,
  type HearthstoneState,
} from '../hearthstone';

const CARD_DEFS_BY_ID: ReadonlyMap<string, CardDef> = new Map(CARD_DEFS.map((def) => [def.id, def]));

/** Flat baseline for every non-`play` choice (deliberately undifferentiated —
 * see file doc comment). Kept nonzero-but-small so `endTurn` still ranks
 * below any genuinely useful play, without carrying any of
 * `hearthstoneChoiceEvaluator`'s lethal/trade/removal structure. */
const NON_PLAY_BASELINE = 10;
const END_TURN_BASELINE = 0;

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

function isHeroTargetFor(targetId: string | undefined, player: PlayerId): boolean {
  return targetId === `hero:${player}`;
}

/** Mana-curve fit: how much of the mana pool a card actually spends —
 * distinct from `hearthstoneChoiceEvaluator`'s flat attack+health tempo
 * value, this rewards using the turn's mana efficiently regardless of the
 * card's raw body size. */
function curveFitValue(def: CardDef, manaCurrent: number): number {
  if (manaCurrent <= 0) return def.cost;
  return (def.cost / manaCurrent) * 10;
}

export function hearthstonePlayFocusedEvaluator(
  state: HearthstoneState,
  player: PlayerId,
  choices: readonly HearthstoneChoice[],
): readonly number[] {
  const opponent = otherPlayer(player);
  const ps = getPlayer(state, player);
  const opp = getPlayer(state, opponent);

  return choices.map((choice) => {
    if (choice.kind === 'endTurn') return END_TURN_BASELINE;
    if (choice.kind !== 'play') return NON_PLAY_BASELINE;

    const def = cardDefInHand(ps, choice.cardInstanceId);
    if (!def) return NON_PLAY_BASELINE;

    let score = curveFitValue(def, ps.manaCurrent);

    if (def.kind === 'spell') {
      if (def.effect.kind === 'damageEnemy' && choice.targetId !== undefined) {
        if (isHeroTargetFor(choice.targetId, opponent)) {
          score += def.effect.amount;
        } else {
          const target = opp.board.find((m) => m.instanceId === choice.targetId);
          if (target && def.effect.amount >= target.health) score += target.attack + 5; // kill-priority bonus
        }
      } else if (def.effect.kind === 'drawCard') {
        score += def.effect.count;
      }
      return score;
    }

    // Minion: curve fit already counted above; battlecry adds a kill bonus
    // (matching the design brief's "제거는 최저체력·고가치 우선" for the
    // subset of plays that carry a damage battlecry) but no flat tempo term.
    switch (def.battlecry.kind) {
      case 'damageEnemy': {
        if (choice.targetId !== undefined) {
          if (isHeroTargetFor(choice.targetId, opponent)) {
            score += def.battlecry.amount;
          } else {
            const target = opp.board.find((m) => m.instanceId === choice.targetId);
            if (target && def.battlecry.amount >= target.health) score += target.attack + 5;
          }
        }
        break;
      }
      case 'drawCard':
        score += def.battlecry.count;
        break;
      case 'healOwnHero':
        score += Math.max(0, Math.min(def.battlecry.amount, 30 - ps.hero.health)) * 0.5;
        break;
      case 'buffFriendlyMinion':
        score += 1;
        break;
      case 'none':
        break;
      default:
        break;
    }
    return score;
  });
}
