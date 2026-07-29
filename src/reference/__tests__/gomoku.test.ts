import {
  gomokuAdapter,
  OPENING_BOOK,
  gomokuChoiceEvaluator,
  CHOICE_EVALUATOR_TIER,
  type GomokuChoice,
  type GomokuState,
} from '../gomoku';

function playSelfPlay(
  seed: number,
  botSeedOffset: number,
): { choiceKeys: string[]; finalScores: readonly number[]; steps: number } {
  const adapter = gomokuAdapter;
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
    state = adapter.applyChoice(state, choice);
  }
  const outcome = adapter.getOutcome(state);
  if (!outcome) {
    throw new Error('expected a terminal outcome');
  }
  return { choiceKeys, finalScores: outcome.scores, steps };
}

describe('gomoku determinism (C1)', () => {
  it('replays the same trajectory for the same seed', () => {
    const first = playSelfPlay(11, 1000);
    const second = playSelfPlay(11, 1000);
    expect(second.choiceKeys).toEqual(first.choiceKeys);
    expect(second.finalScores).toEqual(first.finalScores);
  });

  it('injects seed-indexed opening diversity: different seeds pick different opening lines', () => {
    const seenOpenings = new Set<string>();
    for (let seed = 0; seed < OPENING_BOOK.length * 2; seed += 1) {
      const state = gomokuAdapter.createInitialState(seed);
      seenOpenings.add((state as GomokuState).openingId);
    }
    // With 2x the bank size sampled, we should see a healthy majority of the
    // distinct opening lines represented, not a single collapsed choice.
    expect(seenOpenings.size).toBeGreaterThanOrEqual(Math.ceil(OPENING_BOOK.length * 0.5));
  });

  it('different game seeds produce different move trajectories (no signal collapse)', () => {
    const trajectories = Array.from({ length: 8 }, (_, i) =>
      playSelfPlay(20_000 + i, 1000).choiceKeys.join(','),
    );
    const distinct = new Set(trajectories);
    expect(distinct.size).toBeGreaterThanOrEqual(Math.ceil(trajectories.length * 0.8));
  });

  it('matches the hardcoded replay fixtures (C7 parity — self-play reproducibility, see final report)', () => {
    for (const fixture of gomokuAdapter.replayFixtures ?? []) {
      const result = playSelfPlay(fixture.seed, 1000);
      expect(result.choiceKeys).toEqual(fixture.choiceKeys);
      expect(result.finalScores).toEqual(fixture.finalScores);
    }
  });
});

