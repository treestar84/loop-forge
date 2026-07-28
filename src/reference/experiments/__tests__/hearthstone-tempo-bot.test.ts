import { hearthstoneTempoBot } from '../hearthstone-tempo-bot';
import type {
  CardInstance,
  HearthstoneChoice,
  HearthstoneObservation,
  MinionInstance,
} from '../../hearthstone';

function card(instanceId: string, defId: string): CardInstance {
  return { instanceId, defId };
}

function minion(
  instanceId: string,
  defId: string,
  attack: number,
  health: number,
  overrides: Partial<MinionInstance> = {},
): MinionInstance {
  return {
    instanceId,
    defId,
    attack,
    health,
    maxHealth: health,
    summoningSick: false,
    hasAttacked: false,
    ...overrides,
  };
}

function observation(overrides: Partial<HearthstoneObservation> = {}): HearthstoneObservation {
  return {
    self: 0,
    active: 0,
    turnNumber: 5,
    myHero: { health: 30 },
    myMana: { current: 5, max: 5 },
    myHeroPowerUsed: false,
    myHand: [],
    myBoard: [],
    myDeckSize: 10,
    myFatigue: 0,
    myGraveyard: [],
    opponentHero: { health: 30 },
    opponentMana: { current: 5, max: 5 },
    opponentHeroPowerUsed: false,
    opponentBoard: [],
    opponentHandSize: 4,
    opponentDeckSize: 10,
    opponentFatigue: 0,
    opponentGraveyard: [],
    ...overrides,
  };
}

const END_TURN: HearthstoneChoice = { kind: 'endTurn' };

describe('hearthstoneTempoBot determinism', () => {
  const obs = observation({
    myHand: [card('h1', 'chillwind-yeti'), card('h2', 'river-crocolisk')],
    myBoard: [minion('m1', 'magma-rager', 5, 1)],
    opponentBoard: [minion('e1', 'river-crocolisk', 2, 3)],
  });
  const legal: HearthstoneChoice[] = [
    { kind: 'play', cardInstanceId: 'h1' },
    { kind: 'play', cardInstanceId: 'h2' },
    { kind: 'attack', attackerId: 'm1', targetId: 'e1' },
    { kind: 'attack', attackerId: 'm1', targetId: 'hero:1' },
    END_TURN,
  ];

  it('returns the same decision for two instances built from the same seed', () => {
    expect(hearthstoneTempoBot(42).decide('action', obs, legal)).toEqual(
      hearthstoneTempoBot(42).decide('action', obs, legal),
    );
  });

  it('is stateless across repeated calls on one instance', () => {
    const bot = hearthstoneTempoBot(7);
    expect(bot.decide('action', obs, legal)).toEqual(bot.decide('action', obs, legal));
  });
});

describe('hearthstoneTempoBot — deployment priority', () => {
  it('plays the most expensive legal minion before attacking', () => {
    const obs = observation({
      myHand: [card('h1', 'river-crocolisk'), card('h2', 'chillwind-yeti')],
      myBoard: [minion('m1', 'magma-rager', 5, 1)],
    });
    const legal: HearthstoneChoice[] = [
      { kind: 'play', cardInstanceId: 'h1' },
      { kind: 'play', cardInstanceId: 'h2' },
      { kind: 'attack', attackerId: 'm1', targetId: 'hero:1' },
      END_TURN,
    ];
    expect(hearthstoneTempoBot(1).decide('action', obs, legal)).toEqual({
      kind: 'play',
      cardInstanceId: 'h2',
    });
  });

  it('prefers a minion over a more expensive spell', () => {
    const obs = observation({
      myHand: [card('h1', 'quick-study'), card('h2', 'river-crocolisk')],
    });
    const legal: HearthstoneChoice[] = [
      { kind: 'play', cardInstanceId: 'h1' },
      { kind: 'play', cardInstanceId: 'h2' },
      END_TURN,
    ];
    expect(hearthstoneTempoBot(1).decide('action', obs, legal)).toEqual({
      kind: 'play',
      cardInstanceId: 'h2',
    });
  });

  it('falls back to the most expensive spell when no minion is legal', () => {
    const obs = observation({
      myHand: [card('h1', 'spark-bolt'), card('h2', 'quick-study')],
    });
    const legal: HearthstoneChoice[] = [
      { kind: 'play', cardInstanceId: 'h1', targetId: 'hero:1' },
      { kind: 'play', cardInstanceId: 'h2' },
      END_TURN,
    ];
    expect(hearthstoneTempoBot(1).decide('action', obs, legal)).toEqual({
      kind: 'play',
      cardInstanceId: 'h2',
    });
  });

  it('points a damage battlecry at the biggest minion it can kill', () => {
    const obs = observation({
      myHand: [card('h1', 'elven-archer')],
      opponentBoard: [minion('e1', 'stonetusk-boar', 1, 1), minion('e2', 'magma-rager', 5, 1)],
    });
    const legal: HearthstoneChoice[] = [
      { kind: 'play', cardInstanceId: 'h1', targetId: 'hero:1' },
      { kind: 'play', cardInstanceId: 'h1', targetId: 'e1' },
      { kind: 'play', cardInstanceId: 'h1', targetId: 'e2' },
      END_TURN,
    ];
    expect(hearthstoneTempoBot(1).decide('action', obs, legal)).toEqual({
      kind: 'play',
      cardInstanceId: 'h1',
      targetId: 'e2',
    });
  });
});

