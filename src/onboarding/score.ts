/**
 * G-Score conformance battery (DESIGN.md §4): axes C0-contract .. C7-parity.
 * Each axis is scored 0-100 with blockers (fatal) and notes (informational).
 * `buildReport` (report.ts) takes the minimum axis score as the overall
 * score — a single weak axis makes the whole loop meaningless, so this
 * module never averages across axes itself.
 */

import type {
  AnyBotFactory,
  AnyGameAdapter,
  PlayerId,
  SeatingPermutation,
} from '../contract/types';
import { createRng } from '../kernel/rng';
import { canonicalJson } from '../kernel/digest';
import { classifyGame } from '../kernel/classify';
import { deriveBlueprint, type PipelineBlueprint } from '../kernel/blueprint';
import { calibrateIdentity } from '../loop/calibrate';
import { runMatch, type MatchResult } from '../loop/match';
import { runPairedBlock } from '../loop/paired-match';
import { bootstrapPairedSeedBlocks, type PairedSeedOutcome } from '../kernel/paired-stats';
import { buildReport, type AxisBlocker, type AxisResult, type ConformanceReport } from './report';

export interface ScoreOptions {
  readonly threshold?: number;
  readonly seedBase?: number;
  readonly c1SeedCount?: number;
  /** Candidate seed pool searched for the longest (most-decision) games before
   * the C1 reproducibility check samples from it (B1: late-triggering
   * nondeterminism, e.g. mid-game reshuffles, is more likely to surface in
   * long games). */
  readonly c1CandidatePoolSize?: number;
  /** Number of distinct game seeds compared for the C1 seed-diversity check
   * (A1: deterministic games with a fixed initial position replay identically
   * across every seed unless the adapter injects seed-indexed diversity). */
  readonly c1DiversitySeedCount?: number;
  /** Minimum fraction of distinct-seed trajectory pairs that must differ for
   * the C1 seed-diversity check to pass. */
  readonly c1DiversityThreshold?: number;
  readonly c2Playouts?: number;
  readonly c3SampleStates?: number;
  readonly c4SampleGames?: number;
  readonly c4MinGamesPerSecond?: number;
  readonly c4TargetGamesPerSecond?: number;
  /** Decisions/sec floor; below this C4 is a blocker (A4: decisions/sec is the
   * primary throughput signal, since games/sec conflates game length with
   * adapter speed). */
  readonly c4MinDecisionsPerSecond?: number;
  readonly c4TargetDecisionsPerSecond?: number;
  readonly c5IdentitySeeds?: number;
  readonly c5HeadToHeadSeeds?: number;
  readonly c6ProbeSeeds?: number;
}

const DEFAULTS: Required<ScoreOptions> = {
  threshold: 80,
  seedBase: 10_000,
  c1SeedCount: 5,
  c1CandidatePoolSize: 20,
  c1DiversitySeedCount: 12,
  c1DiversityThreshold: 0.9,
  c2Playouts: 200,
  c3SampleStates: 10,
  c4SampleGames: 60,
  c4MinGamesPerSecond: 20,
  c4TargetGamesPerSecond: 200,
  c4MinDecisionsPerSecond: 500,
  c4TargetDecisionsPerSecond: 5_000,
  c5IdentitySeeds: 200,
  c5HeadToHeadSeeds: 300,
  c6ProbeSeeds: 10,
};

function axis(
  id: AxisResult['axis'],
  score: number,
  blockers: readonly AxisBlocker[],
  notes: readonly string[],
): AxisResult {
  return { axis: id, score, blockers, notes };
}

function firstSeating(adapter: AnyGameAdapter): SeatingPermutation {
  const seating = adapter.spec.seatingPlan[0];
  if (!seating) {
    throw new Error('scoreAdapter: adapter.spec.seatingPlan is empty');
  }
  return seating;
}

function buildRandomBotFactories(adapter: AnyGameAdapter): AnyBotFactory[] {
  return Array.from({ length: adapter.spec.playerCount }, () => adapter.baselines.random);
}

function playRandomGame(adapter: AnyGameAdapter, gameSeed: number, botSeedBase: number): MatchResult {
  const botFactories = buildRandomBotFactories(adapter);
  const botSeeds = botFactories.map((_, index) => botSeedBase + index);
  return runMatch(adapter, botFactories, gameSeed, botSeeds, firstSeating(adapter));
}

// ---------------------------------------------------------------------------
// C0 — contract validity
// ---------------------------------------------------------------------------

