import { dominionMidBot } from '../dominion-mid-bot';
import type { CardName, DominionChoice, DominionObservation } from '../../dominion';

const FULL_SUPPLY: Readonly<Record<CardName, number>> = {
  Copper: 60,
  Silver: 40,
  Gold: 30,
  Estate: 8,
  Duchy: 8,
  Province: 8,
  Curse: 10,
  Village: 10,
  Smithy: 10,
  Laboratory: 10,
  Festival: 10,
  Market: 10,
  Woodcutter: 10,
  CouncilRoom: 10,
  Witch: 10,
  Militia: 10,
  Moat: 10,
  Chapel: 10,
  Workshop: 10,
};

function baseObservation(overrides: Partial<DominionObservation>): DominionObservation {
  return {
    self: 0,
    active: 0,
    phase: 'buy',
    actions: 0,
    buys: 1,
    coins: 0,
    supply: FULL_SUPPLY,
    kingdomCards: ['Village', 'Witch', 'Laboratory', 'Chapel', 'Workshop'],
    pending: null,
    trash: [],
    own: {
      hand: [],
      discard: [],
      play: [],
      deckCount: 5,
      deckComposition: {},
      turnsTaken: 1,
    },
    opponent: {
      handCount: 5,
      discard: [],
      play: [],
      deckCount: 5,
      turnsTaken: 1,
    },
    ...overrides,
  };
}

describe('dominionMidBot determinism (C1)', () => {
  it('returns the same decision for the same seed and observation, repeated', () => {
    const bot1 = dominionMidBot(9);
    const bot2 = dominionMidBot(9);
    const legal: DominionChoice[] = [{ kind: 'buy', card: 'Silver' }, { kind: 'endBuy' }];
    const observation = baseObservation({ coins: 3 });
    expect(bot1.decide('buy', observation, legal)).toEqual(bot2.decide('buy', observation, legal));
  });
});

describe('dominionMidBot — buy priority', () => {
  it('buys Province the instant it is affordable, ahead of Gold', () => {
    const bot = dominionMidBot(1);
    const legal: DominionChoice[] = [
      { kind: 'buy', card: 'Gold' },
      { kind: 'buy', card: 'Province' },
      { kind: 'endBuy' },
    ];
    const choice = bot.decide('buy', baseObservation({ coins: 8 }), legal);
    expect(choice).toEqual({ kind: 'buy', card: 'Province' });
  });

  it('buys Witch over Laboratory at 5 coins while Curses remain', () => {
    const bot = dominionMidBot(2);
    const legal: DominionChoice[] = [
      { kind: 'buy', card: 'Laboratory' },
      { kind: 'buy', card: 'Witch' },
      { kind: 'endBuy' },
    ];
    const choice = bot.decide('buy', baseObservation({ coins: 5 }), legal);
    expect(choice).toEqual({ kind: 'buy', card: 'Witch' });
  });

  it('falls back to Laboratory once the Curse supply is exhausted', () => {
    const bot = dominionMidBot(3);
    const legal: DominionChoice[] = [
      { kind: 'buy', card: 'Laboratory' },
      { kind: 'buy', card: 'Witch' },
      { kind: 'endBuy' },
    ];
    const choice = bot.decide('buy', baseObservation({ coins: 5, supply: { ...FULL_SUPPLY, Curse: 0 } }), legal);
    expect(choice).toEqual({ kind: 'buy', card: 'Laboratory' });
  });

  it('every decision stays within the legal set', () => {
    const bot = dominionMidBot(4);
    const legal: DominionChoice[] = [{ kind: 'endBuy' }];
    const choice = bot.decide('buy', baseObservation({ coins: 0 }), legal);
    expect(legal).toContainEqual(choice);
  });
});
