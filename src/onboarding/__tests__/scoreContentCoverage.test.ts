/**
 * X2 (docs/GAP-ANALYSIS-2.md): content coverage. Wraps mini-trick with a
 * contentInventory of its 16 card ids and an exercisedContent that reports
 * which cards were actually played (everything except the 4-card hidden
 * stock, which sits out every game). Verifies the C2 coverage report, the
 * "declared inventory but no exercisedContent" blocker, and the "unknown id"
 * integrity blocker.
 */

import { eraseAdapter } from '../../loop/erase';
import {
  miniTrickAdapter,
  type MiniTrickCard,
  type MiniTrickState,
} from '../../reference/mini-trick';
import { scoreAdapter } from '../score';

function cardKey(card: MiniTrickCard): string {
  return `${card.suit}${card.rank}`;
}

const SUITS = ['A', 'B'] as const;
const RANKS = [1, 2, 3, 4, 5, 6, 7, 8];
const CONTENT_INVENTORY = SUITS.flatMap((suit) =>
  RANKS.map((rank) => ({ id: cardKey({ suit, rank }), description: `card ${suit}${rank}` })),
);

function exercisedContent(finalState: MiniTrickState): readonly string[] {
  const stockKeys = new Set(finalState.stock.map(cardKey));
  return CONTENT_INVENTORY.map((entry) => entry.id).filter((id) => !stockKeys.has(id));
}

const adapter = eraseAdapter(miniTrickAdapter);

describe('scoreAdapter — content coverage (X2)', () => {
  it('reports a high coverage percentage and no uncovered-content blocker across many playouts', () => {
    const withCoverage = eraseAdapter({
      ...miniTrickAdapter,
      contentInventory: CONTENT_INVENTORY,
      exercisedContent,
    });
    const report = scoreAdapter(withCoverage, { threshold: 65, c2Playouts: 150 });
    const c2 = report.axes.find((a) => a.axis === 'C2-integrity');
    expect(c2?.blockers.some((b) => b.code === 'C2_CONTENT_COVERAGE_TOO_LOW')).toBe(false);
    expect(c2?.blockers.some((b) => b.code === 'C2_CONTENT_INVENTORY_WITHOUT_EXERCISED')).toBe(false);
    expect(c2?.notes.some((note) => note.includes('콘텐츠 커버리지'))).toBe(true);
  }, 20_000);

  it('notes that coverage is unmeasured when contentInventory is not declared', () => {
    const report = scoreAdapter(adapter, { threshold: 65 });
    const c2 = report.axes.find((a) => a.axis === 'C2-integrity');
    expect(c2?.notes.some((note) => note.includes('콘텐츠 커버리지 미측정'))).toBe(true);
  }, 20_000);

  it('blocks C2 when contentInventory is declared without exercisedContent', () => {
    const withoutExercised = eraseAdapter({
      ...miniTrickAdapter,
      contentInventory: CONTENT_INVENTORY,
    });
    const report = scoreAdapter(withoutExercised, { threshold: 65 });
    const c2 = report.axes.find((a) => a.axis === 'C2-integrity');
    expect(c2?.blockers.some((b) => b.code === 'C2_CONTENT_INVENTORY_WITHOUT_EXERCISED')).toBe(true);
    expect(report.ready).toBe(false);
  }, 20_000);

  it('blocks C2 when exercisedContent returns an id absent from contentInventory', () => {
    const withUnknownId = eraseAdapter({
      ...miniTrickAdapter,
      contentInventory: CONTENT_INVENTORY,
      exercisedContent: (finalState: MiniTrickState): readonly string[] => [
        ...exercisedContent(finalState),
        'Z9-not-in-inventory',
      ],
    });
    const report = scoreAdapter(withUnknownId, { threshold: 65, c2Playouts: 10 });
    const c2 = report.axes.find((a) => a.axis === 'C2-integrity');
    expect(c2?.blockers.some((b) => b.code === 'C2_CONTENT_UNKNOWN_ID')).toBe(true);
    expect(report.ready).toBe(false);
  }, 20_000);
});