function scoreC0(adapter: AnyGameAdapter): AxisResult {
  const blockers: AxisBlocker[] = [];
  const notes: string[] = [];
  const spec = adapter.spec;

  if (!Number.isInteger(spec.playerCount) || spec.playerCount < 1) {
    blockers.push({
      code: 'C0_PLAYER_COUNT',
      message: `spec.playerCount must be a positive integer, got ${spec.playerCount}`,
      remediation:
        'Set spec.playerCount to the number of seats in the game. 보통 이건 게임 규칙에서 정한 좌석 수가 어댑터 설정에 반영되지 않았을 때 발생합니다.',
    });
  } else if (spec.playerCount < 2) {
    // G2: win-rate-based loop statistics assume a competitive matchup between
    // two-or-more parties; solo/co-op games have no such matchup to measure
    // (docs/GAP-ANALYSIS-2.md G2).
    blockers.push({
      code: 'C0_SOLO_OR_COOP_UNSUPPORTED',
      message: `spec.playerCount is ${spec.playerCount}; v1 requires a competitive game (playerCount >= 2)`,
      remediation: 'v1은 경쟁 게임 전용 — 솔로/협력 게임은 로드맵 (docs/GAP-ANALYSIS-2.md G2)',
    });
  }
  if (spec.decisionPoints.length === 0) {
    blockers.push({
      code: 'C0_NO_DECISION_POINTS',
      message: 'spec.decisionPoints is empty',
      remediation:
        'Declare at least one DecisionPointSpec for the game. 보통 이건 게임에서 플레이어가 선택을 내리는 지점(턴, 페이즈 등)이 어댑터에 아직 하나도 등록되지 않았을 때 발생합니다.',
    });
  }
  if (spec.seatingPlan.length < 2) {
    blockers.push({
      code: 'C0_SEATING_PLAN_TOO_SHORT',
      message: `spec.seatingPlan has ${spec.seatingPlan.length} permutation(s), need at least 2`,
      remediation:
        'Add seat permutations so position bias can cancel in paired statistics. 보통 이건 게임의 좌석 순서를 하나만 등록해서, 선공/후공 같은 자리 유불리를 통계적으로 상쇄할 방법이 없을 때 발생합니다.',
    });
  } else {
    const wrongLength = spec.seatingPlan.some(
      (permutation) => permutation.length !== spec.playerCount,
    );
    if (wrongLength) {
      blockers.push({
        code: 'C0_SEATING_PLAN_LENGTH',
        message: 'a seatingPlan permutation does not have length spec.playerCount',
        remediation:
          'Every seatingPlan permutation must assign a seat to every bot slot. 보통 이건 좌석 순서 목록 중 일부가 실제 플레이어 수보다 짧거나 길게 잘못 작성됐을 때 발생합니다.',
      });
    }
    const seatsCoveredForCandidate = new Set(
      spec.seatingPlan.map((permutation) => permutation[0]),
    );
    if (seatsCoveredForCandidate.size !== spec.playerCount) {
      blockers.push({
        code: 'C0_SEATING_PLAN_COVERAGE',
        message: 'seatingPlan permutations do not cover every seat for the candidate (index 0)',
        remediation:
          'Include a permutation with seating[0] equal to each PlayerId. 보통 이건 특정 플레이어가 한 번도 "내 게임"의 주인공(0번 후보) 자리에 앉는 순서로 등록되지 않았을 때 발생합니다.',
      });
    }
  }
  if (!Number.isInteger(spec.maxDecisionsPerGame) || spec.maxDecisionsPerGame <= 0) {
    blockers.push({
      code: 'C0_MAX_DECISIONS',
      message: `spec.maxDecisionsPerGame must be a positive integer, got ${spec.maxDecisionsPerGame}`,
      remediation:
        'Set a finite hard cap on decisions per game. 보통 이건 게임이 무한히 계속될 수 있는 경우를 대비한 강제 종료 상한이 설정되지 않았을 때 발생합니다.',
    });
  }
  if (typeof adapter.baselines?.random !== 'function' || typeof adapter.baselines?.heuristic !== 'function') {
    blockers.push({
      code: 'C0_BASELINES_MISSING',
      message: 'adapter.baselines.random/heuristic must both be BotFactory functions',
      remediation:
        'Implement both a random and a heuristic baseline bot factory. 보통 이건 무작위로 두는 봇이나 간단한 규칙 기반 봇 같은, 게임을 비교할 최소한의 기준 플레이어가 아직 구현되지 않았을 때 발생합니다.',
    });
  }
  if (!Array.isArray(adapter.strategySurface)) {
    blockers.push({
      code: 'C0_STRATEGY_SURFACE_MISSING',
      message: 'adapter.strategySurface must be an array (may be empty)',
      remediation:
        'Declare strategySurface: [] at minimum, or add StrategyFlagSpec entries. 보통 이건 게임에서 봇 전략을 실험적으로 바꿔볼 지점(공격성, 우선순위 등)이 아예 선언되지 않았을 때 발생합니다.',
    });
  }

  if (blockers.length === 0) {
    notes.push('contract shape valid: decision points, seating plan, baselines, strategy surface present.');
  }

  return axis('C0-contract', blockers.length === 0 ? 100 : 0, blockers, notes);
}

// ---------------------------------------------------------------------------
// C1 — determinism
// ---------------------------------------------------------------------------

