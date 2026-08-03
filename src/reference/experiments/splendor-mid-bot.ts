/**
 * splendor-mid-bot — L1 anchor rung (docs/GAP-ANALYSIS-11.md D3/Phase 1-C):
 * an independent, one-shot mid-skill design meant to sit strictly between
 * `baselines.heuristic` and the L2 anchor (../experiments/splendor-opus-bot.ts)
 * on the anchor ladder. Designed from scratch by reading this game's adapter
 * (../splendor.ts) — NOT by reading splendor-opus-bot.ts, per the task
 * brief's "no logic copy" rule (mirrors dominion-mid-bot.ts / gomoku-mid-bot.ts
 * / hearthstone-mid-bot.ts's identical doc-comment convention).
 *
 * L1 grade — "knows to buy points and take gems toward a target, no
 * multi-turn planning":
 *   Buy priority (fresh action phase, no memory across turns):
 *     1. Buy the highest-point AFFORDABLE board/reserved card if one is
 *        legal — a mid-skill player has learned to cash in when they can,
 *        unlike the adapter's own heuristic baseline (cheapest-first).
 *     2. Otherwise pick a single "target" card = the highest-point card on
 *        the board the player could afford within 2 more gem-takes (an
 *        approximate near-term goal), and take gems toward its largest
 *        color deficit.
 *     3. If no target is within reach, reserve the highest-point board card
 *        when a reserve slot is free (no gold-availability gating, no
 *        color-alignment reasoning — just "grab the best card seen so far").
 *   No noble-approach planning, no lookahead beyond "can I afford this
 *   after 1-2 more takes", no engine/coverage reasoning, no color-based
 *   take-continuation stop rule beyond "keep taking toward the target until
 *   its deficit hits zero, then takeDone".
 * Deliberately missing (the ceiling that keeps this below the L2 anchor):
 * no reserve-for-block awareness (never reserves purely to deny the
 * opponent), no discard prioritization beyond "shed whatever gem is least
 * needed for the current target", no adaptive target re-evaluation once
 * gems are already in hand mid-take-sequence.
 *
 * Layer: reference/ — imports only contract/kernel types plus sibling
 * ../splendor for its exported types (dependency-rules.test.ts's reference-
 * layer edges). Randomness flows through createRng(seed), used only for
 * deterministic fallback tie-breaking (C1 determinism rule).
 */

import type { BotFactory } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type {
  Color,
  PlayerState,
  SplendorCard,
  SplendorChoice,
  SplendorObservation,
} from '../splendor';

const COLORS: readonly Color[] = ['w', 'u', 'g', 'r', 'b'];

function power(player: PlayerState, color: Color): number {
  return player.gems[color] + player.cards[color].length;
}

function deficits(player: PlayerState, card: SplendorCard): Readonly<Record<Color, number>> {
  const out: Record<Color, number> = { w: 0, u: 0, g: 0, r: 0, b: 0 };
  for (const c of COLORS) {
    out[c] = Math.max(0, card.cost[c] - power(player, c));
  }
  return out;
}

function totalDeficit(player: PlayerState, card: SplendorCard): number {
  return COLORS.reduce((sum, c) => sum + Math.max(0, card.cost[c] - power(player, c)), 0);
}

function affordable(player: PlayerState, card: SplendorCard): boolean {
  return totalDeficit(player, card) <= player.gems.gold;
}

function findCard(observation: SplendorObservation, cardId: string): SplendorCard | undefined {
  for (const level of [1, 2, 3] as const) {
    const found = observation.board[level].find((c) => c.id === cardId);
    if (found) return found;
  }
  for (const player of observation.players) {
    const found = player.reserved.find((c) => c.id === cardId);
    if (found) return found;
  }
  return undefined;
}

function allBoardCards(observation: SplendorObservation): SplendorCard[] {
  return [...observation.board[1], ...observation.board[2], ...observation.board[3]];
}

/** Highest-point board card reachable within 2 more gem-takes (deficit <= 2 after gold). */
function nearTermTarget(self: PlayerState, observation: SplendorObservation): SplendorCard | null {
  const reachable = allBoardCards(observation).filter(
    (card) => Math.max(0, totalDeficit(self, card) - self.gems.gold) <= 2,
  );
  if (reachable.length === 0) return null;
  const sorted = [...reachable].sort((a, b) => b.points - a.points || (a.id < b.id ? -1 : 1));
  return sorted[0] ?? null;
}

