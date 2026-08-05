/**
 * avalon — reference GameAdapter implementation (headless onboarding of "The
 * Resistance: Avalon", 5-player base role set only — Merlin, 2x loyal
 * servants of Arthur, Mordred's minion, the assassin; Percival/Morgana/
 * Mordred(-the-role)/Oberon and other expansion roles are explicitly out of
 * scope for this onboarding).
 *
 * Structural reference: AlexLomm/avalon-engine (MIT license,
 * github.com/AlexLomm/avalon-engine) was consulted for how a headless engine
 * for this game is typically shaped (phase machine, proposal/vote/mission
 * cycle) — no code from that project was copied; the rules below are
 * reimplemented from scratch against the publicly standardized "The
 * Resistance: Avalon" rules. See docs/CREDITS.md.
 *
 * Rules (5-player base set):
 *   - 5 players, roles dealt once per game: 1 Merlin (good, sees all evil),
 *     2 loyal servants (good, no information), 1 Mordred's minion (evil,
 *     sees the other evil player), 1 assassin (evil, sees the other evil
 *     player, and gets one endgame guess at Merlin's identity).
 *   - 5 missions in sequence. Mission team sizes for 5 players:
 *     [2, 3, 2, 3, 3]. Every mission needs only 1 fail card to fail it
 *     (5-player rule — mission 4 is not a 2-fails-required mission the way
 *     it is at higher player counts).
 *   - Each mission: the current leader proposes a team of the required size;
 *     all 5 players vote approve/reject (modeled as hidden-sequential — see
 *     below); a strict majority (>2, since 5 is odd — no ties are possible)
 *     approves. If approved, the proposed team members each secretly submit
 *     a success/fail card (only evil players may submit fail); the mission
 *     succeeds iff fewer fail cards were submitted than the round's fail
 *     threshold (1, for every round in this player count). If rejected,
 *     leadership passes to the next seat and a rejection counter increments;
 *     5 consecutive rejections (which, by construction, can only happen
 *     within a single mission round, since a round only advances past an
 *     approval) end the game in an immediate evil win.
 *   - Good wins by completing 3 successful missions AND the assassin then
 *     failing to identify Merlin. Evil wins immediately upon 3 failed
 *     missions, OR upon the 5-consecutive-rejection game-ending rule, OR by
 *     the assassin correctly naming Merlin after good's 3rd success.
 *   - Claims/discussion are out of scope (ONBOARDING-GUIDE.md §"F4": no
 *     structured claim decision point in this pass — a future extension
 *     point, not implemented here).
 *
 * Hidden-sequential vote/mission modeling (F1 pattern, ONBOARDING-GUIDE.md
 * §7 "동시 행동 게임"): real Avalon votes and mission cards are simultaneous
 * and secret. This adapter represents both as a sequence of per-seat
 * decisions (seat order 0..4) whose legal-choice space never depends on
 * what any other seat already chose this round (both are always exactly
 * [approve, reject] / role-gated [success] or [success, fail]), and whose
 * `getObservation` never exposes another seat's in-progress vote or mission
 * card — only the fully-tallied, already-public result (aggregate vote
 * record with each seat's revealed vote for `vote`; only the fail *count*,
 * never who played it, for `missionCard`). That combination makes the
 * sequential encoding behaviorally equivalent to simultaneous secret voting.
 *
 * Hidden faction (ONBOARDING-GUIDE.md §7 "숨은 진영 게임", GAP-ANALYSIS-10.md
 * M1, GAP-ANALYSIS-3.md F4): `spec.teams` is reserved for fixed, PUBLIC team
 * partitions and must stay unset here, since faction membership is secret
 * during play. `spec.hiddenTeamStructure: true` is declared instead —
 * `Outcome.winners` carries every member of the winning faction, which is
 * what the win-rate machinery actually keys off, and `scoreMargin: 'none'`
 * applies (this is also a win/loss-only game per ONBOARDING-GUIDE.md §7
 * "승/패 전용 게임" — scores are the 1/0 win-rate re-expression gomoku uses,
 * not a real margin).
 *
 * Role assignment: `createInitialState(seed)` deterministically shuffles the
 * 5-role bag onto seats 0..4 and picks a random starting leader from the
 * same seed — per M1's premise, this means `spec.seatingPlan`'s seat
 * rotation (candidate seat 0 walking every seat across the plan) also walks
 * the candidate bot through every role, so paired-seat statistics aren't
 * silently pinned to one fixed role for the candidate the way an
 * always-seat-0-is-Merlin scheme would be.
 *
 * All randomness flows through `createRng`/`Rng` from ../kernel/rng — no
 * Date.now()/Math.random() anywhere in this file (C1 determinism rule).
 */

import type {
  BotFactory,
  GameAdapter,
  HiddenInfoProbe,
  Outcome,
  PendingDecision,
  PlayerId,
  ReplayFixture,
  StrategyFlagSpec,
} from '../contract/types';
import { createRng, shuffled } from '../kernel/rng';

export type Role = 'merlin' | 'servant' | 'minion' | 'assassin';

const ROLE_BAG: readonly Role[] = ['merlin', 'servant', 'servant', 'minion', 'assassin'];
const EVIL_ROLES: readonly Role[] = ['minion', 'assassin'];
const GOOD_ROLES: readonly Role[] = ['merlin', 'servant'];
const PLAYER_COUNT = 5;
const ALL_SEATS: readonly PlayerId[] = [0, 1, 2, 3, 4];

