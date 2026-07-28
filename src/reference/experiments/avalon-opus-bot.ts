/**
 * avalon-opus-bot — a from-scratch heuristic Avalon bot designed in ONE pass
 * ("what would a strong, informed player do at each role?"), WITHOUT going
 * through Loop Forge's scoring/wave/gate machinery. This is the "just ask the
 * LLM to design a bot" arm of the benchmark experiment
 * (docs/BENCHMARK-EXPERIMENT.md, column A) — deliberately kept OUT of the
 * game adapter's strategySurface so it is never confused with a
 * pipeline-validated strategy.
 *
 * Layer: this file lives in `reference/experiments/` and imports only from
 * `contract`, `kernel`, and its sibling `../avalon` (types + `combinations`) —
 * the reference layer's allowed edges (src/__tests__/dependency-rules.test.ts).
 * All randomness flows through `createRng(seed)` (tie-breaking only); no
 * Date.now()/Math.random() (determinism rule).
 *
 * Design (single-shot heuristic per role, no lookahead search, no feedback
 * from any wave/gate — fixed after this one design pass):
 *
 *   - Merlin (good, sees both evil seats): always proposes/approves a team
 *     with zero known-evil members when one is legally available (there is
 *     always exactly one clean team of the full mission size, since the 3
 *     good seats are Merlin + 2 servants); rejects any team with 2 evil
 *     seats outright. A team with exactly 1 evil seat is normally rejected
 *     too, EXCEPT Merlin occasionally waves it through (fixed 30% chance,
 *     via the bot's own seeded RNG) while evil has not yet banked a mission
 *     failure — a low-risk window where a single infiltrator can still be
 *     absorbed without losing the game, used to avoid the "rejects with
 *     suspicious perfect accuracy" tell that gets Merlin assassinated (same
 *     motivating idea as the adapter's own `merlinCamouflage` strategy flag,
 *     reimplemented independently here since this bot must not depend on the
 *     pipeline's strategySurface).
 *
 *   - Minion / assassin (evil, see each other): as leader, proposes a team
 *     containing exactly one of {self, teammate} — never zero (no evil
 *     influence on the mission) and never both (two known-evil seats on one
 *     team is the most conspicuous signal a good player can see). Votes
 *     approve whenever the proposed team includes self or the teammate
 *     (to get an evil card onto the mission); otherwise votes on public
 *     information alone — reject once good already has 2 successful
 *     missions banked, to avoid handing over the decisive 3rd. Mission
 *     cards: always plays success through round index 1 (missions 1-2) to
 *     bank trust while the stakes are still low, then always plays fail from
 *     round index 2 onward OR immediately once good already has 2 successes
 *     banked (whichever comes first — the two conditions above `||` together
 *     so a forced 3rd-success situation is never let through even if it
 *     happens to land on an early round index).
 *
 *   - Loyal servant (good, no role information at all): the only signal
 *     available is public mission history. Tracks a per-seat "distrust"
 *     score = the number of already-failed missions that seat took part in.
 *     Proposes the team with the lowest total distrust among legal teams
 *     (ties broken by the seeded RNG); approves a proposed team unless its
 *     total distrust is nonzero, with one safety valve — once
 *     `roundRejections` reaches 4 (one more rejection ends the game in an
 *     immediate evil win via the 5-consecutive-rejections rule), it approves
 *     regardless, since losing outright is worse than seating one more
 *     distrusted player.
 *
 *   - Assassin's endgame guess (fires only once, after good's 3rd success):
 *     scores every good-aligned candidate (every legal target — the assassin
 *     already knows its own teammate is evil so never appears among legal
 *     targets) by 2x the number of times that candidate led an APPROVED
 *     proposal, plus 1x the number of times that candidate personally cast an
 *     approve vote across all completed proposals — a proxy for "who steered
 *     the group toward trusted teams most often, both as proposer and
 *     voter" — and targets the highest-scoring candidate (ties broken by the
 *     seeded RNG).
 *
 * Every decision is deterministic given the bot's seed; the RNG is used only
 * to break genuine ties and to drive Merlin's fixed-probability camouflage
 * roll — never to imitate lookahead or planning.
 */

