/**
 * S2 scaffold generator (docs/GAP-ANALYSIS-13.md §3 S2): turns a validated
 * `GameProfile` into ① an archetype determination (perfect-info/hidden-info/
 * multi-step-turn/content-heavy, composed rather than exclusive — a game can
 * be e.g. hidden-info AND multi-step-turn at once) and ② the TypeScript
 * source text for the two starting-point files a new onboarding needs:
 * `src/reference/<gameId>.ts` (adapter skeleton) and
 * `src/reference/runners/<gameId>.ts` (a `runOnboardingPipeline` caller,
 * ~40 lines, per §3 S1).
 *
 * **Why this file only returns strings and never touches the filesystem**
 * (the task's required design-decision doc comment): `onboarding/` is a pure
 * layer under `src/__tests__/dependency-rules.test.ts` — it may import
 * `contract`/`kernel`/`loop` but performs no I/O, and every existing module
 * in this directory (`profile.ts`, `readiness-estimate.ts`) is a pure
 * function of its inputs. Writing the generated text to
 * `src/reference/<gameId>.ts` is an inherent side effect (and only makes
 * sense once, at a CLI's discretion — `npm run onboard -- scaffold`,
 * docs/GAP-ANALYSIS-13.md §3 S3, not yet built), so this module produces the
 * two file contents as plain strings and leaves the `writeFileSync` call (an
 * app-boundary responsibility, like `reference/runners/*.ts`'s own
 * `saveRunIfAbsent`) to that future CLI. This mirrors `artifacts/rulebook.ts`
 * (S0), which renders Markdown as a string for the same reason one layer
 * over.
 *
 * **Why `renderAdapterScaffold`'s generated code lives in `reference/` at
 * write time, not `onboarding/`**: the generated *adapter* is game
 * knowledge — `src/__tests__/dependency-rules.test.ts` restricts `reference/`
 * to importing only `contract`/`kernel`, exactly the two imports the
 * generated skeleton uses. This module itself imports neither; it only knows
 * the *names* of `contract/types.ts`'s exports as strings to emit, so it
 * never needs to import `contract` and stays a pure `onboarding/` file.
 */

import type { GameProfile } from './profile';

// -----------------------------------------------------------------------
// Archetype determination (§3 S2's 4-row table). Archetypes compose — a
// hidden-information, multi-step-turn game (e.g. Dominion) gets both
// 'hidden-info' and 'multi-step-turn' skeleton pieces, not one or the other.
// -----------------------------------------------------------------------

export type Archetype =
  | 'perfect-info'
  | 'hidden-info'
  | 'multi-step-turn'
  | 'content-heavy';

export interface ArchetypeDetermination {
  /** Composed set of archetypes this profile matched, in table order. */
  readonly archetypes: readonly Archetype[];
  /**
   * One judgment-basis string per entry of `archetypes`, same order — always
   * names the profile field inspected (per §3 S2's "판정 근거" column) so a
   * scaffold's output can show its work, and always ends with an explicit
   * override reminder for the two heuristic (non-binary-field) archetypes,
   * per §5's "아키타입 오판정 가능성" risk.
   */
  readonly reasons: readonly string[];
}

/**
 * Perfect-info vs. hidden-info is the one binary, mutually-exclusive pair in
 * the table (a game either declares hidden information or it doesn't); the
 * other two archetypes are heuristic proxies over fields `GameProfile` does
 * not (yet) model directly — see each branch's reason string for the caveat.
 */
