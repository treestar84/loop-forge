import { hearthstoneMidBot } from '../hearthstone-mid-bot';
import type { HearthstoneChoice, HearthstoneObservation, MinionInstance } from '../../hearthstone';

function minion(instanceId: string, defId: string, attack: number, health: number, overrides: Partial<MinionInstance> = {}): MinionInstance {
  return { instanceId, defId, attack, health, maxHealth: health, summoningSick: false, hasAttacked: false, ...overrides };
}

function baseObservation(overrides: Partial<HearthstoneObservation>): HearthstoneObservation {
  return {
    self: 0,
    active: 0,
    turnNumber: 3,
    myHero: { health: 30 },
    myMana: { current: 3, max: 3 },
    myHeroPowerUsed: false,
    myHand: [],
    myBoard: [],
    myDeckSize: 20,
    myFatigue: 0,
    myGraveyard: [],
    opponentHero: { health: 30 },
    opponentMana: { current: 3, max: 3 },
    opponentHeroPowerUsed: false,
    opponentBoard: [],
    opponentHandSize: 5,
    opponentDeckSize: 20,
    opponentFatigue: 0,
    opponentGraveyard: [],
    ...overrides,
  };
}

describe('hearthstoneMidBot determinism (C1)', () => {
  it('returns the same decision for the same seed and observation, repeated', () => {
    const bot1 = hearthstoneMidBot(5);
    const bot2 = hearthstoneMidBot(5);
    const legal: HearthstoneChoice[] = [{ kind: 'attack', attackerId: 'a', targetId: 'hero:1' }, { kind: 'endTurn' }];
    const observation = baseObservation({ myBoard: [minion('a', 'river-crocolisk', 2, 3)] });
    expect(bot1.decide('action', observation, legal)).toEqual(bot2.decide('action', observation, legal));
  });
});

describe('hearthstoneMidBot — lethal', () => {
  it('commits to face when the sum of ready minion attacks reaches the enemy hero health', () => {
    const bot = hearthstoneMidBot(1);
    const legal: HearthstoneChoice[] = [
      { kind: 'attack', attackerId: 'a', targetId: 'hero:1' },
      { kind: 'attack', attackerId: 'b', targetId: 'hero:1' },
      { kind: 'endTurn' },
    ];
    const observation = baseObservation({
      myBoard: [minion('a', 'chillwind-yeti', 4, 5), minion('b', 'boulderfist-ogre', 6, 7)],
      opponentHero: { health: 9 },
    });
    const choice = bot.decide('action', observation, legal);
    expect(choice).toEqual({ kind: 'attack', attackerId: 'a', targetId: 'hero:1' });
  });

  it('does not force face when minion attacks alone cannot reach lethal', () => {
    const bot = hearthstoneMidBot(1);
    const legal: HearthstoneChoice[] = [
      { kind: 'attack', attackerId: 'a', targetId: 'm1' },
      { kind: 'attack', attackerId: 'a', targetId: 'hero:1' },
      { kind: 'endTurn' },
    ];
    const observation = baseObservation({
      myBoard: [minion('a', 'chillwind-yeti', 4, 5)],
      opponentBoard: [minion('m1', 'elven-archer', 1, 1)],
      opponentHero: { health: 30 },
    });
    const choice = bot.decide('action', observation, legal);
    // A clean kill (4 dmg vs 1 health, attacker survives) should be preferred over face.
    expect(choice).toEqual({ kind: 'attack', attackerId: 'a', targetId: 'm1' });
  });
});

describe('hearthstoneMidBot — every decision stays within the legal set', () => {
  it('falls back to a legal hero power or endTurn when no play/attack applies', () => {
    const bot = hearthstoneMidBot(1);
    const legal: HearthstoneChoice[] = [{ kind: 'endTurn' }];
    const choice = bot.decide('action', baseObservation({}), legal);
    expect(legal).toContainEqual(choice);
  });
});
