/**
 * P-Score — the S0 diagnostic stage's pre-readiness estimate
 * (docs/GAP-ANALYSIS-13.md §2.5). A pure function over a `GameProfile`
 * that produces:
 *
 *   1. The P1 scope gate verdict (turn-based / competitive / independent
 *      games / structurable decisions). Any failure short-circuits to
 *      `verdict: 'impossible'` with reasons — no percentage is computed,
 *      by design (a 94%-looking real-time game must never look "almost
 *      ready").
 *   2. If the gate passes, the P2–P7 weighted score items (sum to 100) with
 *      per-item evidence strings, plus the total.
 *
 * This module intentionally stops at 'impossible' | 'estimate'. The final
 * three-way verdict ('impossible' | 'needs-implementation' | 'ready') needs
 * to know whether an adapter exists and whether it clears G3 — information
 * this module doesn't have access to (adapter existence lives outside
 * onboarding/profile). The caller (CLI, tests) combines this estimate with
 * that knowledge.
 */

import type { GameProfile } from './profile';

export interface ReadinessGateCheck {
  readonly id: 'turnBased' | 'competitive' | 'independentGames' | 'decisionsStructurable';
  readonly passed: boolean;
  /** Present (non-empty) only when `passed` is false. */
  readonly reason: string;
}

export interface ReadinessGateResult {
  readonly passed: boolean;
  readonly checks: readonly ReadinessGateCheck[];
  /** Failing checks' reasons only; empty when `passed`. */
  readonly failureReasons: readonly string[];
}

export type PScoreItemId = 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7';

export interface PScoreItem {
  readonly id: PScoreItemId;
  readonly label: string;
  readonly weight: number;
  /** 0..weight. */
  readonly score: number;
  /** Human-readable justification for the score, always present. */
  readonly reason: string;
}

export type ReadinessVerdict = 'impossible' | 'estimate';

export interface ReadinessEstimate {
  readonly verdict: ReadinessVerdict;
  readonly gate: ReadinessGateResult;
  /** Present only when `verdict === 'estimate'`. */
  readonly items?: readonly PScoreItem[];
  /** Sum of `items[].score`, 0..100. Present only when `verdict === 'estimate'`. */
  readonly totalScore?: number;
}

/**
 * P1 gate (ONBOARDING-GUIDE.md §0's excluded-family table). Each flag
 * defaults to `true` (in scope) when the profile omits it — most games
 * never need to declare these; only a profile describing an excluded genre
 * sets one to `false`.
 */
function evaluateGate(profile: GameProfile): ReadinessGateResult {
  const checks: ReadinessGateCheck[] = [
    {
      id: 'turnBased',
      passed: profile.turnBased !== false,
      reason:
        '실시간·신체(덱스터리티) 게임: 턴제 AEC(Agent-Environment-Cycle) 모델과 근본 불일치 — ' +
        '구현으로 해소되지 않는다(계약 자체가 턴 교대를 전제). 지원 계획 없음(ONBOARDING-GUIDE.md §0).',
    },
    {
      id: 'competitive',
      passed: profile.competitive !== false,
      reason:
        '1인/협력 게임: 승률 기반 통계의 전제(경쟁 대국)가 부재 — C0 게이트가 차단한다. ' +
        '로드맵에는 있으나 현재 어댑터로 구현해도 통과하지 못한다(ONBOARDING-GUIDE.md §0).',
    },
    {
      id: 'independentGames',
      passed: profile.independentGames !== false,
      reason:
        '레거시/캠페인 게임: 게임 간 영속 상태가 "게임 간 독립" 전제를 위반한다 — ' +
        '표본을 독립 시행으로 취급하는 통계 파이프라인 전체와 충돌한다. 로드맵(ONBOARDING-GUIDE.md §0).',
    },
    {
      id: 'decisionsStructurable',
      passed: profile.decisionsStructurable !== false,
      reason:
        '자유 대화 협상: 구조화 불가능한 행동 공간 — `getLegalChoices`가 유한 집합을 ' +
        '반환해야 하는 계약과 근본적으로 불일치한다. 이산화된 오퍼만 부분 지원(ONBOARDING-GUIDE.md §0).',
    },
  ];
  const failureReasons = checks.filter((check) => !check.passed).map((check) => check.reason);
  return { passed: failureReasons.length === 0, checks, failureReasons };
}

function scoreP2Randomness(profile: GameProfile): PScoreItem {
  const weight = 25;
  const total = profile.randomnessSources.length;
  if (total === 0) {
    return {
      id: 'P2',
      label: '무작위성 시드화',
      weight,
      score: weight,
      reason: '무작위성 원천이 없음 — 시드화 이슈가 발생할 수 없어 만점.',
    };
  }
  const seedableCount = profile.randomnessSources.filter((source) => source.seedable).length;
  const ratio = seedableCount / total;
  const score = Math.round(ratio * weight);
  return {
    id: 'P2',
    label: '무작위성 시드화',
    weight,
    score,
    reason:
      `무작위성 원천 ${total}개 중 시드 가능 ${seedableCount}개(${Math.round(ratio * 100)}%) — ` +
      (seedableCount < total
        ? 'C1 결정론이 전체 파이프라인의 전제이므로, 시드 불가 원천이 있으면 재현·통계가 무효화된다.'
        : '전부 시드 가능 — C1 결정론 전제를 충족한다.'),
  };
}