export function deriveArchetypes(profile: GameProfile): ArchetypeDetermination {
  const archetypes: Archetype[] = [];
  const reasons: string[] = [];

  if (profile.hiddenInformation.length === 0) {
    archetypes.push('perfect-info');
    reasons.push(
      'perfect-info: hiddenInformation 배열이 비어 있음 — §3 S2 표의 perfect-info 판정 근거 그대로.',
    );
  } else {
    archetypes.push('hidden-info');
    reasons.push(
      `hidden-info: hiddenInformation에 ${profile.hiddenInformation.length}개 항목이 선언됨 — §3 S2 표의 hidden-info 판정 근거 그대로.`,
    );
  }

  // Heuristic proxy: GameProfile has no dedicated "sub-decisions per turn"
  // field, so 2+ distinct declared decisionPoints is used as the closest
  // available signal for "한 턴 복수 결정" (§3 S2 표). Can false-positive on
  // games with several decision *types* that never co-occur inside one turn
  // — override with a manual archetype list if this is wrong for a specific
  // game (§5 "아키타입 오판정 가능성").
  if (profile.decisionPoints.length >= 2) {
    archetypes.push('multi-step-turn');
    reasons.push(
      `multi-step-turn (근사 판정): decisionPoints에 ${profile.decisionPoints.length}개 결정 지점이 선언됨 — 한 턴 내 복수 결정 가능성의 근사 신호(GameProfile에 전용 필드 없음). ` +
        '실제로 한 턴에 결정 지점이 하나뿐이면 이 판정은 오판정이니 스캐폴드 생성 시 --archetype으로 제외하라.',
    );
  }

  // Heuristic proxy: same limitation — GameProfile has no card/content-count
  // field, so a non-empty knownIssues list (§3 S2 표's named field) is used
  // as the closest available signal for "카드 인벤토리 규모 선언". Can
  // false-positive on games whose knownIssues are unrelated bugs/notes.
  if (profile.knownIssues.length > 0) {
    archetypes.push('content-heavy');
    reasons.push(
      `content-heavy (근사 판정): knownIssues에 ${profile.knownIssues.length}개 항목이 선언됨 — 콘텐츠 규모/미구현 목록 존재의 근사 신호(§3 S2 표의 knownIssues 판정 근거). ` +
        '실제로 콘텐츠 규모와 무관한 메모라면 이 판정은 오판정이니 스캐폴드 생성 시 --archetype으로 제외하라.',
    );
  }

  return { archetypes, reasons };
}

// -----------------------------------------------------------------------
// ONBOARDING-GUIDE.md §2's G-Convert checklist, numbered in file order —
// every `TODO(onboard): §2-<n>` marker in a generated adapter must reference
// one of these ids. Exported so the self-verification test (and any future
// CLI progress report) can check markers against this single list instead of
// re-deriving the numbering by hand.
// -----------------------------------------------------------------------

export interface ChecklistItem {
  readonly id: string; // e.g. '§2-1'
  readonly label: string;
}

export const G_CONVERT_CHECKLIST: readonly ChecklistItem[] = [
  { id: '§2-1', label: '룰 엔진 분리' },
  { id: '§2-2', label: '결정론 (createInitialState(seed) -> createRng(seed))' },
  { id: '§2-3', label: '게임 중 무작위성은 상태에 RNG를 싣는다' },
  { id: '§2-4', label: '관찰 빌더 (getObservation, 은닉 정보 불누출)' },
  { id: '§2-5', label: 'encodeChoice (동일 선택 -> 동일 문자열)' },
  { id: '§2-6', label: 'invariants (보존 법칙 선언)' },
  { id: '§2-7', label: '기준선 2종 (random + heuristic)' },
  { id: '§2-8', label: 'strategySurface (전략 플래그 3~10개)' },
  { id: '§2-9', label: 'hiddenInfoProbe 또는 spec.perfectInformation' },
  { id: '§2-10', label: '멀티스텝 턴 (턴 내부 상태 필드)' },
  { id: '§2-11', label: 'replayFixtures (원본 리플레이 또는 self-play fixture)' },
  { id: '§2-12', label: '어댑터 1개 = 게임 설정 1개' },
  { id: '§2-13', label: '게임 단위 = 독립 채점 가능한 최소 단위' },
];