function scoreC1(adapter: AnyGameAdapter, options: Required<ScoreOptions>): AxisResult {
  const blockers: AxisBlocker[] = [];
  const notes: string[] = [];

  // B1: bias the reproducibility sample toward the longest games in a
  // candidate pool, since late-triggering nondeterminism (e.g. a mid-game
  // reshuffle) is more likely to surface once a game has run for a while.
  const poolSize = options.c1CandidatePoolSize;
  const sampleCount = Math.min(options.c1SeedCount, poolSize);
  const pool = Array.from({ length: poolSize }, (_, i) => {
    const gameSeed = options.seedBase + i;
    const botSeedBase = options.seedBase + 1000 + i;
    const result = playRandomGame(adapter, gameSeed, botSeedBase);
    const decisions = result.kind === 'completed' ? result.decisions : -1;
    return { gameSeed, botSeedBase, decisions };
  });
  const selected = pool
    .filter((entry) => entry.decisions >= 0)
    .sort((a, b) => b.decisions - a.decisions)
    .slice(0, sampleCount);

  notes.push(
    `reproducibility sample: ${selected.length} longest-game seed(s) selected from a pool of ${poolSize} — ` +
      selected.map((entry) => `${entry.gameSeed} (${entry.decisions} decisions)`).join(', '),
  );

  for (const { gameSeed, botSeedBase } of selected) {
    const first = playRandomGame(adapter, gameSeed, botSeedBase);
    const second = playRandomGame(adapter, gameSeed, botSeedBase);

    if (first.kind === 'defect' || second.kind === 'defect') {
      // Defects are C2's concern; C1 only judges reproducibility. Skip this
      // seed's determinism comparison but do not double-penalize here.
      continue;
    }
    const sameTrajectory =
      first.choiceKeys.length === second.choiceKeys.length &&
      first.choiceKeys.every((key, index) => key === second.choiceKeys[index]);
    const sameOutcome = canonicalJson(first.outcome) === canonicalJson(second.outcome);
    if (!sameTrajectory || !sameOutcome) {
      blockers.push({
        code: 'C1_NONDETERMINISTIC',
        message: `seed ${gameSeed} produced different trajectories/outcomes on repeated runs`,
        remediation:
          'Ensure createInitialState/applyChoice/bots never use Date.now(), Math.random(), or external I/O. ' +
          '보통 이건 게임 로직이나 봇이 시각/난수 등 실행마다 달라지는 값에 의존해서, 같은 시드로 다시 돌려도 다른 결과가 나올 때 발생합니다.',
      });
    }
  }

  if (blockers.length === 0) {
    notes.push(`${selected.length} seed(s) replayed identically twice.`);
  }

  // A1: seed-diversity check. A deterministic game with a fixed initial
  // position (chess-like) produces the exact same trajectory on every seed
  // unless the adapter injects seed-indexed opening diversity — which makes
  // paired-seed statistics meaningless (every seed is the same sample).
  const diversitySeeds = Array.from(
    { length: options.c1DiversitySeedCount },
    (_, i) => options.seedBase + 40_000 + i,
  );
  // Use one fixed bot seed base for every diversity-check game so the only
  // thing that can vary between trajectories is the game seed's effect on
  // initial state — otherwise random-bot noise alone would make even a
  // truly fixed-opening (chess-like) adapter look seed-diverse.
  const diversityBotSeedBase = options.seedBase + 50_000;
  const trajectories: (readonly string[] | null)[] = diversitySeeds.map((gameSeed) => {
    const result = playRandomGame(adapter, gameSeed, diversityBotSeedBase);
    return result.kind === 'completed' ? result.choiceKeys : null;
  });

  let totalPairs = 0;
  let identicalPairs = 0;
  for (let i = 0; i < trajectories.length; i += 1) {
    const a = trajectories[i];
    if (!a) continue;
    for (let j = i + 1; j < trajectories.length; j += 1) {
      const b = trajectories[j];
      if (!b) continue;
      totalPairs += 1;
      const identical = a.length === b.length && a.every((key, index) => key === b[index]);
      if (identical) {
        identicalPairs += 1;
      }
    }
  }

  if (totalPairs > 0) {
    const distinctPairs = totalPairs - identicalPairs;
    const diversityRatio = distinctPairs / totalPairs;
    notes.push(
      `seed diversity: ${distinctPairs}/${totalPairs} distinct-seed trajectory pair(s) differ ` +
        `(${identicalPairs} identical pair(s)) across ${options.c1DiversitySeedCount} seeds.`,
    );
    if (diversityRatio < options.c1DiversityThreshold) {
      blockers.push({
        code: 'C1_SEED_DIVERSITY',
        message:
          `only ${distinctPairs}/${totalPairs} distinct-seed trajectory pairs differ, ` +
          `below the required ${(options.c1DiversityThreshold * 100).toFixed(0)}%`,
        remediation:
          '서로 다른 시드가 같은 게임을 재생함 — 결정론 게임이라면 시드-인덱스 오프닝 다양성을 주입하라 (docs/ONBOARDING-GUIDE.md §5)',
      });
    }
  }

  return axis('C1-determinism', blockers.length === 0 ? 100 : 0, blockers, notes);
}

// ---------------------------------------------------------------------------
// C2 — rule integrity
// ---------------------------------------------------------------------------

function scoreC2ContentCoverage(
  adapter: AnyGameAdapter,
  exercisedIds: ReadonlySet<string>,
  unknownContentId: string | null,
): { readonly blockers: AxisBlocker[]; readonly notes: string[]; readonly coveragePercent: number | null } {
  const blockers: AxisBlocker[] = [];
  const notes: string[] = [];
  const contentInventory = adapter.contentInventory;
  if (!contentInventory) {
    notes.push('콘텐츠 커버리지 미측정 — 콘텐츠 무거운 게임이면 contentInventory 선언 권장');
    return { blockers, notes, coveragePercent: null };
  }

  if (unknownContentId !== null) {
    blockers.push({
      code: 'C2_CONTENT_UNKNOWN_ID',
      message: `exercisedContent returned id "${unknownContentId}", which is not present in contentInventory`,
      remediation:
        'exercisedContent가 반환하는 모든 id는 contentInventory에 선언된 id 집합의 부분집합이어야 한다. ' +
        '보통 이건 실제 플레이 중 등장한 카드/타일/유닛 같은 콘텐츠 항목이 콘텐츠 목록(contentInventory)에는 등록되지 않았을 때 발생합니다.',
    });
  }

  const inventorySize = contentInventory.length;
  const coveragePercent = inventorySize > 0 ? (exercisedIds.size / inventorySize) * 100 : 100;
  const uncovered = contentInventory.filter((entry) => !exercisedIds.has(entry.id)).map((entry) => entry.id);
  const shown = uncovered.slice(0, 20);
  const remaining = uncovered.length - shown.length;
  notes.push(
    `콘텐츠 커버리지: ${coveragePercent.toFixed(1)}% (${exercisedIds.size}/${inventorySize}) — ` +
      (uncovered.length === 0
        ? '모든 콘텐츠가 실행됨.'
        : `미커버: ${shown.join(', ')}${remaining > 0 ? ` 외 ${remaining}개` : ''}`),
  );

  if (coveragePercent < 20) {
    blockers.push({
      code: 'C2_CONTENT_COVERAGE_TOO_LOW',
      message: `content coverage ${coveragePercent.toFixed(1)}% is below the 20% floor`,
      remediation:
        '랜덤 플레이아웃이 콘텐츠 대부분을 실행하지 못함 — 증분 온보딩(docs/ONBOARDING-GUIDE.md §5.7) 또는 플레이아웃 수 증가 필요',
    });
  }

  return { blockers, notes, coveragePercent };
}