/** Mission team sizes by round index (0-based), 5-player rules. */
export const MISSION_TEAM_SIZES: readonly number[] = [2, 3, 2, 3, 3];
/** Fail cards required to fail each mission, 5-player rules (all rounds: 1). */
export const FAILS_REQUIRED: readonly number[] = [1, 1, 1, 1, 1];

export type Phase = 'propose' | 'vote' | 'mission' | 'assassinate' | 'done';

export interface ProposalRecord {
  readonly leader: PlayerId;
  readonly team: readonly PlayerId[];
  /** Revealed vote per seat, indexed by PlayerId — public once tallied. */
  readonly votes: readonly boolean[];
  readonly approved: boolean;
}

export interface MissionRecord {
  readonly team: readonly PlayerId[];
  /** Public: how many fail cards were played. Who played them stays secret forever. */
  readonly failCount: number;
  readonly success: boolean;
}

export interface AvalonState {
  /** roles[seat] = that seat's role. Length 5, indexed by PlayerId. */
  readonly roles: readonly Role[];
  readonly round: number;
  readonly leader: PlayerId;
  readonly phase: Phase;
  /** Consecutive rejections in the current round (resets to 0 on approval / new round). */
  readonly roundRejections: number;
  readonly pendingTeam: readonly PlayerId[] | null;
  /** null = that seat has not voted yet this round. */
  readonly pendingVotes: readonly (boolean | null)[];
  /** null = that seat has not submitted a mission card yet (only meaningful for pendingTeam seats). */
  readonly pendingMissionCards: readonly (boolean | null)[];
  readonly proposals: readonly ProposalRecord[];
  readonly missions: readonly MissionRecord[];
  readonly winner: 'good' | 'evil' | null;
  readonly assassinTarget: PlayerId | null;
}

export interface AvalonObservation {
  readonly self: PlayerId;
  readonly role: Role;
  /** Present only when self is Merlin: both evil seats, undifferentiated (Merlin does not learn which is the assassin). */
  readonly evilSeats?: readonly PlayerId[];
  /** Present only when self is evil: the other evil seat, with its exact role. */
  readonly evilTeammates?: ReadonlyArray<{ readonly seat: PlayerId; readonly role: 'minion' | 'assassin' }>;
  readonly round: number;
  readonly leader: PlayerId;
  readonly phase: Phase;
  readonly roundRejections: number;
  readonly pendingTeam: readonly PlayerId[] | null;
  readonly proposals: readonly ProposalRecord[];
  readonly missions: readonly MissionRecord[];
  readonly winner: 'good' | 'evil' | null;
  readonly assassinTarget: PlayerId | null;
}

export interface ProposeTeamChoice {
  readonly kind: 'proposeTeam';
  readonly team: readonly PlayerId[];
}
export interface VoteChoice {
  readonly kind: 'vote';
  readonly approve: boolean;
}
export interface MissionCardChoice {
  readonly kind: 'missionCard';
  readonly success: boolean;
}
export interface AssassinateChoice {
  readonly kind: 'assassinate';
  readonly target: PlayerId;
}
export type AvalonChoice = ProposeTeamChoice | VoteChoice | MissionCardChoice | AssassinateChoice;

const EMPTY_SLOTS: readonly (boolean | null)[] = [null, null, null, null, null];

function seatsWithRole(roles: readonly Role[], targetRoles: readonly Role[]): PlayerId[] {
  const seats: PlayerId[] = [];
  roles.forEach((role, seat) => {
    if (targetRoles.includes(role)) seats.push(seat as PlayerId);
  });
  return seats;
}

function combinations(seats: readonly PlayerId[], size: number): PlayerId[][] {
  const result: PlayerId[][] = [];
  const current: PlayerId[] = [];
  function backtrack(start: number): void {
    if (current.length === size) {
      result.push([...current]);
      return;
    }
    for (let i = start; i < seats.length; i += 1) {
      current.push(seats[i] as PlayerId);
      backtrack(i + 1);
      current.pop();
    }
  }
  backtrack(0);
  return result;
}

function createInitialState(seed: number): AvalonState {
  const rng = createRng(seed);
  const roles = shuffled(ROLE_BAG, rng);
  const leader = rng.nextInt(PLAYER_COUNT) as PlayerId;
  return {
    roles,
    round: 0,
    leader,
    phase: 'propose',
    roundRejections: 0,
    pendingTeam: null,
    pendingVotes: EMPTY_SLOTS,
    pendingMissionCards: EMPTY_SLOTS,
    proposals: [],
    missions: [],
    winner: null,
    assassinTarget: null,
  };
}

