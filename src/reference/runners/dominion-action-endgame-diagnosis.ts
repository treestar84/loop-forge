/**
 * dominion-action-endgame-diagnosis — GAP-11 "도미니언 action 페이즈 종료/
 * 터미널 선택 축" 1단계 진단 (main-loop design spec:
 * scratchpad/dominion-action-endgame-design-spec.md). **순수 분석, 코드
 * 로직 변경 없음** — `src/reference/dominion.ts`/`loop/loss-mining.ts` 등
 * 기존 코드는 전혀 건드리지 않는다.
 *
 * 배경: A4(논터미널 우선순위 위반) 가설은 8.1%로 기각됐다
 * (`docs/GAP-11-ROUNDS.md`의 "도미니언 A4 루트 오버라이드" 섹션). 그 검증
 * 과정에서 드러난 action divergence 727건의 실제 구성 — `endActions` 319건
 * (43.9%), `playAction:Moat` 227건, `playAction:Witch` 152건,
 * `playAction:CouncilRoom` 29건 — 을 이 러너가 진단한다:
 *   1. Moat/Witch/CouncilRoom 각각의 divergence 방향성(v6 후보가 그 카드를
 *      더 자주 냈는지, L2 앵커가 더 자주 냈는지).
 *   2. Moat "방어 실패 상관관계": candidate가 Moat를 즉시 소모(play)한 턴
 *      vs 손에 든 채 그 턴을 마친(보류한) 턴 각각에 대해, 그 직후 상대
 *      턴에 Witch/Militia 공격이 발생했다면 막혔는지(defender 손에 Moat가
 *      있었는지)를 실제 게임 상태로 집계.
 *   3. `endActions` 319건: 그 시점에 legal에 다른 playAction 대안이
 *      있었는지, 그 대안이 논터미널/터미널 중 무엇이었는지, 그리고 어느
 *      쪽(candidate/anchor)이 더 일찍 끝냈는지.
 *
 * §1/§3은 `dominion-a4-hypothesis-check.ts`의
 * `checkNonTerminalFirstHypothesis` 재생 패턴(`mineLosses`의 재생 루프를
 * 재구현, 같은 anchorSeedBase 파생 규약 — `${gameSeed}:${decisionIndex}`
 * fork key)을 그대로 확장한다. §2(Moat 상관관계)는 anchor가 전혀 필요 없는
 * **실제 트래젝토리** 재생(`record.choices`/`record.deciders`, 양쪽
 * 플레이어의 실제 수)이므로, erasure를 거치지 않은 typed `dominionAdapter`를
 * 직접 사용한다 — `dominion.ts`의 `cleanupAndAdvance`(566-585줄)가 매 턴
 * 종료 시 손패+플레이 영역 전체를 discard하고 5장을 새로 뽑는다는 사실이
 * 이번 진단의 핵심 전제다: 이번 턴에 Moat를 냈든 안 냈든, "다음 상대 턴에
 * 실제로 방어에 쓰이는 손"은 이번 턴 cleanup에서 새로 뽑은 5장이므로 이번
 * 턴의 play/hold 결정과 무관하게 그 턴의 드로우 운으로 결정된다 — 이 코드
 * 읽기만으로 내린 추론이 아니라, 실제 트래젝토리 데이터로 이 예측이
 * 맞는지 검증한다(played 그룹과 held 그룹의 공격 관철율을 직접 비교).
 *
 * Seeds: `dominion-mirror-draw-diagnosis.ts`/`dominion-a4-hypothesis-check.ts`
 * 와 완전히 동일(450,000+/N=100, bot base 996_101/996_201) — 같은
 * 트래젝토리 집합을 재도출하는 순수 재분석이므로 새 게임을 플레이하지
 * 않는다(설계 스펙의 "재생 인프라를 재사용/확장" 지시).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import type { AnyBotFactory, AnyGameAdapter } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { mineLosses, type LossReport } from '../../loop/loss-mining';
import type { MatchTrajectoryRecord } from '../../loop/paired-match';
import { dominionAdapter, type DominionChoice, type DominionState } from '../dominion';
import { dominionOpusBot } from '../experiments/dominion-opus-bot';
import { dominionIsmctsV2BuyPriorFlagSpec, DOMINION_V5_CHAMPION_FLAG } from './shared/dominion-round4-candidates';

const GAME_ID = 'dominion';
const CANDIDATE_FLAG = DOMINION_V5_CHAMPION_FLAG;

const N = 100;
const SEED_BASE_M1 = 450_000;

const BOT_SEED_BASE = {
  m1: 996_101,
  mine: 996_201,
} as const;

/** Same convention as loop/loss-mining.ts's internal BOT_SEED_SPACE. */
const BOT_SEED_SPACE = 2 ** 31;

