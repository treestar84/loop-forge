/**
 * S3 state machine (docs/GAP-ANALYSIS-13.md §3 S3): pure functions over
 * `runs/<gameId>/onboarding-state.json`'s shape. The CLI
 * (`src/reference/runners/onboard-cli.ts`, an app boundary) is the only
 * place that reads/writes this file from disk and calls `Date.now()` — this
 * module never does either, so the stage-transition rules (§2's gate table:
 * G0 범위 -> G1 프로필 -> G2 골격 -> G3 적합성 -> G4 첫 웨이브, each requiring
 * the previous to have passed) can be unit-tested without any filesystem or
 * process I/O.
 *
 * Each `apply*` function takes the previous state (or `null` for the very
 * first diagnosis) plus the facts that stage just measured, and returns the
 * next state — merging in the new gate/verdict/score/stage while leaving
 * every earlier gate's status untouched. Calling `applyScaffold` or
 * `applyScore` before `applyDiagnosis` ever set g1 to 'pass' (i.e. before a
 * validated profile exists), or `applyWave` before g3 is 'pass', throws —
 * this is the "게이트 전이 규칙" the task calls out as a required test target.
 * `applyScore` deliberately does NOT require g2 already 'pass' — see its own
 * doc comment for why (G-Score iterates *during* G-Convert, not only after).
 */

export type GateStatus = 'pass' | 'fail' | 'pending';

export type OnboardingStage =
  | 'not-started'
  | 'diagnosed'
  | 'scaffolded'
  | 'scored'
  | 'wave-ready';

export type OnboardingVerdict = 'impossible' | 'needs-implementation' | 'ready';

export interface OnboardingGates {
  readonly g0: GateStatus;
  readonly g1: GateStatus;
  readonly g2: GateStatus;
  readonly g3: GateStatus;
  readonly g4: GateStatus;
}

export interface OnboardingScore {
  /** 'P' = P-Score (profile-based estimate), 'C' = C-Score (scoreAdapter measurement). */
  readonly kind: 'P' | 'C';
  readonly value: number;
}

export interface OnboardingState {
  readonly gameId: string;
  readonly stage: OnboardingStage;
  readonly gates: OnboardingGates;
  readonly verdict: OnboardingVerdict;
  readonly score: OnboardingScore | null;
  readonly updatedAt: string;
  readonly nextAction: string;
}

/** Minimal duck-typed shape of `ReadinessEstimate` (onboarding/readiness-estimate.ts)
 * this module needs — kept local so this file's own inputs stay obvious from
 * its signature, matching artifacts/rulebook.ts's precedent for shape narrowing. */
export interface DiagnosisEstimateShape {
  readonly verdict: 'impossible' | 'estimate';
  readonly totalScore?: number;
}

class GateTransitionError extends Error {}

function requireGate(gates: OnboardingGates, id: keyof OnboardingGates, calledFrom: string): void {
  if (gates[id] !== 'pass') {
    throw new GateTransitionError(
      `${calledFrom}: gate ${id} is "${gates[id]}", not "pass" — cannot proceed until it passes.`,
    );
  }
}

function describeNextAction(gameId: string, stage: OnboardingStage, gates: OnboardingGates): string {
  if (gates.g0 === 'fail') {
    return `이 게임은 P1 범위 게이트에 실패했습니다 — runs/${gameId}/RULEBOOK.md의 사유서를 확인하세요. 추가 행동 없음(불가능 판정).`;
  }
  if (gates.g1 !== 'pass') {
    return `GameProfile을 작성/보완한 뒤 \`npm run onboard -- <게임 경로 또는 ${gameId}>\`를 다시 실행하세요.`;
  }
  if (gates.g2 !== 'pass') {
    return `\`npm run onboard -- scaffold ${gameId}\`로 어댑터 골격을 생성/보완하고, 생성된 파일의 TODO(onboard) 마커를 전부 채운 뒤 다시 실행하세요.`;
  }
  if (gates.g3 !== 'pass') {
    return `\`npm run onboard -- score ${gameId}\`로 채점하고, blocker별 remediation을 따라 어댑터를 수정한 뒤 재실행하세요.`;
  }
  if (gates.g4 !== 'pass') {
    return `\`npm run onboard -- wave ${gameId}\`로 첫 웨이브를 실행하세요.`;
  }
  void stage;
  return `온보딩 완료 — runs/${gameId}/summary.md를 확인하세요.`;
}