/**
 * O3: applyChoice transition-purity check (OpenSpiel api_test absorption).
 * Only the first playout's first 10 decisions are checked — a canonicalJson
 * snapshot before/after each applyChoice call is enough to catch a mutating
 * adapter cheaply, without re-snapshotting every decision of every playout.
 */
function checkApplyChoicePurity(adapter: AnyGameAdapter, gameSeed: number): AxisBlocker[] {
  const blockers: AxisBlocker[] = [];
  let state = adapter.createInitialState(gameSeed);
  for (let step = 0; step < 10; step += 1) {
    const decision = adapter.currentDecision(state);
    if (!decision) break;
    const legal = adapter.getLegalChoices(state);
    const choice = legal[0];
    if (choice === undefined) break;

    const before = canonicalJson(state);
    const next = adapter.applyChoice(state, choice);
    const after = canonicalJson(state);
    if (before !== after) {
      blockers.push({
        code: 'C2_APPLYCHOICE_MUTATED_INPUT',
        message: `applyChoice mutated its input state at decision step ${step} (seed ${gameSeed})`,
        remediation:
          'applyChoice must return a new state and leave the state it was given untouched — transitions must be pure ' +
          '(OpenSpiel api_test absorption). 보통 이건 게임 규칙 구현이 입력으로 받은 상태 객체를 그 자리에서 직접 수정(배열 push, ' +
          '필드 재할당 등)하고 그 객체를 그대로 반환할 때 발생합니다. applyChoice 안에서는 상태를 복사한 새 객체를 만들어 반환하세요.',
      });
      break;
    }
    state = next;
  }
  return blockers;
}

function scoreC2(adapter: AnyGameAdapter, options: Required<ScoreOptions>): AxisResult {
  const blockers: AxisBlocker[] = [];
  const notes: string[] = [];
  let defectCount = 0;
  let maxDecisionsDefectSeen = false;
  let illegalChoiceRejectionChecked = false;

  blockers.push(...checkApplyChoicePurity(adapter, options.seedBase + 2000));

  const legalChoicePools: { legal: unknown[]; sourceGameSeed: number; depth: number }[] = [];
  const contentInventory = adapter.contentInventory;
  const exercisedContentFn = adapter.exercisedContent;
  const inventoryIds = new Set((contentInventory ?? []).map((entry) => entry.id));
  const exercisedIds = new Set<string>();
  let unknownContentId: string | null = null;

  for (let i = 0; i < options.c2Playouts; i += 1) {
    const gameSeed = options.seedBase + 2000 + i;
    const botSeedBase = options.seedBase + 3000 + i;
    const result = playRandomGame(adapter, gameSeed, botSeedBase);
    if (result.kind === 'defect') {
      defectCount += 1;
      if (result.defect.type === 'max-decisions-exceeded') {
        maxDecisionsDefectSeen = true;
      }
      continue;
    }
    if (contentInventory && exercisedContentFn) {
      for (const id of exercisedContentFn(result.finalState)) {
        if (unknownContentId === null && !inventoryIds.has(id)) {
          unknownContentId = id;
        }
        exercisedIds.add(id);
      }
    }
    // Collect a few legal-choice pools (from replaying) for the illegal-choice
    // spot-check below.
    if (legalChoicePools.length < 5) {
      let state = adapter.createInitialState(gameSeed);
      for (let step = 0; step < 3; step += 1) {
        const decision = adapter.currentDecision(state);
        if (!decision) break;
        const legal = adapter.getLegalChoices(state);
        legalChoicePools.push({ legal: legal.slice(), sourceGameSeed: gameSeed, depth: step });
        state = adapter.applyChoice(state, legal[0]);
      }
    }
  }

  let contentCoveragePercent: number | null = null;
  if (contentInventory && !exercisedContentFn) {
    blockers.push({
      code: 'C2_CONTENT_INVENTORY_WITHOUT_EXERCISED',
      message: 'adapter.contentInventory is declared but adapter.exercisedContent is not implemented',
      remediation:
        'contentInventory 선언 시 exercisedContent 구현 필수 — 보통 이건 게임의 카드/유닛 등 콘텐츠 목록은 선언했지만, ' +
        '한 판에서 실제로 어떤 콘텐츠가 등장했는지 알려주는 코드가 아직 없을 때 발생합니다.',
    });
  } else {
    const coverage = scoreC2ContentCoverage(adapter, exercisedIds, unknownContentId);
    blockers.push(...coverage.blockers);
    notes.push(...coverage.notes);
    contentCoveragePercent = coverage.coveragePercent;
  }

  if (defectCount > 0) {
    let remediation =
      'Fix illegal-choice/empty-legal/invariant/max-decisions defects surfaced by loop/match.ts. ' +
      '보통 이건 게임 규칙 일부가 잘못 구현되어 불가능한 선택을 허용하거나, 선택지가 없는데도 진행을 요구하거나, ' +
      '판이 끝나지 않을 때 발생합니다.';
    if (maxDecisionsDefectSeen) {
      remediation +=
        ' 게임의 종국 보장 규칙(반복/무진행 무승부 등) 미구현 여부를 확인하라 — max-decisions defect can mean the adapter never terminates.';
    }
    blockers.push({
      code: 'C2_DEFECTS',
      message: `${defectCount}/${options.c2Playouts} random playouts produced an adapter/bot defect`,
      remediation,
    });
  }

  // Illegal-choice rejection spot-check: find a choice, from one legal pool,
  // whose encoded key is absent from another pool's legal set, and confirm
  // applyChoice throws when offered against that other pool's state.
  outer: for (let poolIndex = 0; poolIndex < legalChoicePools.length; poolIndex += 1) {
    const donorPool = legalChoicePools[poolIndex];
    if (!donorPool) continue;
    for (let otherIndex = 0; otherIndex < legalChoicePools.length; otherIndex += 1) {
      if (otherIndex === poolIndex) continue;
      const targetPool = legalChoicePools[otherIndex];
      if (!targetPool) continue;
      const targetKeys = new Set(targetPool.legal.map((choice) => adapter.encodeChoice(choice)));
      const foreignChoice = donorPool.legal.find(
        (choice) => !targetKeys.has(adapter.encodeChoice(choice)),
      );
      if (foreignChoice === undefined) continue;

      // Replay from targetPool's recorded source game/depth to attempt the foreign choice.
      let targetState = adapter.createInitialState(targetPool.sourceGameSeed);
      let matchedDepth = -1;
      for (let step = 0; step <= targetPool.depth; step += 1) {
        const decision = adapter.currentDecision(targetState);
        if (!decision) break;
        matchedDepth = step;
        if (step === targetPool.depth) break;
        const legal = adapter.getLegalChoices(targetState);
        targetState = adapter.applyChoice(targetState, legal[0]);
      }
      if (matchedDepth === -1) continue;

      let threw = false;
      try {
        adapter.applyChoice(targetState, foreignChoice);
      } catch {
        threw = true;
      }
      illegalChoiceRejectionChecked = true;
      if (!threw) {
        blockers.push({
          code: 'C2_ILLEGAL_CHOICE_ACCEPTED',
          message: 'applyChoice accepted a choice not present in getLegalChoices for that state',
          remediation:
            'applyChoice must throw on any choice not returned by getLegalChoices(state). ' +
            '보통 이건 게임 규칙상 불가능한 수(예: 이미 사용한 카드, 규칙 위반 이동)를 게임이 걸러내지 않고 그대로 받아들일 때 발생합니다.',
        });
      }
      break outer;
    }
  }

  if (!illegalChoiceRejectionChecked) {
    notes.push(
      'could not synthesize a cross-state illegal choice to spot-check applyChoice rejection; no penalty applied.',
    );
  } else if (blockers.every((b) => b.code !== 'C2_ILLEGAL_CHOICE_ACCEPTED')) {
    notes.push('illegal-choice rejection spot-check passed.');
  }

  if (defectCount === 0) {
    notes.push(`${options.c2Playouts} random playouts completed with zero defects.`);
  }

  let score = blockers.length === 0 ? 100 : 0;
  if (score === 100 && contentCoveragePercent !== null && contentCoveragePercent < 80) {
    // Linear degradation below the 80% coverage floor (the <20% case is
    // already a blocker above, forcing score 0 regardless).
    score = Math.round((contentCoveragePercent / 80) * 100);
  }

  return axis('C2-integrity', score, blockers, notes);
}