/** Same fixed rules fact dominion-a4-hypothesis-check.ts hardcodes (dominion.ts CARD_DEFS is not exported). */
const NON_TERMINAL_ACTION_CARDS = new Set(['Village', 'Laboratory', 'Festival', 'Market']);
const ATTACK_CARDS = new Set(['Witch', 'Militia']);

function seeds(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function ci(result: HeadToHeadResult): string {
  return `${pct(result.winRateCI.lower)}-${pct(result.winRateCI.upper)}`;
}

function isCandidateLoss(record: MatchTrajectoryRecord): boolean {
  return record.outcome.winner !== null && record.outcome.winner !== record.candidateSeat;
}

// --- §1/§3: action divergence direction + endActions detail --------------

interface DirectionStats {
  byCandidate: number;
  byAnchor: number;
}

interface EndActionsCase {
  readonly direction: 'candidateEndsEarly' | 'anchorEndsEarly';
  readonly gameSeed: number;
  readonly decisionIndex: number;
  readonly otherSideCard: string;
  readonly otherSideIsTerminal: boolean;
  readonly legalPlayActionCount: number;
}

interface DivergenceDirectionResult {
  readonly actionDivergences: number;
  readonly cardDirection: Readonly<Record<'Moat' | 'Witch' | 'CouncilRoom', DirectionStats>>;
  readonly endActions: {
    readonly candidateEndsEarly: number;
    readonly anchorEndsEarly: number;
    readonly total: number;
    readonly casesWithNoAlternative: number;
    readonly alternativeIsNonTerminalCount: number;
    readonly alternativeIsTerminalCount: number;
    readonly sampleCases: readonly EndActionsCase[];
  };
}

/**
 * Reimplements mineLosses's replay loop verbatim (same as
 * dominion-a4-hypothesis-check.ts's checkNonTerminalFirstHypothesis), but
 * classifies every `action` divergence by which card/decision each side
 * picked instead of testing a single hypothesis.
 */
function analyzeActionDivergenceDirections(
  adapter: AnyGameAdapter,
  records: readonly MatchTrajectoryRecord[],
  anchorFactory: AnyBotFactory,
  anchorSeedBase: number,
): DivergenceDirectionResult {
  const rootRng = createRng(anchorSeedBase);

  let actionDivergences = 0;
  const cardDirection: Record<'Moat' | 'Witch' | 'CouncilRoom', DirectionStats> = {
    Moat: { byCandidate: 0, byAnchor: 0 },
    Witch: { byCandidate: 0, byAnchor: 0 },
    CouncilRoom: { byCandidate: 0, byAnchor: 0 },
  };
  let candidateEndsEarly = 0;
  let anchorEndsEarly = 0;
  let casesWithNoAlternative = 0;
  let alternativeIsNonTerminalCount = 0;
  let alternativeIsTerminalCount = 0;
  const endActionsSamples: EndActionsCase[] = [];

  for (const record of records) {
    if (!isCandidateLoss(record)) continue;

    let state = adapter.createInitialState(record.gameSeed);

    for (let decisionIndex = 0; decisionIndex < record.choices.length; decisionIndex += 1) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      const legal = adapter.getLegalChoices(state);
      if (legal.length === 0) break;

      const candidateChoiceKey = record.choices[decisionIndex] as string;
      const decider = record.deciders[decisionIndex];

      if (decider === record.candidateSeat && decision.decisionPoint === 'action') {
        const anchorSeed = rootRng.fork(`${record.gameSeed}:${decisionIndex}`).nextInt(BOT_SEED_SPACE);
        const anchor = anchorFactory(anchorSeed);
        const observation = adapter.getObservation(state, decision.player);
        let anchorChoice: unknown;
        try {
          anchorChoice = anchor.decide(decision.decisionPoint, observation, legal);
        } catch {
          break;
        }
        const anchorChoiceKey = adapter.encodeChoice(anchorChoice);

        if (anchorChoiceKey !== candidateChoiceKey) {
          actionDivergences += 1;

          for (const card of ['Moat', 'Witch', 'CouncilRoom'] as const) {
            const key = `playAction:${card}`;
            if (candidateChoiceKey === key) cardDirection[card].byCandidate += 1;
            if (anchorChoiceKey === key) cardDirection[card].byAnchor += 1;
          }

          if (candidateChoiceKey === 'endActions' || anchorChoiceKey === 'endActions') {
            const endingIsCandidate = candidateChoiceKey === 'endActions';
            const otherKey = endingIsCandidate ? anchorChoiceKey : candidateChoiceKey;
            const otherChoice = (legal as readonly DominionChoice[]).find(
              (c) => adapter.encodeChoice(c) === otherKey,
            );
            const otherSideCard =
              otherChoice !== undefined && otherChoice.kind === 'playAction' ? otherChoice.card : otherKey;
            const otherSideIsTerminal =
              otherChoice !== undefined &&
              otherChoice.kind === 'playAction' &&
              !NON_TERMINAL_ACTION_CARDS.has(otherChoice.card);
            const legalPlayActionCount = (legal as readonly DominionChoice[]).filter(
              (c) => c.kind === 'playAction',
            ).length;

            if (legalPlayActionCount === 0) casesWithNoAlternative += 1;
            if (otherChoice !== undefined && otherChoice.kind === 'playAction') {
              if (NON_TERMINAL_ACTION_CARDS.has(otherChoice.card)) alternativeIsNonTerminalCount += 1;
              else alternativeIsTerminalCount += 1;
            }

            if (endingIsCandidate) candidateEndsEarly += 1;
            else anchorEndsEarly += 1;

            if (endActionsSamples.length < 8) {
              endActionsSamples.push({
                direction: endingIsCandidate ? 'candidateEndsEarly' : 'anchorEndsEarly',
                gameSeed: record.gameSeed,
                decisionIndex,
                otherSideCard,
                otherSideIsTerminal,
                legalPlayActionCount,
              });
            }
          }
        }
      }

      const matched = legal.find((candidate) => adapter.encodeChoice(candidate) === candidateChoiceKey);
      if (matched === undefined) break;
      state = adapter.applyChoice(state, matched);
    }
  }

  return {
    actionDivergences,
    cardDirection,
    endActions: {
      candidateEndsEarly,
      anchorEndsEarly,
      total: candidateEndsEarly + anchorEndsEarly,
      casesWithNoAlternative,
      alternativeIsNonTerminalCount,
      alternativeIsTerminalCount,
      sampleCases: endActionsSamples,
    },
  };
}

