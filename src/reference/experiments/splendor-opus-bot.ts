/**
 * Opus 설계봇 (splendor) — docs/BENCHMARK-EXPERIMENT.md의 A/C 컬럼용 비교 대상.
 *
 * 이 파일은 Loop Forge 파이프라인의 산출물이 *아니다*. "게임 규칙·관찰 타입·합법수만
 * 보고 LLM(Opus)이 즉흥적으로 한 번에 설계한 휴리스틱 봇"을 성문화한 것으로, 채점·
 * 웨이브·게이트를 전혀 거치지 않았다. 어댑터의 strategySurface나 baselines에는 넣지
 * 않는다(개념적으로 분리 보관 — reference/experiments/ 접두어).
 *
 * 레이어 규칙: reference → contract, kernel(+ 동일 레이어 splendor.ts 타입). 무작위성은
 * createRng만 사용(Date.now/Math.random 금지). 결정론적 BotFactory이므로 rng는 완전
 * 동점(값·비용·id까지 같은 경우) 상황의 최종 타이브레이크에만 쓴다.
 *
 * 설계 요지 (baselines.heuristic의 "무조건 최저비용 카드 구매"보다 나은 목표):
 *   1. 카드 가치 = 점수(가중 큼) + 색 파워 할인 효용 + 근접 노블 기여도. 단순 최저비용이
 *      아니라 이 복합 가치로 구매를 고른다.
 *   2. 목표 카드(target) = 아직 못 사지만 가치가 가장 높은(그리고 가장 가까운) 카드.
 *      젬 획득은 이 목표의 색별 부족분을 메우는 방향으로만 한다(무의미한 젬 축적으로
 *      10개 상한에 걸려 버리는 낭비를 피함).
 *   3. 예약은 "보드의 고득점(>=4) 3티어 카드 + 뱅크에 금(gold) 남음 + 예약 슬롯 여유 +
 *      당장 점수 나는 구매 없음"일 때만 — 폭탄 카드 선점 + 금 확보. 남발 금지.
 *   4. take 연속 국면에서는 목표 부족분을 실제로 줄이는 색만 계속 집고, 더 도움되는
 *      색이 없으면 즉시 takeDone(초과 젬 → 강제 버림 회피).
 */

import type { BotFactory } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type {
  Color,
  Level,
  PlayerState,
  SplendorCard,
  SplendorChoice,
  SplendorObservation,
} from '../splendor';

const COLORS: readonly Color[] = ['w', 'u', 'g', 'r', 'b'];

/** 색 파워 = 그 색 젬 수 + 그 색 카드 수(카드는 영구 할인). */
function power(player: PlayerState, color: Color): number {
  return player.gems[color] + player.cards[color].length;
}

function cardCount(player: PlayerState, color: Color): number {
  return player.cards[color].length;
}

/** 이 카드를 사려면 부족한 금(gold) 수. gold 보유량 이하이면 구매 가능. */
function goldOwed(player: PlayerState, card: SplendorCard): number {
  let owed = 0;
  for (const c of COLORS) {
    const deficit = card.cost[c] - power(player, c);
    if (deficit > 0) owed += deficit;
  }
  return owed;
}

function affordable(player: PlayerState, card: SplendorCard): boolean {
  return goldOwed(player, card) <= player.gems.gold;
}

/** 목표 카드까지 색별로 실제로 더 있어야 하는 젬 수(카드 할인 반영). */
function colorNeeds(player: PlayerState, card: SplendorCard): Record<Color, number> {
  const needs = { w: 0, u: 0, g: 0, r: 0, b: 0 } as Record<Color, number>;
  for (const c of COLORS) {
    const deficit = card.cost[c] - power(player, c);
    needs[c] = deficit > 0 ? deficit : 0;
  }
  return needs;
}