import type { BotFactory, PlayerId } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type {
  AssassinateChoice,
  AvalonChoice,
  AvalonObservation,
  MissionCardChoice,
  MissionRecord,
  ProposeTeamChoice,
  VoteChoice,
} from '../avalon';

/** Merlin's fixed probability of waving through a team with exactly one
 * known-evil seat, while the risk of doing so is still low (see file header). */
const MERLIN_CAMOUFLAGE_RATE = 0.3;
/** Round index (0-based) from which evil always plays fail. */
const EVIL_FAIL_FROM_ROUND = 2;

type Rng = ReturnType<typeof createRng>;

function pickIndex<T>(pool: readonly T[], rng: Rng): T {
  return pool[rng.nextInt(pool.length)] as T;
}

function distrustScore(seat: PlayerId, missions: readonly MissionRecord[]): number {
  return missions.filter((m) => !m.success && m.team.includes(seat)).length;
}

function findVote(legal: readonly VoteChoice[], approve: boolean): VoteChoice {
  return legal.find((c) => c.approve === approve) ?? (legal[0] as VoteChoice);
}

// -----------------------------------------------------------------------
// proposeTeam
// -----------------------------------------------------------------------

function proposeClean(
  teams: readonly ProposeTeamChoice[],
  evilSeats: readonly PlayerId[],
  self: PlayerId,
  rng: Rng,
): ProposeTeamChoice {
  const clean = teams.filter((t) => !t.team.some((seat) => evilSeats.includes(seat)));
  const withSelf = clean.filter((t) => t.team.includes(self));
  const pool = withSelf.length > 0 ? withSelf : clean.length > 0 ? clean : teams;
  return pickIndex(pool, rng);
}

function proposeInfiltrated(
  teams: readonly ProposeTeamChoice[],
  self: PlayerId,
  teammate: PlayerId,
  rng: Rng,
): ProposeTeamChoice {
  const exactlyOneEvil = teams.filter((t) => {
    const hasSelf = t.team.includes(self);
    const hasTeammate = t.team.includes(teammate);
    return hasSelf !== hasTeammate;
  });
  const preferSelf = exactlyOneEvil.filter((t) => t.team.includes(self));
  const pool = preferSelf.length > 0 ? preferSelf : exactlyOneEvil.length > 0 ? exactlyOneEvil : teams;
  return pickIndex(pool, rng);
}

function proposeTrusted(
  teams: readonly ProposeTeamChoice[],
  missions: readonly MissionRecord[],
  rng: Rng,
): ProposeTeamChoice {
  let best: ProposeTeamChoice[] = [];
  let bestScore = Infinity;
  for (const t of teams) {
    const score = t.team.reduce((sum, seat) => sum + distrustScore(seat, missions), 0);
    if (score < bestScore) {
      bestScore = score;
      best = [t];
    } else if (score === bestScore) {
      best.push(t);
    }
  }
  return pickIndex(best, rng);
}

// -----------------------------------------------------------------------
// vote
// -----------------------------------------------------------------------

function merlinVote(observation: AvalonObservation, legal: readonly VoteChoice[], rng: Rng): VoteChoice {
  const team = observation.pendingTeam ?? [];
  const evilSeats = observation.evilSeats ?? [];
  const evilCount = team.filter((seat) => evilSeats.includes(seat)).length;
  const evilFails = observation.missions.filter((m) => !m.success).length;
  let approve: boolean;
  if (evilCount === 0) {
    approve = true;
  } else if (evilCount >= 2) {
    approve = false;
  } else {
    approve = evilFails === 0 && rng.next() < MERLIN_CAMOUFLAGE_RATE;
  }
  return findVote(legal, approve);
}