function currentDecision(state: AvalonState): PendingDecision | null {
  if (state.winner !== null) return null;
  switch (state.phase) {
    case 'propose':
      return { player: state.leader, decisionPoint: 'proposeTeam' };
    case 'vote': {
      const idx = state.pendingVotes.findIndex((v) => v === null);
      if (idx === -1) {
        throw new Error('currentDecision: vote phase with no pending voter (tally was not applied)');
      }
      return { player: idx as PlayerId, decisionPoint: 'vote' };
    }
    case 'mission': {
      const team = state.pendingTeam;
      if (team === null) {
        throw new Error('currentDecision: mission phase with no pending team');
      }
      const next = team.find((seat) => state.pendingMissionCards[seat] === null);
      if (next === undefined) {
        throw new Error('currentDecision: mission phase with no pending team member (tally was not applied)');
      }
      return { player: next, decisionPoint: 'missionCard' };
    }
    case 'assassinate': {
      const assassin = state.roles.indexOf('assassin') as PlayerId;
      return { player: assassin, decisionPoint: 'assassinate' };
    }
    case 'done':
      return null;
  }
}

function getObservation(state: AvalonState, player: PlayerId): AvalonObservation {
  const role = state.roles[player] as Role;
  const base: AvalonObservation = {
    self: player,
    role,
    round: state.round,
    leader: state.leader,
    phase: state.phase,
    roundRejections: state.roundRejections,
    pendingTeam: state.pendingTeam,
    proposals: state.proposals,
    missions: state.missions,
    winner: state.winner,
    assassinTarget: state.assassinTarget,
  };
  if (role === 'merlin') {
    return { ...base, evilSeats: seatsWithRole(state.roles, EVIL_ROLES) };
  }
  if (role === 'minion' || role === 'assassin') {
    const teammates = seatsWithRole(state.roles, EVIL_ROLES)
      .filter((seat) => seat !== player)
      .map((seat) => ({ seat, role: state.roles[seat] as 'minion' | 'assassin' }));
    return { ...base, evilTeammates: teammates };
  }
  return base;
}

function legalTeams(state: AvalonState): ProposeTeamChoice[] {
  const size = MISSION_TEAM_SIZES[state.round] as number;
  return combinations(ALL_SEATS, size).map((team) => ({ kind: 'proposeTeam', team }));
}

function getLegalChoices(state: AvalonState): readonly AvalonChoice[] {
  const decision = currentDecision(state);
  if (decision === null) {
    throw new Error('getLegalChoices: game is already over');
  }
  switch (decision.decisionPoint) {
    case 'proposeTeam':
      return legalTeams(state);
    case 'vote':
      return [
        { kind: 'vote', approve: true },
        { kind: 'vote', approve: false },
      ];
    case 'missionCard': {
      const role = state.roles[decision.player] as Role;
      if (EVIL_ROLES.includes(role)) {
        return [
          { kind: 'missionCard', success: true },
          { kind: 'missionCard', success: false },
        ];
      }
      return [{ kind: 'missionCard', success: true }];
    }
    case 'assassinate': {
      const goodSeats = seatsWithRole(state.roles, GOOD_ROLES);
      return goodSeats.map((target) => ({ kind: 'assassinate', target }));
    }
    default:
      throw new Error(`getLegalChoices: unknown decision point ${decision.decisionPoint}`);
  }
}

function encodeChoice(choice: AvalonChoice): string {
  switch (choice.kind) {
    case 'proposeTeam':
      return `propose:${[...choice.team].sort((a, b) => a - b).join(',')}`;
    case 'vote':
      return `vote:${choice.approve}`;
    case 'missionCard':
      return `mission:${choice.success}`;
    case 'assassinate':
      return `assassinate:${choice.target}`;
  }
}

function applyProposeTeam(state: AvalonState, team: readonly PlayerId[]): AvalonState {
  return {
    ...state,
    phase: 'vote',
    pendingTeam: [...team].sort((a, b) => a - b),
    pendingVotes: EMPTY_SLOTS,
  };
}

function applyVote(state: AvalonState, player: PlayerId, approve: boolean): AvalonState {
  const pendingVotes = state.pendingVotes.slice();
  pendingVotes[player] = approve;
  if (pendingVotes.some((v) => v === null)) {
    return { ...state, pendingVotes };
  }
  const votes = pendingVotes as boolean[];
  const approveCount = votes.filter((v) => v).length;
  const approved = approveCount > votes.length / 2;
  const team = state.pendingTeam;
  if (team === null) {
    throw new Error('applyVote: tally with no pending team');
  }
  const proposal: ProposalRecord = { leader: state.leader, team, votes, approved };
  const proposals = [...state.proposals, proposal];
  if (approved) {
    return {
      ...state,
      proposals,
      roundRejections: 0,
      phase: 'mission',
      pendingVotes: EMPTY_SLOTS,
      pendingMissionCards: EMPTY_SLOTS,
    };
  }
  const roundRejections = state.roundRejections + 1;
  if (roundRejections >= 5) {
    return {
      ...state,
      proposals,
      roundRejections,
      phase: 'done',
      winner: 'evil',
      pendingTeam: null,
      pendingVotes: EMPTY_SLOTS,
    };
  }
  const nextLeader = ((state.leader + 1) % PLAYER_COUNT) as PlayerId;
  return {
    ...state,
    proposals,
    roundRejections,
    leader: nextLeader,
    phase: 'propose',
    pendingTeam: null,
    pendingVotes: EMPTY_SLOTS,
  };
}

