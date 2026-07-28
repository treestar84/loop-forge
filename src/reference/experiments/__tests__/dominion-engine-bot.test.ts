import { dominionEngineBot } from '../dominion-engine-bot';
import type { CardName, DominionChoice, DominionObservation } from '../../dominion';

const FULL_SUPPLY: Record<CardName, number> = {
  Copper: 46,
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

const KINGDOM: readonly CardName[] = [
  'Village',
  'Smithy',
  'Laboratory',
  'Festival',
  'Market',
  'Woodcutter',
  'CouncilRoom',
  'Witch',
  'Militia',
  'Moat',
];

function observation(overrides: {
  readonly phase?: 'action' | 'buy';
  readonly coins?: number;
  readonly provinceLeft?: number;
  readonly hand?: readonly CardName[];
  readonly discard?: readonly CardName[];
}): DominionObservation {
  const provinceLeft = overrides.provinceLeft ?? 8;
  return {
    self: 0,
    active: 0,
    phase: overrides.phase ?? 'buy',
    actions: 1,
    buys: 1,
    coins: overrides.coins ?? 0,
    supply: { ...FULL_SUPPLY, Province: provinceLeft },
    kingdomCards: KINGDOM,
    pending: null,
    trash: [],
    own: {
      hand: overrides.hand ?? [],
      discard: overrides.discard ?? [],
      play: [],
      deckCount: 5,
      deckComposition: { Copper: 4, Estate: 1 },
      turnsTaken: 3,
    },
    opponent: { handCount: 5, discard: [], play: [], deckCount: 5, turnsTaken: 3 },
  };
}

function buys(...cards: readonly CardName[]): DominionChoice[] {
  return [{ kind: 'endBuy' }, ...cards.map((card) => ({ kind: 'buy', card }) as const)];
}

describe('dominionEngineBot', () => {
  it('is deterministic across instances built from the same seed', () => {
    const a = dominionEngineBot(7);
    const b = dominionEngineBot(7);
    const cases: readonly (readonly [string, DominionObservation, DominionChoice[]])[] = [
      ['buy', observation({ coins: 6 }), buys('Copper', 'Silver', 'Gold', 'Estate', 'Duchy', 'Village', 'Smithy')],
      ['buy', observation({ coins: 5, provinceLeft: 3 }), buys('Copper', 'Silver', 'Estate', 'Duchy', 'Laboratory')],
      [
        'action',
        observation({ phase: 'action', hand: ['Village', 'Smithy', 'Militia'] }),
        [
          { kind: 'endActions' },
          { kind: 'playAction', card: 'Village' },
          { kind: 'playAction', card: 'Smithy' },
          { kind: 'playAction', card: 'Militia' },
        ],
      ],
      [
        'chapelTrash',
        observation({ hand: ['Estate', 'Copper'] }),
        [{ kind: 'doneTrash' }, { kind: 'trashCard', card: 'Estate' }, { kind: 'trashCard', card: 'Copper' }],
      ],
    ];
    for (const [point, obs, legal] of cases) {
      expect(a.decide(point, obs, legal)).toEqual(b.decide(point, obs, legal));
    }
  });

  it('exposes a stable id and ignores the seed', () => {
    expect(dominionEngineBot(1).id).toBe('dominion-engine-l3');
    const legal = buys('Copper', 'Silver', 'Gold', 'Estate');
    const obs = observation({ coins: 6 });
    expect(dominionEngineBot(1).decide('buy', obs, legal)).toEqual(
      dominionEngineBot(999).decide('buy', obs, legal),
    );
  });

  it('buys economy in the growth phase and greens in the endgame from the same coins', () => {
    const bot = dominionEngineBot(3);
    const legal = buys('Copper', 'Silver', 'Estate', 'Duchy', 'Laboratory', 'Market');

    const growth = bot.decide('buy', observation({ coins: 5, provinceLeft: 8 }), legal);
    expect(growth).toEqual({ kind: 'buy', card: 'Laboratory' }); // dearest drawing action (tie at cost 5 -> alphabetical)

    const endgame = bot.decide('buy', observation({ coins: 5, provinceLeft: 3 }), legal);
    expect(endgame).toEqual({ kind: 'buy', card: 'Duchy' });
  });

  it('never buys a victory card while growing', () => {
    const bot = dominionEngineBot(3);
    const choice = bot.decide('buy', observation({ coins: 2, provinceLeft: 8 }), buys('Copper', 'Estate', 'Chapel'));
    expect(choice).toEqual({ kind: 'endBuy' });
  });

  it('takes Province over everything once the pile is short', () => {
    const bot = dominionEngineBot(3);
    const choice = bot.decide(
      'buy',
      observation({ coins: 8, provinceLeft: 2 }),
      buys('Copper', 'Silver', 'Gold', 'Estate', 'Duchy', 'Province'),
    );
    expect(choice).toEqual({ kind: 'buy', card: 'Province' });
  });

  it('plays drawing actions before coin actions, cheapest first', () => {
    const bot = dominionEngineBot(3);
    const legal: DominionChoice[] = [
      { kind: 'endActions' },
      { kind: 'playAction', card: 'Smithy' },
      { kind: 'playAction', card: 'Village' },
      { kind: 'playAction', card: 'Festival' },
    ];
    expect(bot.decide('action', observation({ phase: 'action' }), legal)).toEqual({
      kind: 'playAction',
      card: 'Village',
    });

    const coinOnly: DominionChoice[] = [
      { kind: 'endActions' },
      { kind: 'playAction', card: 'Festival' },
      { kind: 'playAction', card: 'Woodcutter' },
      { kind: 'playAction', card: 'Chapel' },
    ];
    expect(bot.decide('action', observation({ phase: 'action' }), coinOnly)).toEqual({
      kind: 'playAction',
      card: 'Woodcutter',
    });
  });

  it('trashes Curse then Estate, and keeps a Copper floor', () => {
    const bot = dominionEngineBot(3);
    const legal: DominionChoice[] = [
      { kind: 'doneTrash' },
      { kind: 'trashCard', card: 'Copper' },
      { kind: 'trashCard', card: 'Estate' },
      { kind: 'trashCard', card: 'Curse' },
    ];
    expect(bot.decide('chapelTrash', observation({ hand: ['Copper', 'Estate', 'Curse'] }), legal)).toEqual({
      kind: 'trashCard',
      card: 'Curse',
    });

    const copperOnly: DominionChoice[] = [{ kind: 'doneTrash' }, { kind: 'trashCard', card: 'Copper' }];
    // deckComposition has 4 Coppers + 1 in hand = 5 owned > floor of 3 -> trash.
    expect(bot.decide('chapelTrash', observation({ hand: ['Copper'] }), copperOnly)).toEqual({
      kind: 'trashCard',
      card: 'Copper',
    });
    // Down to 3 owned Coppers (1 in hand, 2 in deck) -> stop trashing.
    const poor = {
      ...observation({ hand: ['Copper'] }),
      own: { ...observation({ hand: ['Copper'] }).own, deckComposition: { Copper: 2 } },
    };
    expect(bot.decide('chapelTrash', poor, copperOnly)).toEqual({ kind: 'doneTrash' });
  });

  it('gains the dearest offered card and discards dead cards first', () => {
    const bot = dominionEngineBot(3);
    const gains: DominionChoice[] = [
      { kind: 'gainCard', card: 'Silver' },
      { kind: 'gainCard', card: 'Smithy' },
      { kind: 'gainCard', card: 'Estate' },
    ];
    expect(bot.decide('workshopGain', observation({}), gains)).toEqual({ kind: 'gainCard', card: 'Smithy' });

    const discards: DominionChoice[] = [
      { kind: 'discardCard', card: 'Gold' },
      { kind: 'discardCard', card: 'Estate' },
      { kind: 'discardCard', card: 'Copper' },
    ];
    expect(bot.decide('militiaDiscard', observation({}), discards)).toEqual({
      kind: 'discardCard',
      card: 'Estate',
    });
  });
});