function todo(id: string, note: string): string {
  const item = G_CONVERT_CHECKLIST.find((c) => c.id === id);
  if (item === undefined) {
    throw new Error(`renderAdapterScaffold: unknown checklist id "${id}"`);
  }
  return `TODO(onboard): ${id} — ${note}`;
}

// -----------------------------------------------------------------------
// Identifier helpers (gameId -> TS-safe names).
// -----------------------------------------------------------------------

function toPascalCase(gameId: string): string {
  return gameId
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function toCamelCase(gameId: string): string {
  const pascal = toPascalCase(gameId);
  return pascal.length === 0 ? pascal : pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Renders the adapter skeleton source for `src/reference/<gameId>.ts`. Every
 * GameAdapter-required member is present with a correctly-typed signature
 * (so `tsc --noEmit` passes once dropped into `src/reference/`) and a body
 * that throws a `TODO(onboard): §2-<n>` error — the throw is deliberate, not
 * a placeholder oversight: an unimplemented adapter must fail loudly the
 * moment anything calls it (scoreAdapter, a wave), not silently return
 * garbage that could pass a shallow check.
 */
export function renderAdapterScaffold(
  profile: GameProfile,
  determination: ArchetypeDetermination,
): string {
  const cap = toPascalCase(profile.gameId);
  const camel = toCamelCase(profile.gameId);
  const isHidden = determination.archetypes.includes('hidden-info');
  const isPerfect = determination.archetypes.includes('perfect-info');
  const isMultiStep = determination.archetypes.includes('multi-step-turn');
  const isContentHeavy = determination.archetypes.includes('content-heavy');

  const decisionPointsLiteral =
    profile.decisionPoints.length > 0
      ? profile.decisionPoints
          .map(
            (dp) =>
              `      { id: ${JSON.stringify(dp.id)}, description: ${JSON.stringify(dp.description)} },`,
          )
          .join('\n')
      : `      // ${todo('§2-1', '이 게임의 실제 결정 지점으로 교체 — GameProfile.decisionPoints가 비어 있었음')}
      { id: 'placeholder', description: 'placeholder decision point' },`;

  const seatingPlanLiteral =
    profile.playerCount >= 1
      ? `[${Array.from({ length: profile.playerCount }, (_, i) => i).join(', ')}]`
      : '[0]';

  // Note: the surrounding import statement is already `import type { ... }`
  // (all of `contract/types`'s exports here are types), so members must NOT
  // repeat their own `type` modifier — TS2206 rejects `type X` inside an
  // `import type {...}` statement.
  const hiddenInfoImport = isHidden ? ', HiddenInfoProbe, Rng' : '';

  const hiddenInfoProbeBlock = isHidden
    ? `
/**
 * ${todo('§2-9', 'hiddenInfoProbe.mutateHidden: viewer에게 은닉된 정보만 재분배(상대 손패/덱 순서 등). viewer 자신의 정보와 공개 정보는 절대 건드리지 않는다')}
 * (ONBOARDING-GUIDE.md §6 "hiddenInfoProbe는 상대 손패+스톡 재분배가 표준형").
 *
 * 결정화 훅(선택, ONBOARDING-GUIDE.md §9): 은닉 정보 게임은
 * \`sampleStateFromObservation(observation, player, rng)\`도 구현하면
 * IS-MCTS 탐색 후보 투입의 전제가 되고, 왕복 검증(getObservation(sampled,
 * viewer) === observation + invariants 통과)이 회계 버그를 잡아내는
 * 온보딩 품질 검사를 겸한다 — 지금은 이 훅 자체가 없으므로 주석으로만
 * 남긴다. 구현 시 ONBOARDING-GUIDE.md §9의 3종 테스트(왕복 일치 ·
 * invariants · 시드 민감성)를 함께 고정하라.
 */
const hiddenInfoProbe: HiddenInfoProbe<${cap}State> = {
  mutateHidden(state, viewer, rng) {
    void state;
    void viewer;
    void rng;
    throw new Error('${todo('§2-9', 'mutateHidden 구현 필요')}');
  },
};
`
    : '';

  const multiStepComment = isMultiStep
    ? `
/**
 * ${todo('§2-10', '멀티스텝 턴 — 한 턴이 여러 원자적 결정으로 쪼개지는지 확인하고, 그렇다면 턴 내부 진행 상황을 상태 필드로 직접 관리하라')}
 * (ONBOARDING-GUIDE.md §2 "멀티스텝 턴", 스플랜더의 \`takenColors: readonly Color[]\`
 * 패턴을 모델로 함 — "이번 턴에 이미 소비한 하위 결정"을 상태에 기록해두고
 * currentDecision이 매 sub-decision마다 그 필드를 보고 다음 하위 결정을
 * 새로 계산한다). 이 아키타입은 decisionPoints 개수(${profile.decisionPoints.length}개)로부터
 * 근사 판정됐다 — 실제로 한 턴 1결정이면 이 패턴은 필요 없다.
 *
 * 예:
 *   interface ${cap}State {
 *     ...
 *     readonly takenThisTurn: readonly string[]; // 이번 턴에 이미 소비한 하위 결정 id들
 *   }
 */`
    : '';

  const contentHeavyComment = isContentHeavy
    ? `
/**
 * ${todo('§2-1', '콘텐츠 커버리지 — contentInventory + exercisedContent를 선언해 무작위 플레이아웃이 콘텐츠 전체를 실제로 뽑는지 측정하라')}
 * (ONBOARDING-GUIDE.md §5.7 "콘텐츠 커버리지 선언". 미선언 시 C2는 뽑힌
 * 콘텐츠만 검사한 것이며 리포트에 커버리지 미측정으로 표시된다). 예:
 *   contentInventory: [{ id: 'CardName', description: '...' }, ...],
 *   exercisedContent: (finalState) => [...실제로 등장한 콘텐츠 id들],
 * §5.7의 증분 온보딩 전략도 함께 참고: 전체 콘텐츠를 한 번에 구현하지 말고
 * 기본 부분집합(\`${camel}-core\`처럼 이름 붙여)으로 먼저 G-Score를 통과시켜라.
 */`
    : '';

  const perfectInformationField = isPerfect ? '\n    perfectInformation: true,' : '';

  const hiddenProbeInAdapter = isHidden ? '\n  hiddenInfoProbe,' : '';

  return `/**
 * ${profile.gameId} — adapter scaffold generated by src/onboarding/scaffold.ts
 * (docs/GAP-ANALYSIS-13.md §3 S2). Every GameAdapter-required member below
 * is present with a correctly-typed signature so this file typechecks
 * on its own; every body throws a TODO(onboard)-tagged error (see the
 * §2-numbered markers below) until a coding agent replaces it with this
 * game's real logic — an unimplemented
 * adapter must fail loudly the instant anything calls it, not silently
 * return garbage.
 *
 * Archetype determination (docs/GAP-ANALYSIS-13.md §3 S2 table):
${determination.reasons.map((r) => ` *   - ${r}`).join('\n')}
 *
 * Next steps: fill in every TODO(onboard) marker below, then run
 * \`grep -rn "TODO(onboard)" src/reference/${profile.gameId}.ts\` until it is
 * empty and \`npm run typecheck\` passes (G2 게이트, docs/GAP-ANALYSIS-13.md §2).
 *
 * 각 멤버(GameAdapter/BotFactory 등)의 정확한 시그니처·의미의 정본은
 * \`src/contract/types.ts\`입니다 — TODO(onboard)를 채우기 전에 먼저 그 파일을
 * 읽어보세요.
 */

import type {
  BotFactory,
  GameAdapter,
  Outcome,
  PendingDecision,
  PlayerId,
  ReplayFixture,
  StrategyFlagSpec${hiddenInfoImport},
} from '../contract/types';
import { createRng } from '../kernel/rng';

export interface ${cap}State {
  // ${todo('§2-1', '이 게임의 실제 상태 필드로 교체 — 원본 게임의 룰 엔진을 순수 함수로 재구성한 결과')}
  readonly placeholder?: never;
}

export interface ${cap}Observation {
  // ${todo('§2-4', '이 게임의 관찰 필드로 교체 — 은닉 정보가 절대 여기 노출되지 않아야 한다')}
  readonly self: PlayerId;
}

export type ${cap}Choice = unknown; // ${todo('§2-1', '이 게임의 실제 선택(Choice) 타입으로 교체')}
${multiStepComment}${contentHeavyComment}
function createInitialState(seed: number): ${cap}State {
  const rng = createRng(seed);
  void rng;
  throw new Error('${todo('§2-2', 'createInitialState 구현 필요 — createRng(seed)에서 모든 무작위성이 출발해야 한다')}');
}

function currentDecision(state: ${cap}State): PendingDecision | null {
  void state;
  throw new Error('${todo('§2-1', 'currentDecision 구현 필요 — 다음에 결정할 플레이어와 결정 지점 id를 반환')}');
}

function getObservation(state: ${cap}State, player: PlayerId): ${cap}Observation {
  void state;
  void player;
  throw new Error('${todo('§2-4', 'getObservation 구현 필요 — 은닉 정보 유출 여부를 반드시 검증')}');
}

function getLegalChoices(state: ${cap}State): readonly ${cap}Choice[] {
  void state;
  throw new Error('${todo('§2-1', 'getLegalChoices 구현 필요')}');
}

function applyChoice(state: ${cap}State, choice: ${cap}Choice): ${cap}State {
  void state;
  void choice;
  throw new Error('${todo('§2-1', 'applyChoice 구현 필요 — getLegalChoices가 반환하지 않은 선택에는 throw해야 한다')}');
}

function getOutcome(state: ${cap}State): Outcome | null {
  void state;
  throw new Error('${todo('§2-1', 'getOutcome 구현 필요 — 종국 보장 규칙이 실제로 소스에 존재하는지 검증하라(ONBOARDING-GUIDE.md §1)')}');
}

function encodeChoice(choice: ${cap}Choice): string {
  void choice;
  throw new Error('${todo('§2-5', 'encodeChoice 구현 필요 — 동일 선택은 항상 동일 문자열, 정렬 불안정성 금지')}');
}

const randomBaseline: BotFactory<${cap}Observation, ${cap}Choice> = (seed) => {
  void seed;
  throw new Error('${todo('§2-7', 'random 기준선 구현 필요 — legal에서 균등 무작위 선택')}');
};

const heuristicBaseline: BotFactory<${cap}Observation, ${cap}Choice> = (seed) => {
  void seed;
  throw new Error('${todo('§2-7', 'heuristic 기준선 구현 필요 — 단순하지만 결정적인 규칙(random보다 강할 필요는 없음)')}');
};

const exampleStrategyFlag: StrategyFlagSpec<${cap}Observation, ${cap}Choice> = {
  flag: 'exampleFlag',
  description: '${todo('§2-8', 'strategySurface 구현 필요 — 3~10개의 단순 전략 플래그로 시작')}',
  apply(base) {
    return (seed) => base(seed);
  },
};

const replayFixtures: readonly ReplayFixture[] = [
  // ${todo('§2-11', '원본 게임 리플레이(provenance: "original-replay") 또는 self-play fixture를 추가하라 — 없으면 C7이 60점으로 캡됨')}
];
${hiddenInfoProbeBlock}
export const ${camel}Adapter: GameAdapter<${cap}State, ${cap}Observation, ${cap}Choice> = {
  spec: {
    gameId: ${JSON.stringify(profile.gameId)},
    playerCount: ${profile.playerCount},
    decisionPoints: [
${decisionPointsLiteral}
    ],
    // ${todo('§2-1', 'seatingPlan을 후보(index 0)가 모든 좌석에 앉는 회전 순열로 교체 — 최소 playerCount개')}
    seatingPlan: [${seatingPlanLiteral}],
    maxDecisionsPerGame: 1000, // ${todo('§2-1', '이 게임의 실제 결정 수 상한으로 교체')}${perfectInformationField}
  },
  createInitialState,
  currentDecision,
  getObservation,
  getLegalChoices,
  applyChoice,
  getOutcome,
  encodeChoice,
  invariants: [], // ${todo('§2-6', "이 게임의 보존 법칙(카드 총수 등)을 여기 추가")}
  replayFixtures,
  baselines: {
    random: randomBaseline,
    heuristic: heuristicBaseline,
  },
  strategySurface: [exampleStrategyFlag],${hiddenProbeInAdapter}
};
`;
}

/**
 * Renders the ~40-line runner source for `src/reference/runners/<gameId>.ts`
 * — a thin app-boundary caller of `artifacts/onboarding-pipeline.ts`'s
 * `runOnboardingPipeline` (docs/GAP-ANALYSIS-13.md §3 S1/S2), modeled on
 * `reference/runners/catan.ts`'s wave-A section (the pipeline call, minus
 * that file's extra hand-rolled M4 field-mix wave B, which is
 * game-specific and out of scope for a starting-point scaffold).
 *
 * Deliberately carries no `TODO(onboard): §2-*` markers: every numbered
 * G-Convert checklist item that file's markers cover belongs to the
 * *adapter* (`renderAdapterScaffold`'s output), not this runner — the
 * runner's only unfilled slots are numeric wave-tuning config (seed counts,
 * clamp bounds, SPRT parameters), which are not G-Convert checklist items,
 * so they get plain comments pointing at where those numbers come from
 * instead of onboard markers.
 */
export function renderRunnerScaffold(profile: GameProfile): string {
  const cap = toPascalCase(profile.gameId);
  const camel = toCamelCase(profile.gameId);
  const gameId = profile.gameId;

  return `/**
 * ${gameId} — per-game execution entrypoint generated by
 * src/onboarding/scaffold.ts (docs/GAP-ANALYSIS-13.md §3 S2). Runs G-Score
 * conformance, then (once ready) the onboarding pipeline's noise-floor
 * calibration -> registry/ledger bootstrap -> baseline v1 -> wave A ->
 * summary/promotion (docs/GAP-ANALYSIS-13.md §3 S1's runOnboardingPipeline).
 *
 * Numeric config below (identitySeeds count, clamp bounds, SPRT params) is a
 * starting guess copied from an existing runner — revisit after the first
 * real \`noiseFloor\`/\`recommendedBlocks\` numbers come back (ONBOARDING-GUIDE.md
 * §2 게이트 수치는 이 값들을 대체하지 않고 파생 입력으로 쓴다).
 *
 * Every file under reference/runners/ is an app boundary
 * (src/__tests__/dependency-rules.test.ts's APP_BOUNDARY_PREFIXES) — the one
 * place allowed to call \`new Date().toISOString()\` for this game.
 *
 * The conformance report is persisted via \`RunStore\` (kind: 'conformance',
 * same pattern as the hand-written runners, e.g. reference/runners/gomoku.ts)
 * — without this, runs/${gameId}/summary.md's "온보딩 상태" section stays
 * stuck at "아직 온보딩 채점 안 됨" forever, because that section reads its
 * status back from \`RunStore.listRuns()\`, not from this process's own
 * console output (docs/GAP-ANALYSIS-13.md §9 Phase E 결함 #4). \`saveRun\`
 * throws on a runId that already exists (append-only evidence) — expected
 * from the second run onward, so it's swallowed.
 */

import { join } from 'node:path';

import { scoreAdapter } from '../../onboarding/score';
import { renderReportMarkdown } from '../../onboarding/report';
import { evaluateWaveReadiness } from '../../onboarding/wave-readiness';
import { runOnboardingPipeline } from '../../artifacts/onboarding-pipeline';
import { computeSourceDigest } from '../../artifacts/source-digest';
import { computeComparabilityKey, RunStore } from '../../artifacts/run-store';
import { canonicalJson, sha256Digest } from '../../kernel/digest';
import type { AnyBotFactory, AnyGameAdapter } from '../../contract/types';
import { ${camel}Adapter } from '../${gameId}';

const GAME_ID = ${JSON.stringify(gameId)};
const WAVE_ID = 'runner-wave-single-opponent';
const SOURCE_FILES = [join(__dirname, '..', '${gameId}.ts')];

function now(): string {
  return new Date().toISOString();
}

function saveConformanceRun(runStore: RunStore, adapter: AnyGameAdapter, conformance: ReturnType<typeof scoreAdapter>): void {
  const comparabilityKey = computeComparabilityKey({ gameId: adapter.spec.gameId, specDigest: sha256Digest(canonicalJson(adapter.spec)), baselineVersion: 'n/a', opponentId: 'n/a', seedBankIds: [] });
  try {
    runStore.saveRun({ gameId: GAME_ID, runId: 'conformance', kind: 'conformance', recordedAt: now(), comparabilityKey, payload: conformance, markdown: renderReportMarkdown(conformance) });
  } catch {
    // already recorded on a prior run — append-only, ignore.
  }
}

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const adapter = ${camel}Adapter as unknown as AnyGameAdapter;
  const runStore = new RunStore(rootDir);

  console.log(\`=== ${gameId} runner (rootDir=\${rootDir}) ===\`);

  const conformance = scoreAdapter(adapter);
  console.log(\`   score=\${conformance.overallScore} ready=\${conformance.ready}\`);
  saveConformanceRun(runStore, adapter, conformance);
  const readiness = evaluateWaveReadiness(conformance);
  if (!readiness.proceed) {
    console.log('conformance has non-parity blockers — stopping before wave execution.');
    return;
  }

  const identitySeeds = Array.from({ length: 60 }, (_, i) => 700_000 + i);
  const pipeline = runOnboardingPipeline(adapter, {
    gameId: GAME_ID,
    rootDir,
    adapter,
    sourceDigest: computeSourceDigest(SOURCE_FILES),
    noiseFloor: {
      baselineFactory: ${camel}Adapter.baselines.heuristic as unknown as AnyBotFactory,
      identitySeeds, botSeedBase: 600_000, bootstrap: { iterations: 2000, confidenceLevel: 0.95, seed: 42 },
      targetEffect: 0.05, zeroStdDevFallbackBlocks: 5, clamp: { min: 5, max: 20 },
    },
    baseline: {
      v1Notes: '순정 heuristic 기준선 (플래그 없음).',
      anchors: [{ anchorId: 'anchor-random', kind: 'random' }, { anchorId: 'anchor-heuristic', kind: 'heuristic' }],
    },
    wave: {
      waveId: WAVE_ID, opponent: 'heuristic', smokeMinBlocks: 5,
      bankIds: { smoke: '${gameId}-runner-smoke', prune: '${gameId}-runner-prune', holdout: '${gameId}-runner-holdout' },
      smokeSprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 }, screenProbeSeeds: [1, 2, 3], screenProbeBotSeedBase: 100,
    },
    promotionNotePrefix: \`웨이브 \${WAVE_ID}에서 채택된 플래그 승격: \`,
    recordedAt: now(),
  });

  console.log(\`   승격: \${pipeline.promotion.promotedVersion ?? '(없음)'}\`);
  console.log(\`   요약: runs/${gameId}/summary.md\`);
}

main();
`;
}