function applyMissionCard(state: AvalonState, player: PlayerId, success: boolean): AvalonState {
  const team = state.pendingTeam;
  if (team === null) {
    throw new Error('applyMissionCard: no pending team');
  }
  const pendingMissionCards = state.pendingMissionCards.slice();
  pendingMissionCards[player] = success;
  if (team.some((seat) => pendingMissionCards[seat] === null)) {
    return { ...state, pendingMissionCards };
  }
  const failCount = team.filter((seat) => pendingMissionCards[seat] === false).length;
  const missionSuccess = failCount < (FAILS_REQUIRED[state.round] as number);
  const missions = [...state.missions, { team, failCount, success: missionSuccess }];
  const evilFails = missions.filter((m) => !m.success).length;
  const goodSuccesses = missions.filter((m) => m.success).length;

  if (evilFails >= 3) {
    return {
      ...state,
      missions,
      phase: 'done',
      winner: 'evil',
      pendingTeam: null,
      pendingMissionCards: EMPTY_SLOTS,
    };
  }
  if (goodSuccesses >= 3) {
    return {
      ...state,
      missions,
      phase: 'assassinate',
      pendingTeam: null,
      pendingMissionCards: EMPTY_SLOTS,
    };
  }
  const nextLeader = ((state.leader + 1) % PLAYER_COUNT) as PlayerId;
  return {
    ...state,
    missions,
    round: state.round + 1,
    leader: nextLeader,
    phase: 'propose',
    roundRejections: 0,
    pendingTeam: null,
    pendingMissionCards: EMPTY_SLOTS,
  };
}

function applyAssassinate(state: AvalonState, target: PlayerId): AvalonState {
  const merlinSeat = state.roles.indexOf('merlin') as PlayerId;
  const winner: 'good' | 'evil' = target === merlinSeat ? 'evil' : 'good';
  return { ...state, phase: 'done', winner, assassinTarget: target };
}

function applyChoice(state: AvalonState, choice: AvalonChoice): AvalonState {
  const decision = currentDecision(state);
  if (decision === null) {
    throw new Error('applyChoice: game is already over');
  }
  const legal = getLegalChoices(state);
  const key = encodeChoice(choice);
  if (!legal.some((candidate) => encodeChoice(candidate) === key)) {
    throw new Error(`applyChoice: choice ${key} is not among the legal choices at this decision`);
  }
  switch (choice.kind) {
    case 'proposeTeam':
      return applyProposeTeam(state, choice.team);
    case 'vote':
      return applyVote(state, decision.player, choice.approve);
    case 'missionCard':
      return applyMissionCard(state, decision.player, choice.success);
    case 'assassinate':
      return applyAssassinate(state, choice.target);
  }
}

function getOutcome(state: AvalonState): Outcome | null {
  if (state.winner === null) return null;
  const winningRoles = state.winner === 'good' ? GOOD_ROLES : EVIL_ROLES;
  const winners = seatsWithRole(state.roles, winningRoles);
  const scores = ALL_SEATS.map((seat) => (winners.includes(seat) ? 1 : 0));
  return { scores, winners };
}

// -----------------------------------------------------------------------
// Invariants
// -----------------------------------------------------------------------

function roleCompositionInvariant(state: AvalonState): string | null {
  if (state.roles.length !== PLAYER_COUNT) {
    return `roles array has ${state.roles.length} entries, expected ${PLAYER_COUNT}`;
  }
  const evilCount = state.roles.filter((role) => EVIL_ROLES.includes(role)).length;
  if (evilCount !== 2) {
    return `evil faction has ${evilCount} members, expected exactly 2`;
  }
  const counts = new Map<Role, number>();
  for (const role of state.roles) {
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  if (counts.get('merlin') !== 1 || counts.get('minion') !== 1 || counts.get('assassin') !== 1 || counts.get('servant') !== 2) {
    return `role composition mismatch: ${JSON.stringify(Object.fromEntries(counts))}`;
  }
  return null;
}

function outcomeConsistencyInvariant(state: AvalonState): string | null {
  if (state.winner === null) return null;
  const winningRoles = state.winner === 'good' ? GOOD_ROLES : EVIL_ROLES;
  const expectedWinners = new Set(seatsWithRole(state.roles, winningRoles));
  const outcome = getOutcome(state);
  if (outcome === null) {
    return 'winner is set but getOutcome returned null';
  }
  if (outcome.winners.length !== expectedWinners.size || outcome.winners.some((seat) => !expectedWinners.has(seat))) {
    return `outcome winners [${outcome.winners.join(',')}] do not match the ${state.winner} faction's seats`;
  }
  if (state.missions.filter((m) => !m.success).length >= 3 && state.winner !== 'evil') {
    return '3 failed missions occurred but winner is not evil';
  }
  return null;
}

// -----------------------------------------------------------------------
// Hidden information probe (C3)
// -----------------------------------------------------------------------

function rotateArray<T>(items: readonly T[], shift: number): T[] {
  const length = items.length;
  return items.map((_, i) => items[(i + shift) % length] as T);
}

const avalonHiddenInfoProbe: HiddenInfoProbe<AvalonState> = {
  mutateHidden(state, viewer, rng) {
    const role = state.roles[viewer] as Role;
    if (role === 'merlin') {
      const [a, b] = seatsWithRole(state.roles, EVIL_ROLES);
      if (a === undefined || b === undefined) return null;
      const newRoles = state.roles.slice();
      const roleA = newRoles[a] as Role;
      const roleB = newRoles[b] as Role;
      newRoles[a] = roleB;
      newRoles[b] = roleA;
      return { ...state, roles: newRoles };
    }
    if (role === 'minion' || role === 'assassin') {
      const goodSeats = seatsWithRole(state.roles, GOOD_ROLES); // merlin + 2 servants
      const shift = 1 + rng.nextInt(goodSeats.length - 1);
      const rotatedRoles = rotateArray(
        goodSeats.map((seat) => state.roles[seat] as Role),
        shift,
      );
      const newRoles = state.roles.slice();
      goodSeats.forEach((seat, i) => {
        newRoles[seat] = rotatedRoles[i] as Role;
      });
      return { ...state, roles: newRoles };
    }
    // servant: the other 4 seats are exactly {merlin, servant, minion, assassin} —
    // all distinct, so any nonzero rotation is guaranteed to differ.
    const otherSeats = ALL_SEATS.filter((seat) => seat !== viewer);
    const shift = 1 + rng.nextInt(otherSeats.length - 1);
    const rotatedRoles = rotateArray(
      otherSeats.map((seat) => state.roles[seat] as Role),
      shift,
    );
    const newRoles = state.roles.slice();
    otherSeats.forEach((seat, i) => {
      newRoles[seat] = rotatedRoles[i] as Role;
    });
    return { ...state, roles: newRoles };
  },
};

// -----------------------------------------------------------------------
// Baselines
// -----------------------------------------------------------------------

const randomBaseline: BotFactory<AvalonObservation, AvalonChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'avalon-random',
    decide(_decisionPoint, _observation, legal) {
      return legal[rng.nextInt(legal.length)] as AvalonChoice;
    },
  };
};