// ---------------------------------------------------------------------------
// C3 — hidden information
// ---------------------------------------------------------------------------

function scoreC3(adapter: AnyGameAdapter, options: Required<ScoreOptions>): AxisResult {
  const notes: string[] = [];

  if (adapter.spec.perfectInformation === true) {
    if (adapter.hiddenInfoProbe) {
      return axis('C3-hidden-info', 0, [
        {
          code: 'C3_PERFECT_INFO_CONTRADICTION',
          message: 'spec.perfectInformation is true but adapter.hiddenInfoProbe is also implemented',
          remediation:
            'Perfect-information games have nothing to hide: remove hiddenInfoProbe, or unset spec.perfectInformation if this game does have hidden state. ' +
            '보통 이건 완전정보 게임(체스처럼 모두에게 보이는 게임)으로 선언했는데, 실제로는 숨김 정보 검사 코드가 남아있어 설정이 서로 모순될 때 발생합니다.',
        },
      ], notes);
    }
    notes.push('완전정보 게임 — 은닉 검사 해당 없음');
    return axis('C3-hidden-info', 100, [], notes);
  }

  if (!adapter.hiddenInfoProbe) {
    return axis('C3-hidden-info', 0, [
      {
        code: 'C3_NO_PROBE',
        message: 'adapter.hiddenInfoProbe is not implemented',
        remediation:
          'Implement HiddenInfoProbe.mutateHidden so observation invariance to hidden-info mutation can be verified. ' +
          '보통 이건 상대의 손패나 숨겨진 카드처럼, 게임에 비공개 정보가 있는데도 그걸 검증할 방법이 어댑터에 아직 없을 때 발생합니다.',
      },
    ], notes);
  }

  const probe = adapter.hiddenInfoProbe;
  const blockers: AxisBlocker[] = [];
  let anyMutationApplied = false;

  for (let i = 0; i < options.c3SampleStates; i += 1) {
    const gameSeed = options.seedBase + 4000 + i;
    let state = adapter.createInitialState(gameSeed);
    // Walk a few random steps so states are not always the initial deal.
    for (let step = 0; step < i; step += 1) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      const legal = adapter.getLegalChoices(state);
      state = adapter.applyChoice(state, legal[0]);
    }
    const decision = adapter.currentDecision(state);
    const viewer: PlayerId = decision ? decision.player : 0;

    const before = adapter.getObservation(state, viewer);
    const rng = createRng(options.seedBase + 5000 + i);
    const mutated = probe.mutateHidden(state, viewer, rng);
    if (mutated === null) {
      continue;
    }
    anyMutationApplied = true;
    const after = adapter.getObservation(mutated, viewer);
    if (canonicalJson(before) !== canonicalJson(after)) {
      blockers.push({
        code: 'C3_OBSERVATION_LEAK',
        message: `mutating hidden information changed viewer ${viewer}'s observation at seed ${gameSeed}`,
        remediation:
          'getObservation must depend only on information the viewer is allowed to see. ' +
          '보통 상대의 손패/뒷면 카드/비공개 정보가 관찰 객체에 그대로 노출되고 있을 때 발생합니다. 원본 게임에서 그 정보가 진짜 숨겨져 있는지 다시 확인하세요.',
      });
    }
  }

  if (!anyMutationApplied) {
    blockers.push({
      code: 'C3_PROBE_NEVER_MUTATED',
      message: 'hiddenInfoProbe.mutateHidden returned null for every sampled state',
      remediation:
        'mutateHidden should return a mutated state whenever hidden information exists for the viewer. ' +
        '보통 이건 검사 코드가 숨길 정보를 하나도 찾지 못했을 때 발생합니다 — 게임에 정말 비공개 정보가 있다면 mutateHidden이 그 정보를 실제로 바꾸도록 구현돼 있는지 확인하세요.',
    });
  } else {
    notes.push('hiddenInfoProbe mutated hidden information without changing the viewer observation.');
  }

  return axis('C3-hidden-info', blockers.length === 0 ? 100 : 0, blockers, notes);
}