describe('gomoku rules (C2)', () => {
  it('throws on an illegal choice (already-occupied cell)', () => {
    const adapter = gomokuAdapter;
    const state = adapter.createInitialState(7);
    const decision = adapter.currentDecision(state);
    expect(decision).not.toBeNull();
    const occupiedIndex = (state as GomokuState).board.findIndex((cell) => cell !== 0);
    expect(occupiedIndex).toBeGreaterThanOrEqual(0);
    const row = Math.floor(occupiedIndex / 15);
    const col = occupiedIndex % 15;
    const illegalChoice: GomokuChoice = { row, col };
    expect(() => adapter.applyChoice(state, illegalChoice)).toThrow();
  });

  it('throws on an out-of-bounds choice', () => {
    const adapter = gomokuAdapter;
    const state = adapter.createInitialState(7);
    expect(() => adapter.applyChoice(state, { row: 99, col: 99 })).toThrow();
  });

  it('detects a horizontal five-in-a-row', () => {
    const adapter = gomokuAdapter;
    let state = adapter.createInitialState(0);
    state = { ...(state as GomokuState), board: new Array(225).fill(0), moveCount: 0, winner: null };
    const moves: GomokuChoice[] = [
      { row: 5, col: 0 }, // black
      { row: 6, col: 0 }, // white
      { row: 5, col: 1 }, // black
      { row: 6, col: 1 }, // white
      { row: 5, col: 2 }, // black
      { row: 6, col: 2 }, // white
      { row: 5, col: 3 }, // black
      { row: 6, col: 3 }, // white
      { row: 5, col: 4 }, // black -> five in a row
    ];
    for (const move of moves) {
      state = adapter.applyChoice(state, move) as GomokuState;
    }
    const outcome = adapter.getOutcome(state);
    expect(outcome).not.toBeNull();
    expect(outcome?.winners).toEqual([0]);
    expect(outcome?.scores).toEqual([1, 0]);
  });

  it('detects a vertical five-in-a-row', () => {
    const adapter = gomokuAdapter;
    let state: GomokuState = {
      board: new Array(225).fill(0),
      moveCount: 0,
      winner: null,
      openingId: 'test',
    };
    const moves: GomokuChoice[] = [
      { row: 0, col: 5 }, // black
      { row: 0, col: 6 }, // white
      { row: 1, col: 5 }, // black
      { row: 1, col: 6 }, // white
      { row: 2, col: 5 }, // black
      { row: 2, col: 6 }, // white
      { row: 3, col: 5 }, // black
      { row: 3, col: 6 }, // white
      { row: 4, col: 5 }, // black -> five in a column
    ];
    for (const move of moves) {
      state = adapter.applyChoice(state, move) as GomokuState;
    }
    const outcome = adapter.getOutcome(state);
    expect(outcome?.winners).toEqual([0]);
  });

  it('detects a diagonal five-in-a-row', () => {
    const adapter = gomokuAdapter;
    let state: GomokuState = {
      board: new Array(225).fill(0),
      moveCount: 0,
      winner: null,
      openingId: 'test',
    };
    const moves: GomokuChoice[] = [
      { row: 0, col: 0 }, // black
      { row: 0, col: 10 }, // white
      { row: 1, col: 1 }, // black
      { row: 1, col: 10 }, // white
      { row: 2, col: 2 }, // black
      { row: 2, col: 10 }, // white
      { row: 3, col: 3 }, // black
      { row: 3, col: 10 }, // white
      { row: 4, col: 4 }, // black -> five on the \ diagonal
    ];
    for (const move of moves) {
      state = adapter.applyChoice(state, move) as GomokuState;
    }
    const outcome = adapter.getOutcome(state);
    expect(outcome?.winners).toEqual([0]);
  });

  it('reaches a terminal outcome within maxDecisionsPerGame for random self-play', () => {
    const adapter = gomokuAdapter;
    let state = adapter.createInitialState(99);
    const bot0 = adapter.baselines.random(99);
    const bot1 = adapter.baselines.random(199);
    let steps = (state as GomokuState).moveCount;
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
      state = adapter.applyChoice(state, choice) as GomokuState;
    }
    const outcome = adapter.getOutcome(state);
    expect(outcome).not.toBeNull();
  });

  it('opening book contains no pre-won positions and alternates correctly', () => {
    for (let i = 0; i < OPENING_BOOK.length; i += 1) {
      // Sweep seeds until this exact opening index is chosen at least once;
      // createInitialState itself throws if an opening is pre-won, so simply
      // constructing every opening's initial state is the test.
      let found = false;
      for (let seed = 0; seed < 5000 && !found; seed += 1) {
        const state = gomokuAdapter.createInitialState(seed) as GomokuState;
        if (state.openingId === OPENING_BOOK[i]?.id) {
          found = true;
          for (const invariant of gomokuAdapter.invariants ?? []) {
            expect(invariant(state)).toBeNull();
          }
        }
      }
      expect(found).toBe(true);
    }
  });
});

describe('gomoku perfect information (C3)', () => {
  it('declares perfectInformation and omits hiddenInfoProbe', () => {
    expect(gomokuAdapter.spec.perfectInformation).toBe(true);
    expect(gomokuAdapter.hiddenInfoProbe).toBeUndefined();
  });
});