/**
 * 카드 복합 가치. 구매 선택과 목표 선정 양쪽에 쓴다.
 * - 점수: 가장 크게 가중(승리는 15점).
 * - 할인 효용: 새 색(보유 0~1장)일수록 미래 비용 절감 폭이 커서 가치↑.
 * - 노블 기여: 아직 못 채운 노블 요구 색이면 가산.
 */
function cardValue(
  card: SplendorCard,
  player: PlayerState,
  nobles: SplendorObservation['nobles'],
): number {
  let v = card.points * 2.5;
  const owned = cardCount(player, card.color);
  v += Math.max(0, 2 - owned) * 0.8; // 새 색 우선(할인 효용 체감)
  for (const noble of nobles) {
    const req = noble.requirement[card.color];
    if (req > 0 && owned < req) v += 1.4; // 미달 노블 요구 색 진전
  }
  return v;
}

function findCard(observation: SplendorObservation, cardId: string): SplendorCard | undefined {
  for (const level of [1, 2, 3] as Level[]) {
    const found = observation.board[level].find((c) => c.id === cardId);
    if (found) return found;
  }
  return observation.players[observation.self]!.reserved.find((c) => c.id === cardId);
}

/** 아직 못 사는 카드 중 가치 최고(동률이면 가장 가까운=goldOwed 최소) — 젬 획득 방향타. */
function pickTarget(
  observation: SplendorObservation,
  player: PlayerState,
): SplendorCard | undefined {
  const candidates: SplendorCard[] = [];
  for (const level of [1, 2, 3] as Level[]) {
    for (const card of observation.board[level]) {
      if (!affordable(player, card)) candidates.push(card);
    }
  }
  for (const card of player.reserved) {
    if (!affordable(player, card)) candidates.push(card);
  }
  if (candidates.length === 0) return undefined;
  return candidates
    .map((card) => ({ card, value: cardValue(card, player, observation.nobles), owed: goldOwed(player, card) }))
    .sort(
      (a, b) =>
        b.value - a.value || a.owed - b.owed || (a.card.id < b.card.id ? -1 : 1),
    )[0]!.card;
}

