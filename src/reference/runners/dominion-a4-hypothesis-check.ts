/**
 * dominion-a4-hypothesis-check — GAP-11 A4 루트 오버라이드(action 축) 1단계
 * 가설 검증 러너(main-loop design spec:
 * scratchpad/dominion-a4-root-override-design-spec.md). **순수 분석, 코드
 * 로직 변경 없음** — `src/reference/dominion.ts`/`loop/loss-mining.ts` 등
 * 기존 코드는 전혀 건드리지 않는다.
 *
 * 배경: 4회전 진단이 v6(챔피언, `ismcts-s64-v2buy-prior`)의 action 결정지점
 * 불일치율을 19.9%(803/4044)로 측정했다(도미니언 4회전 문서). 그 축을
 * 정확히 겨냥한 소프트 prior 주입(`ismcts-s64-v2action-prior`)은 이미
 * challenge에서 챔피언보다 낮은 성적(40.0% vs 41.3%)으로 실패했다.
 * `heuristicPick`의 `ACTION_PRIORITY`는 이미 "+actions을 주는 카드(Village/
 * Laboratory/Festival/Market — 논터미널)를 먼저, 나머지(터미널)를 나중에"
 * 순서다(dominion.ts 942-955줄). 가설: v6의 IS-MCTS(s64, action에는 별도
 * prior 없음)가 얕은 탐색 하에서 이 순서를 가끔 어긴다 — 손에 논터미널
 * 액션 카드가 있는데도 터미널을 먼저 낸다.
 *
 * 이 러너는 그 가설을 데이터로 검증한다: v6 vs L2(`dominionOpusBot`)
 * 트래젝토리를 anchorFactory=L2 자신으로 채굴한 `action` divergence 전부에
 * 대해, "후보(v6)가 고른 카드가 터미널인데 같은 legal 목록에 논터미널
 * playAction 선택지가 있었던" 비율을 계산한다. `loop/loss-mining.ts`의
 * `mineLosses`는 divergence만 반환하고 그 시점의 legal 목록을 노출하지
 * 않으므로, 이 러너는 `mineLosses`의 재생 루프(같은 anchorSeedBase 파생
 * 규약)를 그대로 재구현해 divergence 검출과 패턴 판정을 한 번의 replay로
 * 함께 수행한다 — `mineLosses`도 별도로 호출해 액션 불일치 총수가 정확히
 * 일치하는지 교차검증한다(같은 시드이므로 결정론적으로 동일해야 함).
 *
 * 판단 기준(설계 스펙): 비율 15% 이상이면 2단계(루트 오버라이드 구현)
 * 진행, 그 미달이면 가설 기각.
 *
 * Seeds: identical to dominion-mirror-draw-diagnosis.ts (450,000+ / bot base
 * 996_101, 996_201) — deliberately reused, not fresh, because this is a pure
 * re-derivation of that same run's divergence set (design spec: "같은 시드로
 * 재실행해도 무방, 결정론적이므로 동일 결과"). No new game is played beyond
 * what that diagnosis already measured.
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
import { dominionAdapter, type DominionChoice } from '../dominion';
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

/**
 * The four action cards ACTION_PRIORITY (dominion.ts 942-955) ranks ahead of
 * every terminal action card, because CARD_DEFS gives each of them
 * `actions >= 1` (Village: 2, Laboratory: 1, Festival: 2, Market: 1) — every
 * other action card in the kingdom pool (CouncilRoom, Smithy, Chapel,
 * Workshop, Woodcutter, Witch, Militia, Moat) has `actions: 0`. Hardcoded
 * here (rather than importing CARD_DEFS, which dominion.ts does not export)
 * because this is a fixed rules fact, not a value this analysis derives.
 */
const NON_TERMINAL_ACTION_CARDS = new Set(['Village', 'Laboratory', 'Festival', 'Market']);

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

interface NonTerminalFirstCase {
  readonly gameSeed: number;
  readonly decisionIndex: number;
  readonly candidateChoiceKey: string;
  readonly anchorChoiceKey: string;
  readonly legalPlayActionCards: readonly string[];
}

interface HypothesisCheckResult {
  readonly actionDivergences: number;
  readonly nonTerminalFirstPattern: number;
  readonly ratio: number;
  readonly sampleCases: readonly NonTerminalFirstCase[];
  readonly topDivergenceCards: Readonly<Record<string, number>>;
}

/**
 * Re-implements mineLosses's replay loop (loop/loss-mining.ts) verbatim for
 * determinism (same rootRng seed, same `${gameSeed}:${decisionIndex}` fork
 * key), but additionally inspects the `legal` list at every `action`
 * divergence to test the A4 hypothesis: did the candidate pick a terminal
 * (actions === 0) playAction while a non-terminal playAction was also legal?
 */