function evilVote(
  observation: AvalonObservation,
  legal: readonly VoteChoice[],
  self: PlayerId,
  teammate: PlayerId,
): VoteChoice {
  const team = observation.pendingTeam ?? [];
  const onTeam = team.includes(self) || team.includes(teammate);
  let approve: boolean;
  if (onTeam) {
    approve = true;
  } else {
    const goodSuccesses = observation.missions.filter((m) => m.success).length;
    approve = goodSuccesses < 2;
  }
  return findVote(legal, approve);
}

function servantVote(observation: AvalonObservation, legal: readonly VoteChoice[]): VoteChoice {
  const team = observation.pendingTeam ?? [];
  const totalDistrust = team.reduce((sum, seat) => sum + distrustScore(seat, observation.missions), 0);
  const approve = totalDistrust === 0 || observation.roundRejections >= 4;
  return findVote(legal, approve);
}

// -----------------------------------------------------------------------
// missionCard
// -----------------------------------------------------------------------

function decideMissionCard(
  observation: AvalonObservation,
  legal: readonly MissionCardChoice[],
): MissionCardChoice {
  if (legal.length === 1) {
    return legal[0] as MissionCardChoice; // good: success is the only legal choice
  }
  const goodSuccesses = observation.missions.filter((m) => m.success).length;
  const shouldFail = observation.round >= EVIL_FAIL_FROM_ROUND || goodSuccesses >= 2;
  const wanted = legal.find((c) => c.success !== shouldFail);
  return wanted ?? (legal[0] as MissionCardChoice);
}

// -----------------------------------------------------------------------
// assassinate
// -----------------------------------------------------------------------

function decideAssassinate(
  observation: AvalonObservation,
  legal: readonly AssassinateChoice[],
  rng: Rng,
): AssassinateChoice {
  const scores = new Map<PlayerId, number>();
  for (const choice of legal) scores.set(choice.target, 0);
  for (const proposal of observation.proposals) {
    if (!scores.has(proposal.leader)) continue;
    if (proposal.approved) {
      scores.set(proposal.leader, (scores.get(proposal.leader) ?? 0) + 2);
    }
  }
  for (const proposal of observation.proposals) {
    for (const target of scores.keys()) {
      if (proposal.votes[target] === true) {
        scores.set(target, (scores.get(target) ?? 0) + 1);
      }
    }
  }
  let best: AssassinateChoice[] = [];
  let bestScore = -Infinity;
  for (const choice of legal) {
    const score = scores.get(choice.target) ?? 0;
    if (score > bestScore) {
      bestScore = score;
      best = [choice];
    } else if (score === bestScore) {
      best.push(choice);
    }
  }
  return pickIndex(best, rng);
}

// -----------------------------------------------------------------------
// bot
// -----------------------------------------------------------------------

export const avalonOpusBot: BotFactory<AvalonObservation, AvalonChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'avalon-opus',
    decide(decisionPoint, observation, legal) {
      switch (decisionPoint) {
        case 'proposeTeam': {
          const teams = legal as ProposeTeamChoice[];
          if (observation.evilSeats !== undefined) {
            return proposeClean(teams, observation.evilSeats, observation.self, rng);
          }
          if (observation.evilTeammates !== undefined && observation.evilTeammates.length > 0) {
            const teammate = observation.evilTeammates[0]?.seat as PlayerId;
            return proposeInfiltrated(teams, observation.self, teammate, rng);
          }
          return proposeTrusted(teams, observation.missions, rng);
        }
        case 'vote': {
          const legalVotes = legal as VoteChoice[];
          if (observation.evilSeats !== undefined) {
            return merlinVote(observation, legalVotes, rng);
          }
          if (observation.evilTeammates !== undefined && observation.evilTeammates.length > 0) {
            const teammate = observation.evilTeammates[0]?.seat as PlayerId;
            return evilVote(observation, legalVotes, observation.self, teammate);
          }
          return servantVote(observation, legalVotes);
        }
        case 'missionCard':
          return decideMissionCard(observation, legal as MissionCardChoice[]);
        case 'assassinate':
          return decideAssassinate(observation, legal as AssassinateChoice[], rng);
        default:
          throw new Error(`avalon-opus: unknown decision point ${decisionPoint}`);
      }
    },
  };
};