// ---------------------------------------------------------------------------
// C4 — throughput
// ---------------------------------------------------------------------------

function scoreC4(adapter: AnyGameAdapter, options: Required<ScoreOptions>): AxisResult {
  const notes: string[] = [];
  const blockers: AxisBlocker[] = [];

  const start = process.hrtime.bigint();
  let completed = 0;
  let totalDecisions = 0;
  for (let i = 0; i < options.c4SampleGames; i += 1) {
    const gameSeed = options.seedBase + 6000 + i;
    const botSeedBase = options.seedBase + 7000 + i;
    const result = playRandomGame(adapter, gameSeed, botSeedBase);
    if (result.kind === 'completed') {
      completed += 1;
      totalDecisions += result.decisions;
    }
  }
  const elapsedNanos = process.hrtime.bigint() - start;
  const elapsedSeconds = Number(elapsedNanos) / 1_000_000_000;
  const gamesPerSecond = elapsedSeconds > 0 ? completed / elapsedSeconds : Infinity;
  const decisionsPerSecond = elapsedSeconds > 0 ? totalDecisions / elapsedSeconds : Infinity;

  // A4: decisions/sec is the primary throughput signal — games/sec alone
  // conflates game length with adapter speed (a slow adapter playing short
  // games can look faster than a fast adapter playing long games).
  notes.push(
    `measured ${decisionsPerSecond.toFixed(1)} decisions/sec (${totalDecisions} decisions across ${completed} completed games).`,
  );
  notes.push(`measured ${gamesPerSecond.toFixed(1)} games/sec over ${options.c4SampleGames} sampled games (reported only, not scored).`);

  if (decisionsPerSecond < options.c4MinDecisionsPerSecond) {
    blockers.push({
      code: 'C4_THROUGHPUT_TOO_LOW',
      message: `throughput ${decisionsPerSecond.toFixed(1)} decisions/sec is below the hard floor of ${options.c4MinDecisionsPerSecond}`,
      remediation:
        'Profile and optimize createInitialState/applyChoice/getLegalChoices for the hot loop. ' +
        '보통 이건 게임 로직 자체가 무겁거나(초기화, 합법 수 계산 등), 매 수마다 불필요한 연산을 반복하며 최적화가 안 됐을 때 발생합니다.',
    });
    return axis('C4-throughput', 0, blockers, notes);
  }

  const ratio = Math.min(1, decisionsPerSecond / options.c4TargetDecisionsPerSecond);
  const score = Math.round(ratio * 100);
  return axis('C4-throughput', score, blockers, notes);
}

// ---------------------------------------------------------------------------
// C5 — baseline ecosystem
// ---------------------------------------------------------------------------