function stageFromGates(gates: OnboardingGates): OnboardingStage {
  if (gates.g0 === 'fail') return 'not-started';
  if (gates.g4 === 'pass') return 'wave-ready';
  if (gates.g3 === 'pass') return 'scored';
  if (gates.g2 === 'pass') return 'scaffolded';
  if (gates.g1 === 'pass') return 'diagnosed';
  return 'not-started';
}

function finalize(
  gameId: string,
  gates: OnboardingGates,
  verdict: OnboardingVerdict,
  score: OnboardingScore | null,
  updatedAt: string,
): OnboardingState {
  const stage = stageFromGates(gates);
  return {
    gameId,
    stage,
    gates,
    verdict,
    score,
    updatedAt,
    nextAction: describeNextAction(gameId, stage, gates),
  };
}

/**
 * S0 diagnosis (first `npm run onboard -- <path>` run, or a re-diagnosis).
 * `estimate` is the output of `estimateReadiness(profile)` — reaching this
 * function at all implies `parseGameProfile` already validated the profile
 * (G1), so g1 is set to 'pass' whenever g0 does not fail first. g0 mirrors
 * `estimate`'s own P1 gate check (docs/GAP-ANALYSIS-13.md §2's G0 row is the
 * same self-check questionnaire as P1).
 */
export function applyDiagnosis(
  gameId: string,
  estimate: DiagnosisEstimateShape,
  updatedAt: string,
): OnboardingState {
  if (estimate.verdict === 'impossible') {
    const gates: OnboardingGates = { g0: 'fail', g1: 'pending', g2: 'pending', g3: 'pending', g4: 'pending' };
    return finalize(gameId, gates, 'impossible', null, updatedAt);
  }
  const gates: OnboardingGates = { g0: 'pass', g1: 'pass', g2: 'pending', g3: 'pending', g4: 'pending' };
  const score: OnboardingScore = { kind: 'P', value: estimate.totalScore ?? 0 };
  return finalize(gameId, gates, 'needs-implementation', score, updatedAt);
}

/**
 * S2 scaffold generation/verification (`npm run onboard -- scaffold`). G2
 * gate (docs/GAP-ANALYSIS-13.md §2): `TODO(onboard)` marker count is 0 AND
 * `tsc --noEmit` passed. Requires g1 already 'pass' (a validated profile
 * must exist before scaffolding).
 */
export function applyScaffold(
  prev: OnboardingState,
  todoCount: number,
  tscPassed: boolean,
  updatedAt: string,
): OnboardingState {
  requireGate(prev.gates, 'g1', 'applyScaffold');
  const g2: GateStatus = todoCount === 0 && tscPassed ? 'pass' : 'fail';
  const gates: OnboardingGates = { ...prev.gates, g2, g3: g2 === 'pass' ? prev.gates.g3 : 'pending', g4: g2 === 'pass' ? prev.gates.g4 : 'pending' };
  return finalize(prev.gameId, gates, prev.verdict, prev.score, updatedAt);
}

/**
 * S(score) — `npm run onboard -- score`. Requires g1 already 'pass' (a
 * validated profile), but deliberately NOT g2 already 'pass': G-Score is
 * meant to run repeatedly *during* G-Convert (ONBOARDING-GUIDE.md §3.1's
 * "채점→수정→재채점 반복 루프" — an agent fills TODO(onboard) markers, scores,
 * reads blockers, fills more, scores again), so this function re-measures
 * g2 itself on every call from the caller's freshly-taken TODO-marker-count
 * + tsc result, rather than trusting a stale value from the last `scaffold`
 * invocation. G3 gate: C7 제외 blocker 0개 (mirrors `evaluateWaveReadiness`'s
 * own rule — this module never imports `onboarding/wave-readiness.ts` to
 * stay a pure leaf, so the caller passes the already-computed blocking-axis
 * count). From this point on, `score.kind` is always 'C' (실측) — it
 * permanently replaces the 'P' (추정) score set by `applyDiagnosis`.
 */
