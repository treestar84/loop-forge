import {
  janggiAdapter,
  ARRANGEMENTS,
  applyMove,
  isPlayerInCheck,
  legalMovesFor,
  ROWS,
  COLS,
  GENERAL,
  GUARD,
  CHARIOT,
  CANNON,
  SOLDIER,
  type JanggiState,
  type JanggiChoice,
} from '../janggi';

function idx(row: number, col: number): number {
  return row * COLS + col;
}

function emptyBoard(): number[] {
  return new Array(ROWS * COLS).fill(0);
}

function playSelfPlay(
  seed: number,
  botSeedOffset: number,
): { choiceKeys: string[]; finalScores: readonly number[]; steps: number } {
  const adapter = janggiAdapter;
  let state = adapter.createInitialState(seed);
  const bot0 = adapter.baselines.random(seed);
  const bot1 = adapter.baselines.random(seed + botSeedOffset);
  const choiceKeys: string[] = [];
  let steps = 0;
  for (;;) {
    const decision = adapter.currentDecision(state);
    if (!decision) break;
    steps += 1;
    if (steps > adapter.spec.maxDecisionsPerGame) {
      throw new Error('playSelfPlay: exceeded maxDecisionsPerGame');
    }
    const observation = adapter.getObservation(state, decision.player);
    const legal = adapter.getLegalChoices(state);
    const bot = decision.player === 0 ? bot0 : bot1;
    const choice = bot.decide(decision.decisionPoint, observation, legal);
    choiceKeys.push(adapter.encodeChoice(choice));
    state = adapter.applyChoice(state, choice) as JanggiState;
  }
  const outcome = adapter.getOutcome(state);
  if (!outcome) {
    throw new Error('expected a terminal outcome');
  }
  return { choiceKeys, finalScores: outcome.scores, steps };
}

describe('janggi determinism (C1)', () => {
  it('replays the same trajectory for the same seed', () => {
    const first = playSelfPlay(11, 1000);
    const second = playSelfPlay(11, 1000);
    expect(second.choiceKeys).toEqual(first.choiceKeys);
    expect(second.finalScores).toEqual(first.finalScores);
  });

  it('seed forces the Elephant/Horse arrangement (장기의 함정): both sides vary across seeds', () => {
    const seenRed = new Set<number>();
    const seenBlue = new Set<number>();
    for (let seed = 0; seed < 60; seed += 1) {
      const state = janggiAdapter.createInitialState(seed) as JanggiState;
      seenRed.add(state.redArrangement);
      seenBlue.add(state.blueArrangement);
    }
    expect(seenRed.size).toBe(ARRANGEMENTS.length);
    expect(seenBlue.size).toBe(ARRANGEMENTS.length);
  });

  it('every arrangement combination produces a board with no pre-existing check', () => {
    for (let redArrangement = 0; redArrangement < ARRANGEMENTS.length; redArrangement += 1) {
      for (let blueArrangement = 0; blueArrangement < ARRANGEMENTS.length; blueArrangement += 1) {
        let seed = 0;
        let state: JanggiState | null = null;
        while (state === null && seed < 200) {
          const candidate = janggiAdapter.createInitialState(seed) as JanggiState;
          if (candidate.redArrangement === redArrangement && candidate.blueArrangement === blueArrangement) {
            state = candidate;
          }
          seed += 1;
        }
        expect(state).not.toBeNull();
        if (state) {
          expect(isPlayerInCheck(state.board, 0)).toBe(false);
          expect(isPlayerInCheck(state.board, 1)).toBe(false);
        }
      }
    }
  });

  it('different game seeds produce different move trajectories (no signal collapse)', () => {
    const trajectories = Array.from({ length: 8 }, (_, i) =>
      playSelfPlay(20_000 + i, 1000).choiceKeys.slice(0, 20).join(','),
    );
    const distinct = new Set(trajectories);
    expect(distinct.size).toBeGreaterThanOrEqual(Math.ceil(trajectories.length * 0.8));
  });

  it('matches the hardcoded replay fixtures (C7 parity — self-play reproducibility, see final report)', () => {
    for (const fixture of janggiAdapter.replayFixtures ?? []) {
      const result = playSelfPlay(fixture.seed, 1000);
      expect(result.choiceKeys).toEqual(fixture.choiceKeys);
      expect(result.finalScores).toEqual(fixture.finalScores);
    }
  });
});