function teamStartingAt(leader: PlayerId, size: number): PlayerId[] {
  const team: PlayerId[] = [];
  for (let i = 0; i < size; i += 1) {
    team.push(((leader + i) % PLAYER_COUNT) as PlayerId);
  }
  return team.sort((a, b) => a - b);
}

/** True iff `team` contains at least one seat from `seats`. */
function teamIntersects(team: readonly PlayerId[], seats: readonly PlayerId[]): boolean {
  return team.some((seat) => seats.includes(seat));
}

/**
 * Heuristic baseline: minimal common-sense play that actually uses each
 * role's information, not meant to be strong. This deliberately does more
 * than "always approve / sometimes fail" (an earlier draft did exactly that
 * and turned out statistically indistinguishable from the random baseline —
 * G-Score's C5 axis caught it, docs/ONBOARDING-GUIDE.md §3's iterate-on-the-
 * adapter loop in action) — informed voting is what actually separates
 * heuristic play from uniform random here:
 *   - Merlin: proposes/approves teams that avoid every known-evil seat when
 *     a legal option allows it; rejects any team containing a known-evil
 *     seat otherwise.
 *   - Minion/Assassin: proposes/approves teams that include themselves or
 *     their evil teammate (to get an evil card onto the mission); rejects
 *     teams that don't. Always plays fail when on a mission (evil's whole
 *     point is failing missions — a 50/50 mixed strategy diluted this into
 *     near-random noise).
 *   - Loyal servant (no information): proposes the next `size` seats
 *     starting from the leader, and approves every team — the best a fully
 *     uninformed player can do without inventing information they don't have.
 *   - Assassinate: no informed signal is tracked for this baseline (that is
 *     what strategySurface's assassinTargetMostTrusted adds); picks
 *     uniformly via the bot's own seeded RNG.
 * All decisions are deterministic given the bot's seed (only assassinate
 * uses the seeded RNG at all) per the C1 determinism rule.
 */
const heuristicBaseline: BotFactory<AvalonObservation, AvalonChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'avalon-heuristic',
    decide(decisionPoint, observation, legal) {
      switch (decisionPoint) {
        case 'proposeTeam': {
          const teams = legal as ProposeTeamChoice[];
          if (observation.evilSeats !== undefined) {
            const clean = teams.find((c) => !teamIntersects(c.team, observation.evilSeats as readonly PlayerId[]));
            if (clean) return clean;
          }
          if (observation.evilTeammates !== undefined) {
            const selfAndTeammates = [observation.self, ...observation.evilTeammates.map((t) => t.seat)];
            const infiltrated = teams.find((c) => teamIntersects(c.team, selfAndTeammates));
            if (infiltrated) return infiltrated;
          }
          const size = (teams[0] as ProposeTeamChoice).team.length;
          const desired = teamStartingAt(observation.leader, size);
          const key = encodeChoice({ kind: 'proposeTeam', team: desired });
          const match = teams.find((c) => encodeChoice(c) === key);
          return match ?? (teams[0] as AvalonChoice);
        }
        case 'vote': {
          const team = observation.pendingTeam ?? [];
          let approve = true;
          if (observation.evilSeats !== undefined) {
            approve = !teamIntersects(team, observation.evilSeats);
          } else if (observation.evilTeammates !== undefined) {
            const selfAndTeammates = [observation.self, ...observation.evilTeammates.map((t) => t.seat)];
            approve = teamIntersects(team, selfAndTeammates);
          }
          const choice = (legal as VoteChoice[]).find((c) => c.approve === approve);
          return choice ?? (legal[0] as AvalonChoice);
        }
        case 'missionCard': {
          if (legal.length === 1) {
            return legal[0] as AvalonChoice; // good: success is the only legal choice
          }
          const fail = (legal as MissionCardChoice[]).find((c) => !c.success);
          return fail ?? (legal[0] as AvalonChoice);
        }
        case 'assassinate': {
          return legal[rng.nextInt(legal.length)] as AvalonChoice;
        }
        default:
          throw new Error(`avalon-heuristic: unknown decision point ${decisionPoint}`);
      }
    },
  };
};

