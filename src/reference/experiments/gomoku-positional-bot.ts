/**
 * gomoku-positional-bot — L3 홀드아웃 앵커 ('external-style2-l3').
 *
 * 설계 시 L2(gomoku-opus-bot.ts) 소스를 참조하지 않았다 (GAP-11 D3 / docs/adr/0012):
 * L1(중수)·L2(Opus봇)와 독립적인 "제3의 스타일"이어야 판정용 홀드아웃으로서
 * 의미가 있기 때문이다. 그래서 즉승/차단 판정조차 gomoku.ts의 비공개 헬퍼를
 * 재사용하지 않고 이 파일 안에서 독립적으로 구현한다.
 *
 * 스타일: 위협(열린 3/4) 스코어링이 아니라 "영역·잠재 라인 카운팅".
 *   1) 안전망 — 자기 즉승 > 상대 즉승 차단.
 *   2) 본체 — 후보 칸을 지나는 길이-5 윈도우 중 상대 돌이 없는(= 아직 살아있는)
 *      윈도우들을 세고, 각 윈도우의 자기 돌 수 + 1 로 가중합한다. 상대 시점의
 *      같은 값(= 내가 두어 빼앗는 잠재력)에 0.8 가중치를 더한다.
 *   3) 타이브레이크 — 자기 돌 무게중심에 가까운 칸(응집) → (row, col) 오름차순.
 *
 * 완전 결정론(순수 함수). Date.now()/Math.random() 미사용, RNG조차 불필요.
 */

import type { BotFactory, PlayerId } from '../../contract/types';
import { BOARD_SIZE, type Cell, type GomokuChoice, type GomokuObservation } from '../gomoku';

const WIN_LENGTH = 5;
const CENTER = 7;
const OPP_WEIGHT = 0.8;

/** 4 directions: horizontal, vertical, and both diagonals. */
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

function cellOf(player: PlayerId): Cell {
  return player === 0 ? 1 : 2;
}

function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function at(board: readonly Cell[], row: number, col: number): Cell {
  return board[row * BOARD_SIZE + col] as Cell;
}

/** True when placing `stone` at (row, col) completes WIN_LENGTH or more in a row. */
function completesLine(board: readonly Cell[], row: number, col: number, stone: Cell): boolean {
  for (const [dr, dc] of DIRECTIONS) {
    let run = 1;
    for (const sign of [1, -1] as const) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (inBounds(r, c) && at(board, r, c) === stone) {
        run += 1;
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (run >= WIN_LENGTH) return true;
  }
  return false;
}

/**
 * Potential of (row, col) for `stone`: over every length-5 window through the
 * cell, count the windows free of the other stone, weighted by (own stones in
 * window + 1).
 */
function potential(board: readonly Cell[], row: number, col: number, stone: Cell, other: Cell): number {
  let total = 0;
  for (const [dr, dc] of DIRECTIONS) {
    for (let offset = 0; offset < WIN_LENGTH; offset += 1) {
      const startRow = row - dr * offset;
      const startCol = col - dc * offset;
      const endRow = startRow + dr * (WIN_LENGTH - 1);
      const endCol = startCol + dc * (WIN_LENGTH - 1);
      if (!inBounds(startRow, startCol) || !inBounds(endRow, endCol)) continue;

      let own = 0;
      let blocked = false;
      for (let k = 0; k < WIN_LENGTH; k += 1) {
        const value = at(board, startRow + dr * k, startCol + dc * k);
        if (value === other) {
          blocked = true;
          break;
        }
        if (value === stone) own += 1;
      }
      if (!blocked) total += own + 1;
    }
  }
  return total;
}

/** Centroid of own stones; board center when the player has no stone yet. */
function centroid(board: readonly Cell[], stone: Cell): readonly [number, number] {
  let rowSum = 0;
  let colSum = 0;
  let count = 0;
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (at(board, row, col) === stone) {
        rowSum += row;
        colSum += col;
        count += 1;
      }
    }
  }
  if (count === 0) return [CENTER, CENTER];
  return [rowSum / count, colSum / count];
}

function distanceSquared(row: number, col: number, anchor: readonly [number, number]): number {
  const dr = row - anchor[0];
  const dc = col - anchor[1];
  return dr * dr + dc * dc;
}

/** Deterministic ordering: score desc → centroid distance asc → row asc → col asc. */
function better(
  candidate: { score: number; distance: number; move: GomokuChoice },
  best: { score: number; distance: number; move: GomokuChoice },
): boolean {
  if (candidate.score !== best.score) return candidate.score > best.score;
  if (candidate.distance !== best.distance) return candidate.distance < best.distance;
  if (candidate.move.row !== best.move.row) return candidate.move.row < best.move.row;
  return candidate.move.col < best.move.col;
}

export const gomokuPositionalBot: BotFactory<GomokuObservation, GomokuChoice> = (_seed) => ({
  id: 'gomoku-positional-l3',
  decide(_decisionPoint, observation, legal) {
    const board = observation.board;
    const mine = cellOf(observation.self);
    const theirs: Cell = mine === 1 ? 2 : 1;

    // 1) Safety net: own immediate win first, then block the opponent's.
    let block: GomokuChoice | null = null;
    for (const move of legal) {
      if (completesLine(board, move.row, move.col, mine)) return move;
      if (block === null && completesLine(board, move.row, move.col, theirs)) block = move;
    }
    if (block !== null) return block;

    // 2) Latent-line counting.
    const anchor = centroid(board, mine);
    let best: { score: number; distance: number; move: GomokuChoice } | null = null;
    for (const move of legal) {
      const score =
        potential(board, move.row, move.col, mine, theirs) +
        OPP_WEIGHT * potential(board, move.row, move.col, theirs, mine);
      const entry = { score, distance: distanceSquared(move.row, move.col, anchor), move };
      if (best === null || better(entry, best)) best = entry;
    }
    return best === null ? (legal[0] as GomokuChoice) : best.move;
  },
});