describe('gomoku strategySurface (C6)', () => {
  function findFlag(flag: string) {
    const found = gomokuAdapter.strategySurface.find((f) => f.flag === flag);
    if (!found) {
      throw new Error(`strategy flag not found: ${flag}`);
    }
    return found;
  }

  it('blockImmediateThreat blocks an opponent four-in-a-row that the base bot would ignore', () => {
    const adapter = gomokuAdapter;
    const blockImmediateThreat = findFlag('blockImmediateThreat');
    const baseFactory = adapter.baselines.heuristic;
    const variantFactory = blockImmediateThreat.apply(baseFactory);
    const baseBot = baseFactory(1);
    const variantBot = variantFactory(1);

    // White (player 1) has four in a row (0,10..0,13); black to move must
    // block at (0,9) or (0,14), or white wins next turn. Black also has a
    // few scattered stones far away so the heuristic base bot (which scores
    // by adjacency to own stones) picks a self-adjacent cell instead of the
    // block.
    const board = new Array(225).fill(0);
    const idx = (r: number, c: number) => r * 15 + c;
    board[idx(0, 10)] = 2;
    board[idx(0, 11)] = 2;
    board[idx(0, 12)] = 2;
    board[idx(0, 13)] = 2;
    board[idx(7, 7)] = 1;
    board[idx(7, 8)] = 1;
    const state: GomokuState = { board, moveCount: 6, winner: null, openingId: 'test' };
    const decision = adapter.currentDecision(state);
    expect(decision?.player).toBe(0);
    const legal = adapter.getLegalChoices(state);
    const observation = adapter.getObservation(state, 0);

    const baseChoice = baseBot.decide('place', observation, legal);
    const variantChoice = variantBot.decide('place', observation, legal);

    expect(baseChoice).not.toEqual({ row: 0, col: 9 });
    expect(baseChoice).not.toEqual({ row: 0, col: 14 });
    expect([{ row: 0, col: 9 }, { row: 0, col: 14 }]).toContainEqual(variantChoice);
    expect(variantChoice).not.toEqual(baseChoice);
  });

  it('centerProximity always chooses the cell closest to the board center', () => {
    const adapter = gomokuAdapter;
    const centerProximity = findFlag('centerProximity');
    const variantFactory = centerProximity.apply(adapter.baselines.heuristic);
    const variantBot = variantFactory(1);

    const board = new Array(225).fill(0);
    const idx = (r: number, c: number) => r * 15 + c;
    board[idx(0, 0)] = 1;
    board[idx(14, 14)] = 2;
    const state: GomokuState = { board, moveCount: 2, winner: null, openingId: 'test' };
    const legal = adapter.getLegalChoices(state);
    const observation = adapter.getObservation(state, 0);
    const choice = variantBot.decide('place', observation, legal);
    expect(choice).toEqual({ row: 7, col: 7 });
  });

  it('extendLongestLine plays the cell that creates the longest line, unlike the density-based base heuristic', () => {
    const adapter = gomokuAdapter;
    const extendLongestLine = findFlag('extendLongestLine');
    const baseFactory = adapter.baselines.heuristic;
    const variantFactory = extendLongestLine.apply(baseFactory);
    const baseBot = baseFactory(1);
    const variantBot = variantFactory(1);

    // Black has four stones in a tight cluster (high adjacency density, no
    // line potential beyond length 2) plus three in an open line missing one
    // cell to extend to length 4. The base heuristic (density-scored)
    // prefers the cluster; extendLongestLine prefers completing the line.
    const board = new Array(225).fill(0);
    const idx = (r: number, c: number) => r * 15 + c;
    board[idx(3, 3)] = 1;
    board[idx(3, 4)] = 1;
    board[idx(4, 3)] = 1;
    board[idx(4, 4)] = 1;
    board[idx(10, 4)] = 2; // white block on the left, so only the right extends the line
    board[idx(10, 5)] = 1;
    board[idx(10, 6)] = 1;
    board[idx(10, 7)] = 1;
    const state: GomokuState = { board, moveCount: 7, winner: null, openingId: 'test' };
    const legal = adapter.getLegalChoices(state);
    const observation = adapter.getObservation(state, 1); // wrong player deliberately avoided below

    const blackObservation = adapter.getObservation(state, 0);
    const baseChoice = baseBot.decide('place', blackObservation, legal);
    const variantChoice = variantBot.decide('place', blackObservation, legal);

    expect(variantChoice).toEqual({ row: 10, col: 8 });
    expect(variantChoice).not.toEqual(baseChoice);
    void observation;
  });

  it('forkAwareness plays a move that creates two simultaneous open-three threats (a fork)', () => {
    const adapter = gomokuAdapter;
    const forkAwareness = findFlag('forkAwareness');
    const baseFactory = adapter.baselines.heuristic;
    const variantFactory = forkAwareness.apply(baseFactory);
    const variantBot = variantFactory(1);

    // Black has a horizontal pair (7,5)-(7,6) and a vertical pair
    // (5,7)-(6,7); both pairs share (7,7) as their extension cell. Playing
    // (7,7) turns both pairs into open threes at once (horizontal 5..7,
    // vertical 5..7), a fork the opponent cannot block with one move. No
    // other legal cell creates two simultaneous threats in this position.
    const board = new Array(225).fill(0);
    const idx = (r: number, c: number) => r * 15 + c;
    board[idx(7, 5)] = 1;
    board[idx(7, 6)] = 1;
    board[idx(5, 7)] = 1;
    board[idx(6, 7)] = 1;
    board[idx(0, 0)] = 2; // a lone white stone far away, no bearing on the fork
    const state: GomokuState = { board, moveCount: 4, winner: null, openingId: 'test' };
    const decision = adapter.currentDecision(state);
    expect(decision?.player).toBe(0);
    const legal = adapter.getLegalChoices(state);
    const observation = adapter.getObservation(state, 0);

    const variantChoice = variantBot.decide('place', observation, legal);
    expect(variantChoice).toEqual({ row: 7, col: 7 });
  });

  it('forkAwareness blocks the cell the opponent would use to create a fork next turn', () => {
    const adapter = gomokuAdapter;
    const forkAwareness = findFlag('forkAwareness');
    const baseFactory = adapter.baselines.heuristic;
    const variantFactory = forkAwareness.apply(baseFactory);
    const baseBot = baseFactory(1);
    const variantBot = variantFactory(1);

    // Same shared-extension-cell geometry as the previous test, but the
    // stones belong to White (player 1) instead of Black, and it is Black's
    // turn. Black has a couple of unrelated stones far away so the base
    // heuristic bot (density-scored) would ignore the fork cell entirely.
    const board = new Array(225).fill(0);
    const idx = (r: number, c: number) => r * 15 + c;
    board[idx(7, 5)] = 2;
    board[idx(7, 6)] = 2;
    board[idx(5, 7)] = 2;
    board[idx(6, 7)] = 2;
    board[idx(0, 0)] = 1;
    board[idx(0, 1)] = 1;
    const state: GomokuState = { board, moveCount: 6, winner: null, openingId: 'test' };
    const decision = adapter.currentDecision(state);
    expect(decision?.player).toBe(0);
    const legal = adapter.getLegalChoices(state);
    const observation = adapter.getObservation(state, 0);

    const baseChoice = baseBot.decide('place', observation, legal);
    const variantChoice = variantBot.decide('place', observation, legal);

    expect(baseChoice).not.toEqual({ row: 7, col: 7 });
    expect(variantChoice).toEqual({ row: 7, col: 7 });
  });

  it('forkAwareness composes cleanly with the existing 3 flags without breaking their behavior', () => {
    const adapter = gomokuAdapter;
    const blockImmediateThreat = findFlag('blockImmediateThreat');
    const centerProximity = findFlag('centerProximity');
    const extendLongestLine = findFlag('extendLongestLine');
    const forkAwareness = findFlag('forkAwareness');

    // Chain all 4 flags the way composeBot would (loop/compose.ts), fork
    // innermost: heuristic -> extendLongestLine -> centerProximity ->
    // blockImmediateThreat -> forkAwareness.
    let factory = adapter.baselines.heuristic;
    factory = extendLongestLine.apply(factory);
    factory = centerProximity.apply(factory);
    factory = blockImmediateThreat.apply(factory);
    factory = forkAwareness.apply(factory);
    const composedBot = factory(1);

    // Reuse the blockImmediateThreat fixture from above: white has an
    // unblocked four-in-a-row, so the composed bot (via forkAwareness's own
    // step 2, which runs before any base delegation) must still block it —
    // proving the new flag doesn't shadow or break the existing win/block
    // priority when layered on top.
    const board = new Array(225).fill(0);
    const idx = (r: number, c: number) => r * 15 + c;
    board[idx(0, 10)] = 2;
    board[idx(0, 11)] = 2;
    board[idx(0, 12)] = 2;
    board[idx(0, 13)] = 2;
    board[idx(7, 7)] = 1;
    board[idx(7, 8)] = 1;
    const state: GomokuState = { board, moveCount: 6, winner: null, openingId: 'test' };
    const legal = adapter.getLegalChoices(state);
    const observation = adapter.getObservation(state, 0);

    const composedChoice = composedBot.decide('place', observation, legal);
    expect([{ row: 0, col: 9 }, { row: 0, col: 14 }]).toContainEqual(composedChoice);

    // Also sanity-check every legal move remains a valid choice from the
    // composed bot on a plain empty-ish board (no crash, always returns an
    // element from `legal`).
    const neutralBoard = new Array(225).fill(0);
    neutralBoard[idx(3, 3)] = 1;
    neutralBoard[idx(11, 11)] = 2;
    const neutralState: GomokuState = { board: neutralBoard, moveCount: 2, winner: null, openingId: 'test' };
    const neutralLegal = adapter.getLegalChoices(neutralState);
    const neutralObservation = adapter.getObservation(neutralState, 0);
    const neutralChoice = composedBot.decide('place', neutralObservation, neutralLegal);
    expect(neutralLegal.map((m) => `${m.row}-${m.col}`)).toContain(`${neutralChoice.row}-${neutralChoice.col}`);
  });
});