describe('janggi rules (C2)', () => {
  it('reaches a terminal outcome within maxDecisionsPerGame for random self-play', () => {
    const adapter = janggiAdapter;
    let state = adapter.createInitialState(99) as JanggiState;
    const bot0 = adapter.baselines.random(99);
    const bot1 = adapter.baselines.random(199);
    let steps = 0;
    for (;;) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      steps += 1;
      expect(steps).toBeLessThanOrEqual(adapter.spec.maxDecisionsPerGame);

      for (const invariant of adapter.invariants ?? []) {
        expect(invariant(state)).toBeNull();
      }

      const observation = adapter.getObservation(state, decision.player);
      const legal = adapter.getLegalChoices(state);
      expect(legal.length).toBeGreaterThan(0);
      const bot = decision.player === 0 ? bot0 : bot1;
      const choice = bot.decide(decision.decisionPoint, observation, legal);
      state = adapter.applyChoice(state, choice) as JanggiState;
    }
    const outcome = adapter.getOutcome(state);
    expect(outcome).not.toBeNull();
  });

  it('throws on an illegal choice (moving to a square not in getLegalChoices)', () => {
    const adapter = janggiAdapter;
    const state = adapter.createInitialState(0) as JanggiState;
    const illegal: JanggiChoice = { from: idx(9, 4), to: idx(0, 4) };
    expect(() => adapter.applyChoice(state, illegal)).toThrow();
  });

  it('throws on an out-of-board choice', () => {
    const adapter = janggiAdapter;
    const state = adapter.createInitialState(0) as JanggiState;
    expect(() => adapter.applyChoice(state, { from: idx(9, 0), to: 999 })).toThrow();
  });

  it('General cannot move diagonally from a palace edge-midpoint (fixes the reference bug — see module doc)', () => {
    const board = emptyBoard();
    board[idx(0, 4)] = -GENERAL; // player 1's general parked at its palace's top edge-midpoint
    board[idx(9, 4)] = GENERAL; // filler
    // Firewall across row 5 (all 3 palace columns) so no move in this test can
    // ever create/resolve a facing situation between the two generals.
    board[idx(5, 3)] = SOLDIER;
    board[idx(5, 4)] = SOLDIER;
    board[idx(5, 5)] = SOLDIER;
    const state: JanggiState = { board, toMove: 1, ply: 0, redArrangement: 0, blueArrangement: 0 };
    const legal = legalMovesFor(state.board, 1);
    const destinations = legal.filter((m) => m.from === idx(0, 4)).map((m) => m.to);
    // Only orthogonal neighbors within the palace (and the pass move) are legal;
    // (1,3) and (1,5) are diagonal but (0,4) is not a corner or center, so they
    // must NOT appear (the Python reference's bug allowed them).
    expect(destinations).not.toContain(idx(1, 3));
    expect(destinations).not.toContain(idx(1, 5));
    expect(destinations.sort()).toEqual([idx(0, 4), idx(0, 3), idx(0, 5), idx(1, 4)].sort());
  });

  it('General CAN move diagonally between a palace corner and the center', () => {
    const board = emptyBoard();
    board[idx(0, 3)] = -GENERAL;
    board[idx(9, 4)] = GENERAL; // filler
    // Firewall across row 5 so no move here can create/resolve facing.
    board[idx(5, 3)] = SOLDIER;
    board[idx(5, 4)] = SOLDIER;
    board[idx(5, 5)] = SOLDIER;
    const state: JanggiState = { board, toMove: 1, ply: 0, redArrangement: 0, blueArrangement: 0 };
    const legal = legalMovesFor(state.board, 1);
    const destinations = legal.filter((m) => m.from === idx(0, 3)).map((m) => m.to);
    expect(destinations).toContain(idx(1, 4));
  });

  it('a General may not make a move that leaves itself in check', () => {
    const board = emptyBoard();
    board[idx(1, 4)] = -GENERAL; // player 1's general, palace rows 0-2
    board[idx(5, 4)] = CHARIOT; // checks along column 4; also blocks facing at the start
    board[idx(9, 4)] = GENERAL;
    const state: JanggiState = { board, toMove: 1, ply: 0, redArrangement: 0, blueArrangement: 0 };
    const legal = legalMovesFor(state.board, 1);
    // The only squares NOT on column 4 (the checked file) are safe: the two
    // orthogonal side-steps and all 4 palace-diagonal corners.
    const destinations = legal.filter((m) => m.from === idx(1, 4)).map((m) => m.to);
    expect(destinations).not.toContain(idx(0, 4));
    expect(destinations).not.toContain(idx(2, 4));
    expect(destinations).not.toContain(idx(1, 4));
    expect(destinations.sort((a, b) => a - b)).toEqual(
      [idx(1, 3), idx(1, 5), idx(0, 3), idx(0, 5), idx(2, 3), idx(2, 5)].sort((a, b) => a - b),
    );
  });

  it('a move that leaves the two generals facing each other with a clear file is illegal', () => {
    const board = emptyBoard();
    board[idx(1, 4)] = -GENERAL; // player 1's general, palace rows 0-2, center
    // A Guard (short palace-confined range, so it can never reach — let alone
    // capture — the far general) currently blocks the shared column.
    board[idx(2, 4)] = -GUARD;
    board[idx(9, 4)] = GENERAL; // player 0's general, same column
    const state: JanggiState = { board, toMove: 1, ply: 0, redArrangement: 0, blueArrangement: 0 };
    const legal = legalMovesFor(state.board, 1);
    const guardMoves = legal.filter((m) => m.from === idx(2, 4)).map((m) => m.to);
    // Moving the blocking guard off column 4 would expose the two generals
    // facing each other with nothing between them — illegal.
    expect(guardMoves).not.toContain(idx(2, 3));
    expect(guardMoves).not.toContain(idx(2, 5));
    // Passing (staying on column 4) remains legal.
    expect(guardMoves).toContain(idx(2, 4));
  });

  it('Cannon must jump exactly one non-cannon piece and cannot capture a cannon', () => {
    const board = emptyBoard();
    board[idx(9, 4)] = GENERAL;
    board[idx(0, 3)] = -GENERAL;
    board[idx(5, 0)] = CANNON;
    board[idx(5, 3)] = SOLDIER; // screen
    board[idx(5, 6)] = -CANNON; // beyond the screen, but a cannon target is illegal
    const state: JanggiState = { board, toMove: 0, ply: 0, redArrangement: 0, blueArrangement: 0 };
    const legal = legalMovesFor(state.board, 0);
    const cannonMoves = legal.filter((m) => m.from === idx(5, 0)).map((m) => m.to);
    expect(cannonMoves).toContain(idx(5, 4));
    expect(cannonMoves).toContain(idx(5, 5));
    expect(cannonMoves).not.toContain(idx(5, 6)); // can't capture a cannon
    expect(cannonMoves).not.toContain(idx(5, 1)); // can't move without jumping a screen
    expect(cannonMoves).not.toContain(idx(5, 2));
  });

  it('Cannon cannot use another cannon as its screen', () => {
    const board = emptyBoard();
    board[idx(9, 4)] = GENERAL;
    board[idx(0, 3)] = -GENERAL;
    board[idx(5, 0)] = CANNON;
    board[idx(5, 3)] = -CANNON; // illegal screen
    board[idx(5, 6)] = -SOLDIER;
    const state: JanggiState = { board, toMove: 0, ply: 0, redArrangement: 0, blueArrangement: 0 };
    const legal = legalMovesFor(state.board, 0);
    const cannonMoves = legal.filter((m) => m.from === idx(5, 0)).map((m) => m.to);
    expect(cannonMoves).toHaveLength(0);
  });

  it('Guard passing (moving to its own square) is legal when not resolving check', () => {
    const board = emptyBoard();
    board[idx(8, 3)] = GUARD;
    board[idx(9, 5)] = GENERAL;
    board[idx(0, 3)] = -GENERAL;
    const state: JanggiState = { board, toMove: 0, ply: 0, redArrangement: 0, blueArrangement: 0 };
    const legal = legalMovesFor(state.board, 0);
    expect(legal.some((m) => m.from === idx(8, 3) && m.to === idx(8, 3))).toBe(true);
  });

  it('produces a checkmate (no legal moves) ending the game with the mover as loser', () => {
    // A minimal mate: player 1's general sits in its palace corner (0,3),
    // which has exactly 4 reachable squares (pass, (1,3), (0,4), (1,4) via
    // the corner-center diagonal). Two player 0 chariots hold columns 3 and 4
    // all the way down, so every one of those 4 squares stays attacked no
    // matter which the general tries — including the pass, since column 3 is
    // already checking it.
    const board = emptyBoard();
    board[idx(0, 3)] = -GENERAL;
    board[idx(9, 4)] = GENERAL;
    board[idx(5, 3)] = CHARIOT; // checks (0,3)/(1,3) along column 3
    board[idx(5, 4)] = CHARIOT; // covers (0,4)/(1,4) along column 4
    const state: JanggiState = { board, toMove: 1, ply: 0, redArrangement: 0, blueArrangement: 0 };
    expect(isPlayerInCheck(state.board, 1)).toBe(true);
    const decision = janggiAdapter.currentDecision(state);
    expect(decision).toBeNull();
    const outcome = janggiAdapter.getOutcome(state);
    expect(outcome?.winners).toEqual([0]);
    expect(outcome?.scores).toEqual([1, 0]);
  });

  it('reaching the ply cap with unequal material declares the higher-material side the winner', () => {
    const board = emptyBoard();
    board[idx(9, 4)] = GENERAL;
    board[idx(0, 4)] = -GENERAL;
    board[idx(5, 5)] = CHARIOT; // player 0 has extra material
    const state: JanggiState = {
      board,
      toMove: 0,
      ply: janggiAdapter.spec.maxDecisionsPerGame,
      redArrangement: 0,
      blueArrangement: 0,
    };
    expect(janggiAdapter.currentDecision(state)).toBeNull();
    const outcome = janggiAdapter.getOutcome(state);
    expect(outcome?.winners).toEqual([0]);
  });

  it('reaching the ply cap with equal material is a draw', () => {
    const board = emptyBoard();
    board[idx(9, 4)] = GENERAL;
    board[idx(0, 4)] = -GENERAL;
    const state: JanggiState = {
      board,
      toMove: 0,
      ply: janggiAdapter.spec.maxDecisionsPerGame,
      redArrangement: 0,
      blueArrangement: 0,
    };
    const outcome = janggiAdapter.getOutcome(state);
    expect(outcome?.winners).toEqual([0, 1]);
    expect(outcome?.scores).toEqual([0, 0]);
  });
});