function scoreC5(adapter: AnyGameAdapter, options: Required<ScoreOptions>): AxisResult {
  const blockers: AxisBlocker[] = [];
  const notes: string[] = [];

  const identitySeeds = Array.from({ length: options.c5IdentitySeeds }, (_, i) => options.seedBase + 8000 + i);
  const identity = calibrateIdentity(adapter, adapter.baselines.random, identitySeeds, options.seedBase + 9000);

  // The identity expectation is NOT universally 0.5 — that is a 2-player
  // coincidence. For a symmetric solo-winner game the per-player expectation is
  // 1/playerCount (free-for-all) or 1/teamCount (team games). Tie handling can
  // shift this slightly for 3+ players, so the tolerance is a band, not a point.
  //
  // hiddenTeamStructure games (Avalon-like: factions exist but membership is
  // hidden, so spec.teams cannot be declared) break this formula entirely —
  // the true expectation is driven by faction-size ratios the harness has no
  // way to know statically, not by 1/playerCount (docs/GAP-ANALYSIS-10.md M1).
  // For those games identityCenter is instead pinned to the just-measured
  // meanWinRate itself, which makes the fairness comparison below trivially
  // pass by construction (there is nothing else to compare it against without
  // faction-size ground truth) while leaving the seat-bias check below —
  // C5's actual defense against a repeat of the seat-bias incident
  // (DESIGN.md §1) — fully active and unaffected.
  const identityCenter = adapter.spec.hiddenTeamStructure
    ? identity.meanWinRate
    : adapter.spec.teams
      ? 1 / adapter.spec.teams.length
      : 1 / adapter.spec.playerCount;
  const identityCenterLabel = adapter.spec.hiddenTeamStructure
    ? 'measured meanWinRate (hiddenTeamStructure — no static 1/N expectation)'
    : `1/${adapter.spec.teams ? 'teamCount' : 'playerCount'}`;

  notes.push(
    `identity calibration: meanWinRate=${identity.meanWinRate.toFixed(3)} ` +
      `(expected center ${identityCenter.toFixed(3)} = ${identityCenterLabel}), ` +
      `seatWinRates=[${identity.seatWinRates.map((r) => r.toFixed(3)).join(', ')}], bias=${identity.bias.toFixed(3)}`,
  );

  if (Math.abs(identity.meanWinRate - identityCenter) > 0.05) {
    blockers.push({
      code: 'C5_IDENTITY_NOT_FAIR',
      message:
        `random self-play mean win rate ${identity.meanWinRate.toFixed(3)} is not within ` +
        `${identityCenter.toFixed(3)}+/-0.05 (expected ${identityCenterLabel})`,
      remediation:
        'Check seatingPlan coverage and outcome/scoring symmetry for a fair game. ' +
        '보통 이건 좌석(선공/후공 등) 순서 구성이 한쪽에 유리하게 치우쳐 있거나, 점수/승패 판정 로직이 플레이어 간에 비대칭적으로 동작할 때 발생합니다.',
    });
  }
  if (identity.bias > 0.3) {
    notes.push(
      `seat bias ${identity.bias.toFixed(3)} exceeds 0.3 — investigate first-move/seat advantage before trusting paired stats.`,
    );
  }

  const headToHeadSeeds = Array.from(
    { length: options.c5HeadToHeadSeeds },
    (_, i) => options.seedBase + 10_000 + i,
  );
  const outcomes: PairedSeedOutcome[] = [];
  for (const seed of headToHeadSeeds) {
    const result = runPairedBlock(adapter, adapter.baselines.heuristic, adapter.baselines.random, seed, seed);
    if ('defect' in result) {
      blockers.push({
        code: 'C5_HEAD_TO_HEAD_DEFECT',
        message: `heuristic-vs-random paired block hit a defect at seed ${seed}: ${result.defect.message}`,
        remediation:
        'Fix the underlying adapter/bot defect before baselines can be trusted. ' +
        '보통 이건 C2에서와 같은 종류의 규칙 구현 오류가 특정 봇 조합/시드에서만 드러날 때 발생합니다.',
      });
      break;
    }
    outcomes.push(result);
  }

  if (outcomes.length > 0) {
    const bootstrap = bootstrapPairedSeedBlocks(outcomes, {
      iterations: 2000,
      confidenceLevel: 0.95,
      seed: options.seedBase + 11_000,
    });
    const significantlyDifferent =
      bootstrap.winRate.lower > identityCenter || bootstrap.winRate.upper < identityCenter;
    notes.push(
      `heuristic vs random: pointWinRate=${bootstrap.pointWinRate.toFixed(3)}, ` +
        `CI=[${bootstrap.winRate.lower.toFixed(3)}, ${bootstrap.winRate.upper.toFixed(3)}]` +
        (significantlyDifferent ? '' : ` (not significantly different from ${identityCenter.toFixed(3)})`),
    );
    if (!significantlyDifferent) {
      blockers.push({
        code: 'C5_HEURISTIC_NOT_DISTINCT',
        message: `heuristic baseline win rate against random is not significantly different from ${identityCenter.toFixed(3)}`,
        remediation:
          'The heuristic baseline should play distinctly from random (stronger or weaker, but not equivalent). ' +
          '보통 이건 "휴리스틱" 봇이라고 이름 붙였지만 실제로는 무작위 봇과 사실상 같은 방식으로 수를 고르고 있을 때 발생합니다.',
      });
    } else if (bootstrap.pointWinRate < identityCenter) {
      notes.push('heuristic is significantly weaker than random for this game — direction noted, not penalized.');
    }
  }

  return axis('C5-baselines', blockers.length === 0 ? 100 : 0, blockers, notes);
}

// ---------------------------------------------------------------------------
// C6 — strategy surface
// ---------------------------------------------------------------------------

function scoreC6(adapter: AnyGameAdapter, options: Required<ScoreOptions>): AxisResult {
  const notes: string[] = [];

  if (adapter.strategySurface.length === 0) {
    return axis('C6-strategy-surface', 0, [
      {
        code: 'C6_EMPTY_STRATEGY_SURFACE',
        message: 'adapter.strategySurface is empty',
        remediation:
          'Add at least one StrategyFlagSpec candidate-injection point. ' +
          '보통 이건 봇의 성향(공격적/방어적, 특정 콤보 선호 등)을 조절할 수 있는 지점을 아직 하나도 게임에 만들지 않았을 때 발생합니다.',
      },
    ], notes);
  }

  const probeSeeds = Array.from({ length: options.c6ProbeSeeds }, (_, i) => options.seedBase + 12_000 + i);
  const baseFactory = adapter.baselines.heuristic;
  const playerCount = adapter.spec.playerCount;
  const seating = firstSeating(adapter);

  let distinctCount = 0;
  const flagNotes: string[] = [];

  for (const flagSpec of adapter.strategySurface) {
    const variantFactory = flagSpec.apply(baseFactory);
    let distinct = false;
    for (const seed of probeSeeds) {
      const variantFactories: AnyBotFactory[] = [variantFactory];
      const baseFactories: AnyBotFactory[] = [baseFactory];
      for (let i = 1; i < playerCount; i += 1) {
        variantFactories.push(baseFactory);
        baseFactories.push(baseFactory);
      }
      const botSeeds = variantFactories.map((_, index) => seed + index);
      const variantResult = runMatch(adapter, variantFactories, seed, botSeeds, seating);
      const baseResult = runMatch(adapter, baseFactories, seed, botSeeds, seating);
      if (variantResult.kind === 'defect' || baseResult.kind === 'defect') {
        continue;
      }
      const same =
        variantResult.choiceKeys.length === baseResult.choiceKeys.length &&
        variantResult.choiceKeys.every((key, index) => key === baseResult.choiceKeys[index]);
      if (!same) {
        distinct = true;
        break;
      }
    }
    if (distinct) {
      distinctCount += 1;
    } else {
      flagNotes.push(`"${flagSpec.flag}" produced no observable behavior change across probe seeds (no-op).`);
    }
  }

  const fraction = distinctCount / adapter.strategySurface.length;
  notes.push(
    `${distinctCount}/${adapter.strategySurface.length} strategySurface flag(s) are behaviorally distinct.`,
  );
  notes.push(...flagNotes);

  const blockers: AxisBlocker[] =
    distinctCount === 0
      ? [
          {
            code: 'C6_ALL_NOOP',
            message: 'every strategySurface flag is a behavioral no-op on the probe seeds',
            remediation:
              'Fix strategy flags so their apply() wrapper changes at least one decision. ' +
              '보통 이 전략 플래그가 실제로는 아무 결정도 바꾸지 않는 장식적 변경(정렬 순서 등)만 하고 있을 때 발생합니다. 봇이 실제로 다른 선택을 하게 만드는 로직을 넣으세요.',
          },
        ]
      : [];

  return axis('C6-strategy-surface', Math.round(fraction * 100), blockers, notes);
}