function scoreP3DecisionEnumerability(profile: GameProfile): PScoreItem {
  const weight = 20;
  const total = profile.decisionPoints.length;
  if (total === 0) {
    return {
      id: 'P3',
      label: '결정 지점 이산성',
      weight,
      score: weight,
      reason: '결정 지점이 없음 — 이산화 이슈가 발생할 수 없어 만점.',
    };
  }
  const enumerableCount = profile.decisionPoints.filter(
    (point) => point.enumerable === true,
  ).length;
  const undeclaredCount = profile.decisionPoints.filter(
    (point) => point.enumerable === undefined,
  ).length;
  const ratio = enumerableCount / total;
  const score = Math.round(ratio * weight);
  return {
    id: 'P3',
    label: '결정 지점 이산성',
    weight,
    score,
    reason:
      `결정 지점 ${total}개 중 이산 열거 가능 선언 ${enumerableCount}개(${Math.round(ratio * 100)}%)` +
      (undeclaredCount > 0 ? `, 미기입 ${undeclaredCount}개는 보수적으로 비이산으로 간주` : '') +
      ' — 이산화 안 되는 행동 공간은 `getLegalChoices`로 표현 불가(자유 대화 협상 배제 사유와 동일).',
  };
}

function scoreP4HiddenBoundary(profile: GameProfile): PScoreItem {
  const weight = 15;
  const total = profile.hiddenInformation.length;
  if (total === 0) {
    return {
      id: 'P4',
      label: '은닉 경계 명확성',
      weight,
      score: weight,
      reason: '완전정보 게임(은닉 정보 없음) — 자동 만점.',
    };
  }
  const explicitCount = profile.hiddenInformation.filter(
    (info) => info.boundaryExplicit === true,
  ).length;
  const ratio = explicitCount / total;
  const score = Math.round(ratio * weight);
  return {
    id: 'P4',
    label: '은닉 경계 명확성',
    weight,
    score,
    reason:
      `은닉 정보 ${total}개 중 경계 명시(boundaryExplicit) ${explicitCount}개(${Math.round(ratio * 100)}%) — ` +
      '경계가 모호하면 observationBuilder 오염 사고(티추 실측)와 동일한 재작업이 C3에서 발생한다.',
  };
}

function scoreP5TerminationGuarantee(profile: GameProfile): PScoreItem {
  const weight = 15;
  const declared =
    profile.terminationGuarantee !== undefined && profile.terminationGuarantee.length > 0;
  return {
    id: 'P5',
    label: '종국 보장 규칙',
    weight,
    score: declared ? weight : 0,
    reason: declared
      ? `종국 보장 규칙 명시됨: "${profile.terminationGuarantee}".`
      : '종국 보장 규칙 미기입 — 보수적으로 "보장 없음"으로 간주(스플랜더 데드락 실측, GAP-4 Z7). ' +
        '원본 소스에 규칙이 있는지 직접 검증하지 않으면 어댑터가 자체 스테일메이트 규칙을 합성해야 한다.',
  };
}

function scoreP6UiCoupling(profile: GameProfile): PScoreItem {
  const weight = 15;
  const noteCount = profile.uiCouplingNotes.length;
  if (noteCount === 0) {
    return {
      id: 'P6',
      label: '룰-UI 분리 용이성',
      weight,
      score: weight,
      reason: '룰-UI 결합 노트 없음 — 만점.',
    };
  }
  const severityScore: Record<
    Exclude<GameProfile['uiCouplingSeverity'], undefined>,
    number
  > = {
    none: weight,
    low: 10,
    medium: 5,
    high: 0,
  };
  const severity = profile.uiCouplingSeverity;
  const score = severity !== undefined ? severityScore[severity] : 0;
  return {
    id: 'P6',
    label: '룰-UI 분리 용이성',
    weight,
    score,
    reason:
      `결합 노트 ${noteCount}건, 심각도: ${severity ?? '미기입(보수적으로 high로 간주)'} — ` +
      'G-Convert 최대 작업량이 룰 엔진 분리이므로, 결합도가 곧 재구현 비용이다.',
  };
}

function scoreP7ReferenceCompleteness(profile: GameProfile): PScoreItem {
  const weight = 10;
  const completeness = profile.referenceImplementation;
  const score = completeness === 'full-code' ? weight : completeness === 'partial' ? weight / 2 : 0;
  return {
    id: 'P7',
    label: '참조 구현 완전성',
    weight,
    score,
    reason:
      `참조 구현 상태: ${completeness ?? 'document-only(미기입, 보수적으로 간주)'} — ` +
      '코드 없이 규칙 문서만 있으면 에이전트 추측 비율이 올라가 G-Parity 증명력도 함께 하락한다.',
  };
}

/**
 * Compute the P-Score estimate for `profile`. See module doc for the
 * verdict semantics — this never returns 'needs-implementation' or 'ready'.
 */
export function estimateReadiness(profile: GameProfile): ReadinessEstimate {
  const gate = evaluateGate(profile);
  if (!gate.passed) {
    return { verdict: 'impossible', gate };
  }

  const items: readonly PScoreItem[] = [
    scoreP2Randomness(profile),
    scoreP3DecisionEnumerability(profile),
    scoreP4HiddenBoundary(profile),
    scoreP5TerminationGuarantee(profile),
    scoreP6UiCoupling(profile),
    scoreP7ReferenceCompleteness(profile),
  ];
  const totalScore = items.reduce((sum, item) => sum + item.score, 0);

  return { verdict: 'estimate', gate, items, totalScore };
}