// --- §2: Moat defense-failure correlation (real trajectories, no anchor) --

interface MoatTurnRecord {
  hadMoatAvailable: boolean;
  played: boolean;
}

interface MoatCorrelationResult {
  readonly totalAttacksObserved: number;
  readonly byGroup: Readonly<Record<'played' | 'held' | 'never', { attacks: number; landed: number }>>;
}

/**
 * Walks each record's *actual* trajectory (both players' real choices, no
 * anchor bot involved) via the typed `dominionAdapter`, tracking per
 * (player, turnsTaken) whether Moat was available in that turn's action
 * phase and whether it was played. Whenever an attack card (Witch/Militia)
 * is played, looks up the defender's own most recently completed turn's
 * Moat record and buckets the attack outcome (landed = defender's hand did
 * NOT contain Moat at that instant) into played/held/never.
 */
function analyzeMoatDefenseCorrelation(records: readonly MatchTrajectoryRecord[]): MoatCorrelationResult {
  const byGroup: Record<'played' | 'held' | 'never', { attacks: number; landed: number }> = {
    played: { attacks: 0, landed: 0 },
    held: { attacks: 0, landed: 0 },
    never: { attacks: 0, landed: 0 },
  };
  let totalAttacksObserved = 0;

  for (const record of records) {
    let state: DominionState = dominionAdapter.createInitialState(record.gameSeed);
    const turnRecords: [Map<number, MoatTurnRecord>, Map<number, MoatTurnRecord>] = [new Map(), new Map()];

    for (let decisionIndex = 0; decisionIndex < record.choices.length; decisionIndex += 1) {
      const decision = dominionAdapter.currentDecision(state);
      if (!decision) break;
      const legal = dominionAdapter.getLegalChoices(state);
      if (legal.length === 0) break;

      const choiceKey = record.choices[decisionIndex] as string;
      const chosen = legal.find((c) => dominionAdapter.encodeChoice(c) === choiceKey);
      if (chosen === undefined) break;

      if (state.phase === 'action' && !state.pending) {
        const active: 0 | 1 = state.active === 0 ? 0 : 1;
        const turnKey = state.players[active].turnsTaken;
        const hasMoatInLegal = legal.some((c) => c.kind === 'playAction' && c.card === 'Moat');
        if (hasMoatInLegal) {
          const existing = turnRecords[active].get(turnKey) ?? { hadMoatAvailable: false, played: false };
          turnRecords[active].set(turnKey, { ...existing, hadMoatAvailable: true });
        }
        if (chosen.kind === 'playAction' && chosen.card === 'Moat') {
          const existing = turnRecords[active].get(turnKey) ?? { hadMoatAvailable: false, played: false };
          turnRecords[active].set(turnKey, { ...existing, played: true });
        }

        if (chosen.kind === 'playAction' && ATTACK_CARDS.has(chosen.card)) {
          const defender: 0 | 1 = active === 0 ? 1 : 0;
          const defenderHandHasMoat = state.players[defender].hand.includes('Moat');
          // defender's turnsTaken has already been incremented by their own
          // cleanupAndAdvance since their last action-phase decision (the
          // point where turnRecords was populated with the pre-increment
          // value) — subtract 1 to look up the record for that completed turn.
          const defenderRecord = turnRecords[defender].get(state.players[defender].turnsTaken - 1);
          const group: 'played' | 'held' | 'never' =
            defenderRecord === undefined || !defenderRecord.hadMoatAvailable
              ? 'never'
              : defenderRecord.played
                ? 'played'
                : 'held';
          totalAttacksObserved += 1;
          byGroup[group].attacks += 1;
          if (!defenderHandHasMoat) byGroup[group].landed += 1;
        }
      }

      state = dominionAdapter.applyChoice(state, chosen);
    }
  }

  return { totalAttacksObserved, byGroup };
}