// ---------------------------------------------------------------------------
// C7 — parity
// ---------------------------------------------------------------------------

function scoreC7(adapter: AnyGameAdapter): AxisResult {
  const notes: string[] = [];

  if (!adapter.replayFixtures || adapter.replayFixtures.length === 0) {
    return axis('C7-parity', 0, [
      {
        code: 'C7_NO_FIXTURES',
        message: 'adapter.replayFixtures is missing or empty',
        remediation:
          'Capture real-game replay fixtures (choiceKeys + finalScores) to prove parity. ' +
          '보통 이건 실제 사람이 플레이했거나 원본 게임 엔진에서 재생한 진짜 판의 기록이 아직 하나도 캡처되지 않았을 때 발생합니다.',
      },
    ], notes);
  }

  const blockers: AxisBlocker[] = [];
  let originalCount = 0;
  let originalPassed = 0;
  let selfPlayCount = 0;
  let selfPlayPassed = 0;

  for (const fixture of adapter.replayFixtures) {
    const isOriginal = fixture.provenance === 'original-replay';
    let state = adapter.createInitialState(fixture.seed);
    let ok = true;
    for (const choiceKey of fixture.choiceKeys) {
      const decision = adapter.currentDecision(state);
      if (!decision) {
        ok = false;
        break;
      }
      const legal = adapter.getLegalChoices(state);
      const matching = legal.find((choice) => adapter.encodeChoice(choice) === choiceKey);
      if (matching === undefined) {
        ok = false;
        break;
      }
      try {
        state = adapter.applyChoice(state, matching);
      } catch {
        ok = false;
        break;
      }
    }
    const outcome = ok ? adapter.getOutcome(state) : null;
    const scoresMatch =
      outcome !== null &&
      outcome.scores.length === fixture.finalScores.length &&
      outcome.scores.every((score, index) => score === fixture.finalScores[index]);

    if (isOriginal) {
      originalCount += 1;
    } else {
      selfPlayCount += 1;
    }

    if (ok && scoresMatch) {
      if (isOriginal) {
        originalPassed += 1;
      } else {
        selfPlayPassed += 1;
      }
    } else {
      blockers.push({
        code: 'C7_FIXTURE_MISMATCH',
        message: `replay fixture "${fixture.id}" did not replay to its recorded finalScores`,
        remediation:
          'Verify the fixture was captured from this adapter version and choiceKeys/encodeChoice agree. ' +
          '보통 어댑터 코드를 고친 뒤 픽스처를 재생성하지 않았거나, 원본 게임의 실제 결과와 어댑터의 시뮬레이션 결과가 어긋날 때 발생합니다.',
      });
    }
  }

  const passed = originalPassed + selfPlayPassed;
  notes.push(`${passed}/${adapter.replayFixtures.length} replay fixture(s) replayed to their recorded outcome.`);

  let score: number;
  if (originalCount === 0) {
    score = selfPlayCount > 0 ? Math.min(60, Math.round((selfPlayPassed / selfPlayCount) * 100)) : 0;
    notes.push(
      '원본 게임 리플레이 증거 없음 — self-play 재현성만 확인됨, 정합성 미증명(최대 60점 캡). ' +
        'provenance: "original-replay"인 fixture를 최소 하나 이상 추가해야 캡이 해제됩니다.',
    );
  } else {
    score = Math.round((passed / (originalCount + selfPlayCount)) * 100);
  }

  return axis('C7-parity', score, blockers, notes);
}

// ---------------------------------------------------------------------------

/** Maps blueprint fields onto their ScoreOptions counterparts (field names
 * diverge, e.g. c2PlayoutCount <-> c2Playouts). Only fields the blueprint
 * actually derives are included — the rest of DEFAULTS is untouched. */
function blueprintToScoreOptions(blueprint: PipelineBlueprint): Partial<ScoreOptions> {
  return {
    c2Playouts: blueprint.c2PlayoutCount,
    c4MinDecisionsPerSecond: blueprint.c4MinDecisionsPerSecond,
    c5IdentitySeeds: blueprint.c5IdentitySeedCount,
    c5HeadToHeadSeeds: blueprint.c5HeadToHeadSeedCount,
  };
}

export function scoreAdapter(
  adapter: AnyGameAdapter,
  options: ScoreOptions = {},
): ConformanceReport {
  const classification = classifyGame(adapter.spec, adapter.contentInventory);
  const blueprint = deriveBlueprint(classification);
  // Priority: explicit caller options > blueprint-derived defaults > DEFAULTS.
  const resolved: Required<ScoreOptions> = {
    ...DEFAULTS,
    ...blueprintToScoreOptions(blueprint),
    ...options,
  };

  const axes: AxisResult[] = [
    scoreC0(adapter),
    scoreC1(adapter, resolved),
    scoreC2(adapter, resolved),
    scoreC3(adapter, resolved),
    scoreC4(adapter, resolved),
    scoreC5(adapter, resolved),
    scoreC6(adapter, resolved),
    scoreC7(adapter),
  ];

  return buildReport(adapter.spec.gameId, axes, resolved.threshold);
}