describe('hearthstoneTempoBot — attack priority', () => {
  it('takes a favorable trade against the biggest threat it can kill safely', () => {
    const obs = observation({
      myBoard: [minion('m1', 'chillwind-yeti', 4, 5)],
      opponentBoard: [
        minion('e1', 'river-crocolisk', 2, 3),
        minion('e2', 'magma-rager', 5, 1), // attack 5 >= my health 5 -> unsafe
        minion('e3', 'novice-engineer', 3, 4),
      ],
    });
    const legal: HearthstoneChoice[] = [
      { kind: 'attack', attackerId: 'm1', targetId: 'e1' },
      { kind: 'attack', attackerId: 'm1', targetId: 'e2' },
      { kind: 'attack', attackerId: 'm1', targetId: 'e3' },
      { kind: 'attack', attackerId: 'm1', targetId: 'hero:1' },
      END_TURN,
    ];
    // e2 would kill it back (5 >= 5), so it is not a favorable trade; e1 and e3
    // both die to 4 attack without killing back, and e3 is the bigger threat.
    expect(hearthstoneTempoBot(1).decide('action', obs, legal)).toEqual({
      kind: 'attack',
      attackerId: 'm1',
      targetId: 'e3',
    });
  });

  it('goes face with the biggest attacker when no favorable trade exists', () => {
    const obs = observation({
      myBoard: [minion('m1', 'river-crocolisk', 2, 3), minion('m2', 'magma-rager', 5, 1)],
      opponentBoard: [minion('e1', 'boulderfist-ogre', 6, 7)],
    });
    const legal: HearthstoneChoice[] = [
      { kind: 'attack', attackerId: 'm1', targetId: 'e1' },
      { kind: 'attack', attackerId: 'm1', targetId: 'hero:1' },
      { kind: 'attack', attackerId: 'm2', targetId: 'e1' },
      { kind: 'attack', attackerId: 'm2', targetId: 'hero:1' },
      END_TURN,
    ];
    expect(hearthstoneTempoBot(1).decide('action', obs, legal)).toEqual({
      kind: 'attack',
      attackerId: 'm2',
      targetId: 'hero:1',
    });
  });
});

describe('hearthstoneTempoBot — fallbacks', () => {
  it('uses the hero power to finish off a minion when nothing else is available', () => {
    const obs = observation({
      opponentBoard: [minion('e1', 'stonetusk-boar', 1, 1), minion('e2', 'magma-rager', 5, 1)],
    });
    const legal: HearthstoneChoice[] = [
      { kind: 'heroPower', targetId: 'hero:1' },
      { kind: 'heroPower', targetId: 'e1' },
      { kind: 'heroPower', targetId: 'e2' },
      END_TURN,
    ];
    expect(hearthstoneTempoBot(1).decide('action', obs, legal)).toEqual({
      kind: 'heroPower',
      targetId: 'e2',
    });
  });

  it('ends the turn when nothing else is legal', () => {
    expect(hearthstoneTempoBot(1).decide('action', observation(), [END_TURN])).toEqual(END_TURN);
  });
});