export function applyScore(
  prev: OnboardingState,
  todoCount: number,
  tscPassed: boolean,
  overallScore: number,
  nonParityBlockingAxisCount: number,
  updatedAt: string,
): OnboardingState {
  requireGate(prev.gates, 'g1', 'applyScore');
  const g2: GateStatus = todoCount === 0 && tscPassed ? 'pass' : 'fail';
  const g3: GateStatus = nonParityBlockingAxisCount === 0 ? 'pass' : 'fail';
  const gates: OnboardingGates = { ...prev.gates, g2, g3, g4: g3 === 'pass' ? prev.gates.g4 : 'pending' };
  const verdict: OnboardingVerdict = g3 === 'pass' ? 'ready' : 'needs-implementation';
  const score: OnboardingScore = { kind: 'C', value: overallScore };
  return finalize(prev.gameId, gates, verdict, score, updatedAt);
}

/**
 * S(wave) — `npm run onboard -- wave`. G4 gate: the wave ran to completion
 * and produced a WaveReport, regardless of its adoption verdict
 * (docs/GAP-ANALYSIS-13.md §2: "실패 verdict도 온보딩 성공이다"). Requires g3
 * already 'pass'.
 */
export function applyWave(prev: OnboardingState, waveRan: boolean, updatedAt: string): OnboardingState {
  requireGate(prev.gates, 'g3', 'applyWave');
  const gates: OnboardingGates = { ...prev.gates, g4: waveRan ? 'pass' : 'fail' };
  return finalize(prev.gameId, gates, prev.verdict, prev.score, updatedAt);
}

/** Regex the task calls out explicitly ("G2 판정(TODO 마커 grep)") — extracted
 * as a pure function over source text so it needs no filesystem access to
 * unit-test. Matches the exact `TODO(onboard): §<n>-<m> — ...` shape
 * `onboarding/scaffold.ts`'s `todo()` helper always emits. */
export function countOnboardTodoMarkers(sourceText: string): { readonly count: number; readonly markers: readonly string[] } {
  const pattern = /TODO\(onboard\):\s*§\d+-\d+\s*—[^\n]*/g;
  const markers = sourceText.match(pattern) ?? [];
  return { count: markers.length, markers };
}

const GATE_LABELS: Record<keyof OnboardingGates, string> = {
  g0: 'G0 범위',
  g1: 'G1 프로필',
  g2: 'G2 골격',
  g3: 'G3 적합성',
  g4: 'G4 첫 웨이브',
};

const GATE_STATUS_LABELS: Record<GateStatus, string> = {
  pass: '통과',
  fail: '미달',
  pending: '대기',
};

/**
 * Renders the console report `npm run onboard -- status` (and the no-args
 * invocation) prints — current stage, §2 gate table, score with its P/C
 * label, verdict, and the next action (including the next command +
 * prompt-pointer). Pure string assembly, no I/O.
 */
export function renderStatusReport(state: OnboardingState): string {
  const lines: string[] = [];
  lines.push(`=== ${state.gameId} 온보딩 상태 ===`);
  lines.push(`스테이지: ${state.stage}`);
  lines.push(`판정: ${state.verdict}`);
  if (state.score) {
    const label = state.score.kind === 'P' ? '추정(P-Score)' : '실측(C-Score)';
    lines.push(`적합도: ${state.score.value}% (${label})`);
  } else {
    lines.push('적합도: (아직 산출되지 않음)');
  }
  lines.push('');
  lines.push('게이트 현황:');
  for (const id of ['g0', 'g1', 'g2', 'g3', 'g4'] as const) {
    lines.push(`  - ${GATE_LABELS[id]} (${id}): ${GATE_STATUS_LABELS[state.gates[id]]}`);
  }
  lines.push('');
  lines.push(`다음 행동: ${state.nextAction}`);
  lines.push(`(갱신 시각: ${state.updatedAt})`);
  return lines.join('\n');
}