describe('gomoku choiceEvaluator (ADR-0011, docs/GAP-ANALYSIS-11.md D1)', () => {
  const idx = (r: number, c: number) => r * 15 + c;
  const scoreOf = (
    state: GomokuState,
    player: 0 | 1,
    legal: readonly GomokuChoice[],
    move: GomokuChoice,
  ): number => {
    const scores = gomokuChoiceEvaluator(state, player, legal);
    const i = legal.findIndex((m) => m.row === move.row && m.col === move.col);
    expect(i).toBeGreaterThanOrEqual(0);
    return scores[i] as number;
  };

  it('scores an immediate-win move as the highest tier', () => {
    // Black has 4 in a row (7,3..7,6), both ends (7,2) and (7,7) open — either
    // completes 5. A far-away neutral cell has no threat at all.
    const board = new Array(225).fill(0);
    board[idx(7, 3)] = 1;
    board[idx(7, 4)] = 1;
    board[idx(7, 5)] = 1;
    board[idx(7, 6)] = 1;
    const state: GomokuState = { board, moveCount: 4, winner: null, openingId: 'test' };
    const legal = [{ row: 7, col: 2 }, { row: 7, col: 7 }, { row: 0, col: 0 }];

    expect(scoreOf(state, 0, legal, { row: 7, col: 2 })).toBe(CHOICE_EVALUATOR_TIER.win);
    expect(scoreOf(state, 0, legal, { row: 7, col: 7 })).toBe(CHOICE_EVALUATOR_TIER.win);
    expect(scoreOf(state, 0, legal, { row: 0, col: 0 })).toBeLessThan(CHOICE_EVALUATOR_TIER.win);
  });

  it('scores blocking the opponent immediate win above every non-win move', () => {
    // White has 4 in a row (3,3..3,6); Black must occupy (3,2) or (3,7) to
    // block. Black has no threats of its own on this board.
    const board = new Array(225).fill(0);
    board[idx(3, 3)] = 2;
    board[idx(3, 4)] = 2;
    board[idx(3, 5)] = 2;
    board[idx(3, 6)] = 2;
    const state: GomokuState = { board, moveCount: 4, winner: null, openingId: 'test' };
    const legal = [{ row: 3, col: 2 }, { row: 3, col: 7 }, { row: 0, col: 0 }];

    expect(scoreOf(state, 0, legal, { row: 3, col: 2 })).toBe(CHOICE_EVALUATOR_TIER.blockWin);
    expect(scoreOf(state, 0, legal, { row: 3, col: 7 })).toBe(CHOICE_EVALUATOR_TIER.blockWin);
    expect(scoreOf(state, 0, legal, { row: 0, col: 0 })).toBeLessThan(CHOICE_EVALUATOR_TIER.blockWin);
  });

  it('scores a fork-creating move above a single-threat move', () => {
    // Same geometry as the "forkAwareness plays a fork" behavioral test
    // above: (7,7) turns two separate pairs into simultaneous open threes.
    // (9,9) merely extends one isolated stone (2,2) with no independent
    // second threat — a plain single-threat/extension move by comparison.
    const board = new Array(225).fill(0);
    board[idx(7, 5)] = 1;
    board[idx(7, 6)] = 1;
    board[idx(5, 7)] = 1;
    board[idx(6, 7)] = 1;
    board[idx(9, 9)] = 1;
    const state: GomokuState = { board, moveCount: 5, winner: null, openingId: 'test' };
    const legal = [{ row: 7, col: 7 }, { row: 9, col: 10 }];

    const forkScore = scoreOf(state, 0, legal, { row: 7, col: 7 });
    const singleScore = scoreOf(state, 0, legal, { row: 9, col: 10 });
    expect(forkScore).toBe(CHOICE_EVALUATOR_TIER.fork);
    expect(forkScore).toBeGreaterThan(singleScore);
  });

  it('scores blocking an opponent fork above an ordinary extension move', () => {
    // Same geometry as the "forkAwareness blocks a fork" behavioral test
    // above: White (not to move) owns the two pairs; Black must occupy (7,7)
    // to deny the fork. (0,2) merely extends Black's own unrelated pair with
    // no fork/threat implication.
    const board = new Array(225).fill(0);
    board[idx(7, 5)] = 2;
    board[idx(7, 6)] = 2;
    board[idx(5, 7)] = 2;
    board[idx(6, 7)] = 2;
    board[idx(0, 0)] = 1;
    board[idx(0, 1)] = 1;
    const state: GomokuState = { board, moveCount: 6, winner: null, openingId: 'test' };
    const legal = [{ row: 7, col: 7 }, { row: 0, col: 2 }];

    const blockForkScore = scoreOf(state, 0, legal, { row: 7, col: 7 });
    const extendScore = scoreOf(state, 0, legal, { row: 0, col: 2 });
    expect(blockForkScore).toBe(CHOICE_EVALUATOR_TIER.blockFork);
    expect(blockForkScore).toBeGreaterThan(extendScore);
  });

  it('ranks a four-with-open-end above an open three, and an open three above a plain extension', () => {
    // Row 4: black at (4,3)-(4,5), open both ends -> playing (4,6) or (4,2)
    // makes an open four ("열린4"). Row 9: black at (9,3)-(9,4) only, open
    // both ends -> playing (9,5) or (9,2) makes an open three. (12,12) is an
    // isolated stone whose neighbor is a plain 2-length extension.
    const board = new Array(225).fill(0);
    board[idx(4, 3)] = 1;
    board[idx(4, 4)] = 1;
    board[idx(4, 5)] = 1;
    board[idx(9, 3)] = 1;
    board[idx(9, 4)] = 1;
    board[idx(12, 12)] = 1;
    const state: GomokuState = { board, moveCount: 6, winner: null, openingId: 'test' };
    const legal = [{ row: 4, col: 6 }, { row: 9, col: 5 }, { row: 12, col: 13 }];

    const fourScore = scoreOf(state, 0, legal, { row: 4, col: 6 });
    const openThreeScore = scoreOf(state, 0, legal, { row: 9, col: 5 });
    const extensionScore = scoreOf(state, 0, legal, { row: 12, col: 13 });

    expect(fourScore).toBe(CHOICE_EVALUATOR_TIER.four);
    expect(openThreeScore).toBe(CHOICE_EVALUATOR_TIER.openThree);
    expect(fourScore).toBeGreaterThan(openThreeScore);
    expect(openThreeScore).toBeGreaterThan(extensionScore);
  });

  it('is deterministic and returns one score per choice, in order', () => {
    const board = new Array(225).fill(0);
    board[idx(7, 7)] = 1;
    board[idx(3, 3)] = 2;
    const state: GomokuState = { board, moveCount: 2, winner: null, openingId: 'test' };
    const legal = gomokuAdapter.getLegalChoices(state);

    const first = gomokuChoiceEvaluator(state, 0, legal);
    const second = gomokuChoiceEvaluator(state, 0, legal);
    expect(first.length).toBe(legal.length);
    expect(first).toEqual(second);
  });

  it('is wired onto gomokuAdapter as an optional field without touching existing strategySurface flags', () => {
    expect(gomokuAdapter.choiceEvaluator).toBe(gomokuChoiceEvaluator);
    expect(gomokuAdapter.strategySurface.map((flag) => flag.flag)).toEqual([
      'blockImmediateThreat',
      'centerProximity',
      'extendLongestLine',
      'forkAwareness',
    ]);
  });
});