export const splendorOpusBot: BotFactory<SplendorObservation, SplendorChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'splendor-opus',
    decide(decisionPoint, observation, legal) {
      const player = observation.players[observation.self]!;

      // --- noble: 모두 3점이므로 결정론적으로 하나 고른다. ---
      if (decisionPoint === 'noble') {
        const nobleChoices = legal.filter(
          (c): c is Extract<SplendorChoice, { kind: 'noble' }> => c.kind === 'noble',
        );
        const sorted = [...nobleChoices].sort((a, b) => (a.nobleId < b.nobleId ? -1 : 1));
        return (sorted[0] ?? legal[0]) as SplendorChoice;
      }

      const target = pickTarget(observation, player);
      const needs = target ? colorNeeds(player, target) : ({ w: 0, u: 0, g: 0, r: 0, b: 0 } as Record<Color, number>);

      // --- take 연속 국면: 목표 부족분을 줄이는 색만 계속, 아니면 takeDone. ---
      if (decisionPoint === 'take') {
        const takes = legal.filter(
          (c): c is Extract<SplendorChoice, { kind: 'take' }> => c.kind === 'take',
        );
        const helpful = takes
          .filter((c) => needs[c.color] > 0)
          .sort((a, b) => needs[b.color] - needs[a.color] || observation.bank[b.color] - observation.bank[a.color]);
        if (helpful.length > 0) return helpful[0]!;
        const done = legal.find((c) => c.kind === 'takeDone');
        if (done) return done;
        // takeDone이 없다면(첫 젬 직후 등) 그나마 뱅크 많은 색.
        const byBank = [...takes].sort((a, b) => observation.bank[b.color] - observation.bank[a.color]);
        return (byBank[0] ?? legal[0]) as SplendorChoice;
      }

      // === action 국면 ===

      // 1) 구매: 가치 최고의 살 수 있는 카드. 점수>0 또는 노블/할인에 실질 기여할 때만.
      const buys = legal.filter(
        (c): c is Extract<SplendorChoice, { kind: 'buy' }> => c.kind === 'buy',
      );
      if (buys.length > 0) {
        const ranked = buys
          .map((c) => {
            const card = findCard(observation, c.cardId);
            return { choice: c, card, value: card ? cardValue(card, player, observation.nobles) : 0 };
          })
          .sort((a, b) => b.value - a.value || (a.choice.cardId < b.choice.cardId ? -1 : 1));
        const best = ranked[0]!;
        const points = best.card?.points ?? 0;
        const newColorDiscount = best.card ? cardCount(player, best.card.color) < 2 : false;
        // 점수 나는 카드나 노블/할인 기여 카드는 즉시 구매. 순수 무가치 필러(value<1.6)는
        // 젬을 모아 더 큰 카드를 노리는 편이 나으므로 아래 take/reserve로 넘긴다.
        if (points >= 1 || best.value >= 1.6 || newColorDiscount) {
          return best.choice;
        }
      }

      // 2) 예약: 보드의 고득점(>=4) 3티어 폭탄 + 금 확보. 조건 좁게.
      const reserves = legal.filter(
        (c): c is Extract<SplendorChoice, { kind: 'reserve' }> => c.kind === 'reserve',
      );
      if (reserves.length > 0 && observation.bank.gold > 0 && player.reserved.length < 2) {
        const bombs = reserves
          .map((c) => ({ choice: c, card: findCard(observation, c.cardId) }))
          .filter((x) => x.card && x.card.level === 3 && x.card.points >= 4 && !affordable(player, x.card))
          .sort((a, b) => (b.card!.points - a.card!.points) || (a.choice.cardId < b.choice.cardId ? -1 : 1));
        if (bombs.length > 0) return bombs[0]!.choice;
      }

      // 3) 젬 획득: 목표 부족분이 큰 색부터(뱅크에 있는 것만).
      const takes = legal.filter(
        (c): c is Extract<SplendorChoice, { kind: 'take' }> => c.kind === 'take',
      );
      if (takes.length > 0) {
        const needed = takes
          .filter((c) => needs[c.color] > 0 && observation.bank[c.color] > 0)
          .sort((a, b) => needs[b.color] - needs[a.color] || observation.bank[b.color] - observation.bank[a.color]);
        if (needed.length > 0) return needed[0]!;
        // 목표가 없거나 다 채웠으면 뱅크 많은 색으로 범용 진전.
        const byBank = [...takes].sort((a, b) => observation.bank[b.color] - observation.bank[a.color]);
        return byBank[0]!;
      }

      // 4) 강제 버림(10젬): 목표에 불필요한 색을 많이 가진 것부터, gold는 최후.
      const discards = legal.filter(
        (c): c is Extract<SplendorChoice, { kind: 'discard' }> => c.kind === 'discard',
      );
      if (discards.length > 0) {
        const ranked = discards
          .map((c) => {
            const need = c.gem === 'gold' ? 999 : needs[c.gem as Color];
            const hold = player.gems[c.gem];
            const goldPenalty = c.gem === 'gold' ? 1000 : 0;
            return { choice: c, sortKey: goldPenalty + need * 100 - hold };
          })
          .sort((a, b) => a.sortKey - b.sortKey);
        return ranked[0]!.choice;
      }

      // 5) 그 외(예: 필러 구매만 남은 경우) — 남은 buy 중 최고가치, 아니면 임의.
      if (buys.length > 0) {
        const ranked = buys
          .map((c) => {
            const card = findCard(observation, c.cardId);
            return { choice: c, value: card ? cardValue(card, player, observation.nobles) : 0 };
          })
          .sort((a, b) => b.value - a.value);
        return ranked[0]!.choice;
      }
      return legal[rng.nextInt(legal.length)] as SplendorChoice;
    },
  };
};