// -----------------------------------------------------------------------
// Strategy surface
// -----------------------------------------------------------------------

function wrapBotId(id: string, suffix: string): string {
  return `${id}+${suffix}`;
}

/** Strategy flag: marginal. Merlin occasionally approves a team containing
 * exactly one known-evil member (50% of such cases, decided by the bot's own
 * seeded RNG) instead of always rejecting on sight, so as to not play with
 * suspicious perfect accuracy; delegates to base for everything else. */
const merlinCamouflage: StrategyFlagSpec<AvalonObservation, AvalonChoice> = {
  flag: 'merlinCamouflage',
  description:
    "Merlin approves teams with exactly one known-evil member about half the time instead of always rejecting them, to avoid revealing perfect certainty.",
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      const rng = createRng(seed).fork('merlinCamouflage');
      return {
        id: wrapBotId(bot.id, 'merlinCamouflage'),
        decide(decisionPoint, observation, legal) {
          if (
            decisionPoint === 'vote' &&
            observation.role === 'merlin' &&
            observation.evilSeats !== undefined &&
            observation.pendingTeam !== null
          ) {
            const evilOnTeam = observation.pendingTeam.filter((seat) =>
              (observation.evilSeats as readonly PlayerId[]).includes(seat),
            ).length;
            if (evilOnTeam === 1 && rng.next() < 0.5) {
              const approve = (legal as VoteChoice[]).find((c) => c.approve);
              if (approve) return approve;
            }
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/** Strategy flag: effective. Evil players always play success on the first
 * mission (round 0) regardless of what the base bot would have chosen, to
 * build trust before starting to fail missions; delegates to base from round
 * 1 onward and for every other decision. */
const evilDelayedFail: StrategyFlagSpec<AvalonObservation, AvalonChoice> = {
  flag: 'evilDelayedFail',
  description:
    'Evil players always play success on mission 1 to build trust, delegating to the base bot from mission 2 onward.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot.id, 'evilDelayedFail'),
        decide(decisionPoint, observation, legal) {
          if (decisionPoint === 'missionCard' && observation.round === 0 && legal.length > 1) {
            const success = (legal as MissionCardChoice[]).find((c) => c.success);
            if (success) return success;
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/** Strategy flag: effective. The assassin targets whichever good-aligned
 * candidate voted 'approve' most often across all completed proposals (a
 * proxy for "who has been steering the group toward trusted teams"), instead
 * of the base bot's endgame guess; delegates to base for every other
 * decision. */
const assassinTargetMostTrusted: StrategyFlagSpec<AvalonObservation, AvalonChoice> = {
  flag: 'assassinTargetMostTrusted',
  description:
    "Assassin targets the good-aligned candidate with the highest 'approve' vote count across completed proposals, instead of the base bot's endgame guess.",
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot.id, 'assassinTargetMostTrusted'),
        decide(decisionPoint, observation, legal) {
          if (decisionPoint === 'assassinate' && legal.length > 0) {
            const approveCounts = new Map<PlayerId, number>();
            for (const choice of legal as AssassinateChoice[]) {
              approveCounts.set(choice.target, 0);
            }
            for (const proposal of observation.proposals) {
              for (const target of approveCounts.keys()) {
                if (proposal.votes[target] === true) {
                  approveCounts.set(target, (approveCounts.get(target) ?? 0) + 1);
                }
              }
            }
            let best: AssassinateChoice | null = null;
            let bestCount = -1;
            for (const choice of legal as AssassinateChoice[]) {
              const count = approveCounts.get(choice.target) ?? 0;
              if (count > bestCount) {
                bestCount = count;
                best = choice;
              }
            }
            if (best) return best;
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/**
 * Per-seat suspicion score, recomputed fresh from `observation.proposals` /
 * `observation.missions` on every call (A8 domain redesign card — GAP-12
 * §7). Unlike the other three strategySurface flags (each a single-decision
 * override), this accumulates a Bayesian-flavored signal across the whole
 * game's public history and uses it at two decision points.
 *
 * Investigation note (per the design brief): `AvalonObservation` already
 * carries the full public history needed here — `proposals` includes every
 * resolved proposal (approved or rejected) with each seat's revealed vote,
 * and `missions` includes each resolved mission's team and success/fail
 * outcome (see the type's field comments above). Because an approved
 * proposal always transitions straight to its mission with no other
 * proposal in between, `proposals.filter(p => p.approved)` zips 1:1, in
 * order, with `missions`. So this is a pure function of the observation
 * already handed to `decide` at each call — no bot-closure state needed;
 * the "reconstruct from decide() call sequence" fallback the brief
 * anticipated turned out to be unnecessary.
 *
 * Score update per resolved (approved proposal, mission) pair, for every
 * seat:
 *   - voted approve on that proposal: mission failed -> +2.0, succeeded -> -0.5
 *   - voted reject on that proposal (i.e. in the minority, since the
 *     proposal still passed): mission succeeded -> +0.5 (weak reverse
 *     signal for having doubted a good team), mission failed -> +0 (the
 *     doubt was justified, no penalty)
 *   - was on the mission team: mission failed -> additional +1.5
 * Starts at 0, unclamped (only relative comparisons are used).
 */
function computeSuspicionScores(observation: AvalonObservation): number[] {
  const scores = [0, 0, 0, 0, 0];
  const approvedProposals = observation.proposals.filter((p) => p.approved);
  approvedProposals.forEach((proposal, i) => {
    const mission = observation.missions[i];
    if (mission === undefined) return;
    for (const seat of ALL_SEATS) {
      const votedApprove = proposal.votes[seat] === true;
      const current = scores[seat] as number;
      if (votedApprove) {
        scores[seat] = current + (mission.success ? -0.5 : 2.0);
      } else if (mission.success) {
        scores[seat] = current + 0.5;
      }
      if (mission.team.includes(seat) && !mission.success) {
        scores[seat] = (scores[seat] as number) + 1.5;
      }
    }
  });
  return scores;
}

/** True for the two good-aligned roles this flag applies to (merlin, servant). */
function isGoodRole(role: Role): boolean {
  return role === 'merlin' || role === 'servant';
}

/** Strategy flag: effective (GAP-12 §7 A8 card). Good-aligned players (merlin,
 * servant) track a per-seat suspicion score derived from the public
 * proposal-vote/mission-outcome history (see computeSuspicionScores above)
 * and use it at two decision points — evil already knows who's evil, so
 * this flag is a no-op for evil roles (delegates straight to base):
 *   - proposeTeam: when leading, includes self plus the lowest-suspicion
 *     other seats needed to fill the team; if the seats at the selection
 *     boundary are tied on score, delegates to base instead of guessing.
 *   - vote: rejects the proposed team when its suspicion-score sum exceeds
 *     1.5x the game-wide average suspicion times the team size; otherwise
 *     delegates to base. */
const avalonSuspicionTracking: StrategyFlagSpec<AvalonObservation, AvalonChoice> = {
  flag: 'avalonSuspicionTracking',
  description:
    'Good-aligned players (merlin, servant) track a per-seat suspicion score from public vote/mission history and use it to pick low-suspicion teams when leading and to reject high-suspicion proposed teams when voting; no-op for evil roles.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot.id, 'avalonSuspicionTracking'),
        decide(decisionPoint, observation, legal) {
          if (isGoodRole(observation.role)) {
            if (decisionPoint === 'proposeTeam') {
              const teams = legal as ProposeTeamChoice[];
              const size = (teams[0] as ProposeTeamChoice).team.length;
              const neededOthers = size - 1;
              const scores = computeSuspicionScores(observation);
              const others = ALL_SEATS.filter((seat) => seat !== observation.self).sort(
                (a, b) => (scores[a] as number) - (scores[b] as number),
              );
              if (neededOthers >= 0 && neededOthers <= others.length) {
                const boundaryScore = neededOthers > 0 ? scores[others[neededOthers - 1] as PlayerId] : undefined;
                const nextScore = neededOthers < others.length ? scores[others[neededOthers] as PlayerId] : undefined;
                const tied = boundaryScore !== undefined && nextScore !== undefined && boundaryScore === nextScore;
                if (!tied) {
                  const selected = [observation.self, ...others.slice(0, neededOthers)].sort((a, b) => a - b);
                  const key = encodeChoice({ kind: 'proposeTeam', team: selected });
                  const match = teams.find((c) => encodeChoice(c) === key);
                  if (match) return match;
                }
              }
            } else if (decisionPoint === 'vote' && observation.pendingTeam !== null) {
              const team = observation.pendingTeam;
              const scores = computeSuspicionScores(observation);
              const avg = scores.reduce((sum, s) => sum + s, 0) / ALL_SEATS.length;
              const teamSum = team.reduce((sum, seat) => sum + (scores[seat] as number), 0);
              const threshold = avg * team.length * 1.5;
              if (teamSum > threshold) {
                const reject = (legal as VoteChoice[]).find((c) => !c.approve);
                if (reject) return reject;
              }
            }
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

// -----------------------------------------------------------------------
// Replay fixtures — generated by actually running this adapter's own
// random-vs-random self-play (see src/reference/__tests__/avalon.test.ts's
// generation note). No original-game engine/replay source exists for a
// from-scratch reimplementation, so — same caveat as gomoku's fixtures —
// these prove reproducibility, not cross-implementation parity, and C7 is
// capped at 60 accordingly (docs/ONBOARDING-GUIDE.md §4).
// -----------------------------------------------------------------------

const replayFixtures: readonly ReplayFixture[] = [
  {
    id: 'avalon-seed-11',
    seed: 11,
    choiceKeys: [
      'propose:0,2', 'vote:false', 'vote:true', 'vote:true', 'vote:true', 'vote:true',
      'mission:true', 'mission:true', 'propose:1,2,3', 'vote:false', 'vote:true', 'vote:true',
      'vote:true', 'vote:true', 'mission:true', 'mission:true', 'mission:false', 'propose:0,4',
      'vote:true', 'vote:false', 'vote:true', 'vote:false', 'vote:false', 'propose:1,4',
      'vote:true', 'vote:false', 'vote:true', 'vote:false', 'vote:false', 'propose:2,4',
      'vote:true', 'vote:false', 'vote:true', 'vote:true', 'vote:true', 'mission:true',
      'mission:true', 'propose:1,2,3', 'vote:true', 'vote:false', 'vote:true', 'vote:false',
      'vote:true', 'mission:false', 'mission:true', 'mission:false', 'propose:1,2,4',
      'vote:false', 'vote:true', 'vote:true', 'vote:true', 'vote:false', 'mission:true',
      'mission:true', 'mission:true', 'assassinate:0',
    ],
    finalScores: [0, 1, 0, 1, 0],
    provenance: 'self-play',
  },
  {
    id: 'avalon-seed-22',
    seed: 22,
    choiceKeys: [
      'propose:0,2', 'vote:false', 'vote:true', 'vote:true', 'vote:true', 'vote:true',
      'mission:true', 'mission:false', 'propose:0,2,4', 'vote:false', 'vote:true', 'vote:true',
      'vote:true', 'vote:true', 'mission:true', 'mission:true', 'mission:true', 'propose:3,4',
      'vote:true', 'vote:true', 'vote:false', 'vote:false', 'vote:false', 'propose:1,3',
      'vote:true', 'vote:false', 'vote:true', 'vote:false', 'vote:true', 'mission:true',
      'mission:true', 'propose:0,2,3', 'vote:true', 'vote:false', 'vote:true', 'vote:true',
      'vote:false', 'mission:true', 'mission:false', 'mission:true', 'propose:1,3,4',
      'vote:false', 'vote:false', 'vote:true', 'vote:false', 'vote:false', 'propose:1,3,4',
      'vote:false', 'vote:true', 'vote:true', 'vote:true', 'vote:true', 'mission:true',
      'mission:true', 'mission:false',
    ],
    finalScores: [0, 0, 1, 0, 1],
    provenance: 'self-play',
  },
  {
    id: 'avalon-seed-33',
    seed: 33,
    choiceKeys: [
      'propose:1,2', 'vote:false', 'vote:true', 'vote:false', 'vote:true', 'vote:true',
      'mission:true', 'mission:true', 'propose:0,1,4', 'vote:false', 'vote:true', 'vote:true',
      'vote:false', 'vote:true', 'mission:false', 'mission:true', 'mission:true', 'propose:1,4',
      'vote:false', 'vote:false', 'vote:true', 'vote:false', 'vote:false', 'propose:0,1',
      'vote:true', 'vote:false', 'vote:false', 'vote:false', 'vote:true', 'propose:1,3',
      'vote:true', 'vote:false', 'vote:true', 'vote:false', 'vote:false', 'propose:0,2',
      'vote:true', 'vote:false', 'vote:false', 'vote:true', 'vote:false', 'propose:3,4',
      'vote:false', 'vote:true', 'vote:true', 'vote:false', 'vote:true', 'mission:true',
      'mission:true', 'propose:0,1,4', 'vote:false', 'vote:true', 'vote:false', 'vote:true',
      'vote:false', 'propose:1,2,3', 'vote:true', 'vote:true', 'vote:true', 'vote:false',
      'vote:true', 'mission:true', 'mission:true', 'mission:true', 'assassinate:1',
    ],
    finalScores: [1, 0, 0, 1, 0],
    provenance: 'self-play',
  },
];

// -----------------------------------------------------------------------
// Seating plan: 5 rotations so the candidate (bot index 0) experiences every
// seat — and, per the role-assignment doc comment above, therefore every
// role — across the plan.
// -----------------------------------------------------------------------

const seatingPlan: readonly (readonly PlayerId[])[] = [
  [0, 1, 2, 3, 4],
  [1, 2, 3, 4, 0],
  [2, 3, 4, 0, 1],
  [3, 4, 0, 1, 2],
  [4, 0, 1, 2, 3],
];

export const avalonAdapter: GameAdapter<AvalonState, AvalonObservation, AvalonChoice> = {
  spec: {
    gameId: 'avalon',
    playerCount: PLAYER_COUNT,
    decisionPoints: [
      { id: 'proposeTeam', description: 'Leader proposes a mission team of the required size.' },
      { id: 'vote', description: 'Each seat votes approve/reject on the proposed team (hidden-sequential).' },
      { id: 'missionCard', description: 'Each team member secretly plays success (or fail, if evil).' },
      { id: 'assassinate', description: "The assassin's single endgame guess at Merlin's identity." },
    ],
    seatingPlan,
    hiddenTeamStructure: true,
    scoreMargin: 'none',
    maxDecisionsPerGame: 180,
    utility: 'zero-sum',
  },
  createInitialState,
  currentDecision,
  getObservation,
  getLegalChoices,
  applyChoice,
  getOutcome,
  encodeChoice,
  invariants: [roleCompositionInvariant, outcomeConsistencyInvariant],
  hiddenInfoProbe: avalonHiddenInfoProbe,
  replayFixtures,
  baselines: {
    random: randomBaseline,
    heuristic: heuristicBaseline,
  },
  strategySurface: [merlinCamouflage, evilDelayedFail, assassinTargetMostTrusted, avalonSuspicionTracking],
};

export { seatsWithRole, combinations };