function checkNonTerminalFirstHypothesis(
  adapter: AnyGameAdapter,
  records: readonly MatchTrajectoryRecord[],
  anchorFactory: AnyBotFactory,
  anchorSeedBase: number,
): HypothesisCheckResult {
  const rootRng = createRng(anchorSeedBase);

  let actionDivergences = 0;
  let nonTerminalFirstPattern = 0;
  const sampleCases: NonTerminalFirstCase[] = [];
  const topDivergenceCards: Record<string, number> = {};

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

          const candidateChoice = legal.find(
            (candidate) => adapter.encodeChoice(candidate) === candidateChoiceKey,
          ) as DominionChoice | undefined;

          if (candidateChoice) {
            topDivergenceCards[candidateChoiceKey] = (topDivergenceCards[candidateChoiceKey] ?? 0) + 1;
          }

          const candidateIsTerminalPlayAction =
            candidateChoice !== undefined &&
            candidateChoice.kind === 'playAction' &&
            !NON_TERMINAL_ACTION_CARDS.has(candidateChoice.card);

          const legalPlayActionCards = (legal as readonly DominionChoice[])
            .filter((c): c is Extract<DominionChoice, { kind: 'playAction' }> => c.kind === 'playAction')
            .map((c) => c.card);

          const hasNonTerminalAlternative = legalPlayActionCards.some((card) =>
            NON_TERMINAL_ACTION_CARDS.has(card),
          );

          if (candidateIsTerminalPlayAction && hasNonTerminalAlternative) {
            nonTerminalFirstPattern += 1;
            if (sampleCases.length < 5) {
              sampleCases.push({
                gameSeed: record.gameSeed,
                decisionIndex,
                candidateChoiceKey,
                anchorChoiceKey,
                legalPlayActionCards,
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
    nonTerminalFirstPattern,
    ratio: actionDivergences > 0 ? nonTerminalFirstPattern / actionDivergences : 0,
    sampleCases,
    topDivergenceCards,
  };
}

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const bareAdapter = eraseAdapter(dominionAdapter);
  const adapter = withStrategyFlags(bareAdapter, [dominionIsmctsV2BuyPriorFlagSpec(bareAdapter)]);

  console.log('=== dominion A4 가설 검증 (action 축 루트 오버라이드, 1단계 — 순수 분석, 코드 변경 없음) ===');
  console.log(`  후보: ${CANDIDATE_FLAG} (v6 챔피언) vs L2(opus). 시드는 dominion-mirror-draw-diagnosis.ts와 동일(재현).`);

  const candidateBot = composeBot(adapter, [CANDIDATE_FLAG]);
  const opusBot = dominionOpusBot;

  const outDir = join(rootDir, 'runs', GAME_ID, 'a4-hypothesis-check');
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

  // Cross-check: mineLosses's own action mismatch count must match this
  // runner's actionDivergences exactly (same seeds, same anchor derivation).
  const lossReport: LossReport = mineLosses(adapter, records, opusBot, { anchorSeedBase: BOT_SEED_BASE.mine });
  const actionStatsFromMineLosses = lossReport.mismatchRateByDecisionPoint['action'];
  console.log(
    `  [교차검증] mineLosses 기준 action 결정=${actionStatsFromMineLosses?.decisions ?? 0}, ` +
      `불일치=${actionStatsFromMineLosses?.mismatches ?? 0} (전체 divergences=${lossReport.divergences.length}, ` +
      `action divergences=${lossReport.divergences.filter((d) => d.decisionPointId === 'action').length})`,
  );

  const check = checkNonTerminalFirstHypothesis(adapter, records, opusBot, BOT_SEED_BASE.mine);

  const crossCheckOk = check.actionDivergences === (actionStatsFromMineLosses?.mismatches ?? 0);
  console.log(
    `  [교차검증 ${crossCheckOk ? '일치' : '불일치!!'}] 이 러너의 actionDivergences=${check.actionDivergences}`,
  );

  console.log(
    `  [1단계 결과] action divergence ${check.actionDivergences}건 중 ${check.nonTerminalFirstPattern}건이 ` +
      `"논터미널 방치 패턴"(터미널을 골랐는데 legal에 논터미널 playAction이 있었음) -> 비율=${pct(check.ratio)}`,
  );

  const verdict = check.ratio >= 0.15 ? '가설 채택 (>=15%) — 2단계 진행' : '가설 기각 (<15%) — 2단계 진행 안 함';
  console.log(`  [판정] ${verdict}`);

  console.log(`  샘플 사례(최대 5건): ${JSON.stringify(check.sampleCases, null, 2)}`);
  console.log(
    `  후보 선택 카드별 divergence 빈도(상위): ${JSON.stringify(
      Object.fromEntries(
        Object.entries(check.topDivergenceCards)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10),
      ),
    )}`,
  );

  const summaryPath = join(outDir, 'hypothesis-check-summary.json');
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
      mineLossesActionDecisions: actionStatsFromMineLosses?.decisions ?? 0,
      mineLossesActionMismatches: actionStatsFromMineLosses?.mismatches ?? 0,
      thisRunnerActionDivergences: check.actionDivergences,
      ok: crossCheckOk,
    },
    hypothesisCheck: {
      actionDivergences: check.actionDivergences,
      nonTerminalFirstPattern: check.nonTerminalFirstPattern,
      ratio: check.ratio,
      thresholdMet: check.ratio >= 0.15,
      sampleCases: check.sampleCases,
      topDivergenceCards: check.topDivergenceCards,
    },
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`  저장: ${summaryPath}`);
}

main();