function landedRate(g: { attacks: number; landed: number }): number {
  return g.attacks > 0 ? g.landed / g.attacks : 0;
}

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const bareAdapter = eraseAdapter(dominionAdapter);
  const adapter = withStrategyFlags(bareAdapter, [dominionIsmctsV2BuyPriorFlagSpec(bareAdapter)]);

  console.log('=== dominion action 페이즈 종료/터미널 선택 축 진단 (1단계 — 순수 분석, 코드 변경 없음) ===');
  console.log(`  후보: ${CANDIDATE_FLAG} (v6 챔피언) vs L2(opus). 시드는 dominion-a4-hypothesis-check.ts와 동일(재현).`);

  const candidateBot = composeBot(adapter, [CANDIDATE_FLAG]);
  const opusBot = dominionOpusBot;

  const outDir = join(rootDir, 'runs', GAME_ID, 'action-endgame-diagnosis');
  mkdirSync(outDir, { recursive: true });

  const t0 = Date.now();
  console.log(`  측정) ${CANDIDATE_FLAG} vs L2(opus) N=${N} seedBase=${SEED_BASE_M1} …`);
  const records: MatchTrajectoryRecord[] = [];
  const m1 = runHeadToHead(adapter, candidateBot, opusBot, seeds(SEED_BASE_M1, N), BOT_SEED_BASE.m1, {
    trajectoryCollector: (record) => records.push(record),
  });
  const t1 = Date.now();
  console.log(
    `     winRate=${pct(m1.candidateWinRate)} CI=${ci(m1)} draw/split=${pct(m1.drawRate)} blocks=${m1.blocks} trajectories=${records.length} (${((t1 - t0) / 1000).toFixed(1)}s)`,
  );

  // Cross-check against mineLosses (same seeds, same anchor derivation must
  // reproduce the same 727 action divergences A4's runner measured).
  const lossReport: LossReport = mineLosses(adapter, records, opusBot, { anchorSeedBase: BOT_SEED_BASE.mine });
  const actionStatsFromMineLosses = lossReport.mismatchRateByDecisionPoint['action'];
  console.log(
    `  [교차검증] mineLosses 기준 action 결정=${actionStatsFromMineLosses?.decisions ?? 0}, ` +
      `불일치=${actionStatsFromMineLosses?.mismatches ?? 0}`,
  );

  const t2 = Date.now();
  const direction = analyzeActionDivergenceDirections(adapter, records, opusBot, BOT_SEED_BASE.mine);
  const t3 = Date.now();

  const crossCheckOk = direction.actionDivergences === (actionStatsFromMineLosses?.mismatches ?? 0);
  console.log(
    `  [교차검증 ${crossCheckOk ? '일치' : '불일치!!'}] 이 러너의 actionDivergences=${direction.actionDivergences} (${((t3 - t2) / 1000).toFixed(1)}s)`,
  );

  console.log('\n--- §1 카드별 divergence 방향성 (v6 후보가 더 많이 냈는지 / L2 앵커가 더 많이 냈는지) ---');
  for (const card of ['Moat', 'Witch', 'CouncilRoom'] as const) {
    const stats = direction.cardDirection[card];
    console.log(
      `  ${card}: candidate(v6)가 선택=${stats.byCandidate}건, anchor(L2)가 선택=${stats.byAnchor}건, 합계=${stats.byCandidate + stats.byAnchor}건`,
    );
  }

  console.log('\n--- §3 endActions divergence 상세 ---');
  const ea = direction.endActions;
  console.log(
    `  총 ${ea.total}건 (candidate가 더 일찍 끝냄=${ea.candidateEndsEarly}건, anchor(L2)가 더 일찍 끝냄=${ea.anchorEndsEarly}건)`,
  );
  console.log(
    `  대안(legal에 있던 다른 playAction) 없음(=불가피하게 끝냄)=${ea.casesWithNoAlternative}건 / ` +
      `대안이 논터미널=${ea.alternativeIsNonTerminalCount}건, 대안이 터미널=${ea.alternativeIsTerminalCount}건`,
  );
  console.log(`  샘플(최대 8건): ${JSON.stringify(ea.sampleCases, null, 2)}`);

  console.log('\n--- §2 Moat 방어 실패 상관관계 (실제 트래젝토리, 앵커 불필요) ---');
  const t4 = Date.now();
  const moatCorrelation = analyzeMoatDefenseCorrelation(records);
  const t5 = Date.now();
  console.log(`  전체 공격(Witch/Militia) 관측=${moatCorrelation.totalAttacksObserved}건 (${((t5 - t4) / 1000).toFixed(1)}s)`);
  for (const group of ['played', 'held', 'never'] as const) {
    const g = moatCorrelation.byGroup[group];
    console.log(
      `  defender의 직전 자기 턴 그룹='${group}': 공격 ${g.attacks}건 중 관철(안 막힘) ${g.landed}건 -> 관철율=${pct(landedRate(g))}`,
    );
  }
  console.log(
    '  (played=직전 턴에 Moat를 냄(소모), held=직전 턴에 Moat가 있었는데 안 냄(보류), never=직전 턴에 Moat 자체가 없었음)',
  );

  const totalT = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n총 소요 ${totalT}s`);

  const summaryPath = join(outDir, 'action-endgame-diagnosis-summary.json');
  const summary = {
    gameId: GAME_ID,
    generatedAt: new Date().toISOString(),
    candidateFlag: CANDIDATE_FLAG,
    measurement: {
      seedBase: SEED_BASE_M1,
      n: N,
      botSeedBase: BOT_SEED_BASE.m1,
      result: m1,
      trajectoriesRecorded: records.length,
    },
    crossCheck: {
      mineLossesActionMismatches: actionStatsFromMineLosses?.mismatches ?? 0,
      thisRunnerActionDivergences: direction.actionDivergences,
      ok: crossCheckOk,
    },
    cardDirection: direction.cardDirection,
    endActions: direction.endActions,
    moatCorrelation: {
      totalAttacksObserved: moatCorrelation.totalAttacksObserved,
      byGroup: Object.fromEntries(
        (['played', 'held', 'never'] as const).map((group) => [
          group,
          { ...moatCorrelation.byGroup[group], landedRate: landedRate(moatCorrelation.byGroup[group]) },
        ]),
      ),
    },
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`  저장: ${summaryPath}`);
}

main();