const splendorMidBot: BotFactory<SplendorObservation, SplendorChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'splendor-mid-l1',
    decide(decisionPoint, observation, legal) {
      const self = observation.players[observation.self] as PlayerState;

      if (decisionPoint === 'noble') {
        const nobleChoices = legal.filter(
          (c): c is Extract<SplendorChoice, { kind: 'noble' }> => c.kind === 'noble',
        );
        const sorted = [...nobleChoices].sort((a, b) => (a.nobleId < b.nobleId ? -1 : 1));
        return sorted[0] as SplendorChoice;
      }

      // 1. Buy the highest-point affordable card whenever one is legal, on
      // both the fresh action phase and the take-continuation phase (the
      // adapter only ever offers `buy` during the action phase, so this
      // branch is only reachable there in practice).
      const buys = legal.filter((c): c is Extract<SplendorChoice, { kind: 'buy' }> => c.kind === 'buy');
      if (buys.length > 0) {
        const byPoints = buys
          .map((c) => ({ choice: c, points: findCard(observation, c.cardId)?.points ?? 0 }))
          .sort((a, b) => b.points - a.points || (a.choice.cardId < b.choice.cardId ? -1 : 1));
        return byPoints[0]!.choice;
      }

      const target = nearTermTarget(self, observation);

      if (decisionPoint === 'take') {
        const takes = legal.filter((c): c is Extract<SplendorChoice, { kind: 'take' }> => c.kind === 'take');
        const takeDone = legal.find((c) => c.kind === 'takeDone');
        if (takes.length === 0) return takeDone as SplendorChoice;
        if (target) {
          const gaps = deficits(self, target);
          const byGap = takes
            .map((c) => ({ choice: c, gap: gaps[c.color] }))
            .sort((a, b) => b.gap - a.gap || (a.choice.color < b.choice.color ? -1 : 1));
          if (byGap[0]!.gap > 0) return byGap[0]!.choice;
        }
        return (takeDone as SplendorChoice) ?? (takes[0] as SplendorChoice);
      }

      // decisionPoint === 'action', no buy was legal.
      if (target) {
        const gaps = deficits(self, target);
        const takes = legal.filter((c): c is Extract<SplendorChoice, { kind: 'take' }> => c.kind === 'take');
        const usefulTakes = takes.filter((c) => gaps[c.color] > 0);
        if (usefulTakes.length > 0) {
          const byGap = usefulTakes
            .map((c) => ({ choice: c, gap: gaps[c.color] }))
            .sort((a, b) => b.gap - a.gap || (a.choice.color < b.choice.color ? -1 : 1));
          return byGap[0]!.choice;
        }
      }

      const reserves = legal.filter((c): c is Extract<SplendorChoice, { kind: 'reserve' }> => c.kind === 'reserve');
      if (reserves.length > 0) {
        const byPoints = reserves
          .map((c) => ({ choice: c, points: findCard(observation, c.cardId)?.points ?? 0 }))
          .sort((a, b) => b.points - a.points || (a.choice.cardId < b.choice.cardId ? -1 : 1));
        return byPoints[0]!.choice;
      }

      const reserveBlinds = legal.filter(
        (c): c is Extract<SplendorChoice, { kind: 'reserveBlind' }> => c.kind === 'reserveBlind',
      );
      if (reserveBlinds.length > 0) {
        const sorted = [...reserveBlinds].sort((a, b) => b.level - a.level);
        return sorted[0] as SplendorChoice;
      }

      const takesFallback = legal.filter((c): c is Extract<SplendorChoice, { kind: 'take' }> => c.kind === 'take');
      if (takesFallback.length > 0) {
        const byBank = takesFallback
          .map((c) => ({ choice: c, bank: observation.bank[c.color] }))
          .sort((a, b) => b.bank - a.bank || (a.choice.color < b.choice.color ? -1 : 1));
        return byBank[0]!.choice;
      }

      const discards = legal.filter((c): c is Extract<SplendorChoice, { kind: 'discard' }> => c.kind === 'discard');
      if (discards.length > 0) {
        const gaps = target ? deficits(self, target) : null;
        const byNeed = discards
          .map((c) => ({ choice: c, need: c.gem === 'gold' ? 999 : gaps ? gaps[c.gem] : 0 }))
          .sort((a, b) => a.need - b.need || (a.choice.gem < b.choice.gem ? -1 : 1));
        return byNeed[0]!.choice;
      }

      const takeDoneFallback = legal.find((c) => c.kind === 'takeDone');
      if (takeDoneFallback) return takeDoneFallback;

      return legal[rng.nextInt(legal.length)] as SplendorChoice;
    },
  };
};

export { splendorMidBot };