describe('janggi perfect information (C3)', () => {
  it('declares perfectInformation and omits hiddenInfoProbe', () => {
    expect(janggiAdapter.spec.perfectInformation).toBe(true);
    expect(janggiAdapter.hiddenInfoProbe).toBeUndefined();
  });
});

describe('janggi strategySurface (C6)', () => {
  function findFlag(flag: string) {
    const found = janggiAdapter.strategySurface.find((f) => f.flag === flag);
    if (!found) {
      throw new Error(`strategy flag not found: ${flag}`);
    }
    return found;
  }

  it('captureHighestValue takes the highest-value capture even when the base bot would not', () => {
    const board = emptyBoard();
    board[idx(9, 4)] = GENERAL;
    board[idx(0, 3)] = -GENERAL;
    board[idx(5, 4)] = CHARIOT;
    board[idx(5, 3)] = -SOLDIER; // low-value capture
    board[idx(5, 6)] = -CHARIOT; // high-value capture, further away
    const state: JanggiState = { board, toMove: 0, ply: 0, redArrangement: 0, blueArrangement: 0 };
    const legal = janggiAdapter.getLegalChoices(state);
    const observation = janggiAdapter.getObservation(state, 0);

    const captureHighestValue = findFlag('captureHighestValue');
    const alwaysFirst: typeof janggiAdapter.baselines.random = () => ({
      id: 'always-first',
      decide: () => legal[0] as JanggiChoice,
    });
    const variantBot = captureHighestValue.apply(alwaysFirst)(1);
    const choice = variantBot.decide('move', observation, legal);
    expect(choice).toEqual({ from: idx(5, 4), to: idx(5, 6) });
  });

  it('preferCheck plays a checking move when one is available', () => {
    const board = emptyBoard();
    board[idx(9, 4)] = GENERAL;
    board[idx(6, 4)] = SOLDIER; // blocks facing at the start (not on the checking path)
    board[idx(2, 4)] = -GENERAL;
    board[idx(5, 3)] = CHARIOT; // off the general's file; sliding to (5,4) delivers check without capturing
    const state: JanggiState = { board, toMove: 0, ply: 0, redArrangement: 0, blueArrangement: 0 };
    const legal = janggiAdapter.getLegalChoices(state);
    const observation = janggiAdapter.getObservation(state, 0);

    const preferCheck = findFlag('preferCheck');
    const alwaysFirst: typeof janggiAdapter.baselines.random = () => ({
      id: 'always-first',
      decide: () => legal.find((m) => m.from !== idx(5, 3)) ?? (legal[0] as JanggiChoice),
    });
    const variantBot = preferCheck.apply(alwaysFirst)(1);
    const choice = variantBot.decide('move', observation, legal);
    const next = applyMove(state.board, choice);
    expect(isPlayerInCheck(next, 1)).toBe(true);
  });

  it('advanceSoldier always moves a Soldier when one is legal, unlike a base bot that ignores them', () => {
    const board = emptyBoard();
    board[idx(9, 4)] = GENERAL;
    board[idx(0, 3)] = -GENERAL;
    board[idx(6, 0)] = SOLDIER;
    board[idx(5, 8)] = CHARIOT;
    const state: JanggiState = { board, toMove: 0, ply: 0, redArrangement: 0, blueArrangement: 0 };
    const legal = janggiAdapter.getLegalChoices(state);
    const observation = janggiAdapter.getObservation(state, 0);

    const advanceSoldier = findFlag('advanceSoldier');
    const alwaysChariot: typeof janggiAdapter.baselines.random = () => ({
      id: 'always-chariot',
      decide: () => legal.find((m) => m.from === idx(5, 8)) ?? (legal[0] as JanggiChoice),
    });
    const baseChoice = alwaysChariot(1).decide('move', observation, legal);
    const variantBot = advanceSoldier.apply(alwaysChariot)(1);
    const variantChoice = variantBot.decide('move', observation, legal);
    expect(baseChoice.from).toBe(idx(5, 8));
    expect(variantChoice.from).toBe(idx(6, 0));
  });
});
