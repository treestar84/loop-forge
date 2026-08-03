/**
 * RULEBOOK.md renderer — the S0 diagnostic stage's human-readable output
 * (docs/GAP-ANALYSIS-13.md §3 S0). A pure function: `GameProfile` +
 * `ReadinessEstimate` in, Markdown out. Renders the four required elements:
 *
 *   1. 룰 시스템 분류 — phases, decision points, randomness sources, hidden
 *      information boundaries, outcome/termination rule.
 *   2. 루프포지 관점 특성 — perfect-info vs hidden-info, expected archetype
 *      (a profile-based guess; superseded by `classifyGame`'s real
 *      classification once an adapter exists).
 *   3. 보완 구현 목록 — P-Score items sorted by points lost (descending),
 *      each with an ONBOARDING-GUIDE.md section pointer. When the profile
 *      fails the P1 gate, this becomes the "why implementation can't fix
 *      this" waiver instead.
 *   4. 판정문 — the three-stage verdict with an explicit label for what
 *      kind of number it is ("추정" vs "실측").
 *
 * Mirrors onboarding/profile.ts's `GameProfile` and
 * onboarding/readiness-estimate.ts's `ReadinessEstimate` shapes
 * structurally — artifacts may not import from onboarding (layer rule), so
 * this narrows via duck-typing instead (same pattern as
 * artifacts/game-summary.ts's `ConformanceReportShape`).
 */

interface PhaseShape {
  readonly id: string;
  readonly description: string;
}

interface DecisionPointShape {
  readonly id: string;
  readonly description: string;
  readonly hiddenInfoVisible: string;
  readonly enumerable?: boolean;
}

interface RandomnessSourceShape {
  readonly id: string;
  readonly description: string;
  readonly seedable: boolean;
}

interface HiddenInformationShape {
  readonly id: string;
  readonly description: string;
  readonly hiddenFrom: string;
  readonly boundaryExplicit?: boolean;
}

export interface GameProfileShape {
  readonly gameId: string;
  readonly summary: string;
  readonly playerCount: number;
  readonly phases: readonly PhaseShape[];
  readonly decisionPoints: readonly DecisionPointShape[];
  readonly randomnessSources: readonly RandomnessSourceShape[];
  readonly hiddenInformation: readonly HiddenInformationShape[];
  readonly outcomeRule: string;
  readonly uiCouplingNotes: readonly string[];
  readonly knownIssues: readonly string[];
  readonly terminationGuarantee?: string;
  readonly referenceImplementation?: 'full-code' | 'partial' | 'document-only';
}

interface GateCheckShape {
  readonly id: string;
  readonly passed: boolean;
  readonly reason: string;
}

interface GateResultShape {
  readonly passed: boolean;
  readonly checks: readonly GateCheckShape[];
  readonly failureReasons: readonly string[];
}

interface PScoreItemShape {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
  readonly score: number;
  readonly reason: string;
}

export interface ReadinessEstimateShape {
  readonly verdict: 'impossible' | 'estimate';
  readonly gate: GateResultShape;
  readonly items?: readonly PScoreItemShape[];
  readonly totalScore?: number;
}

export interface RulebookOptions {
  /**
   * Final three-stage verdict, when known to the caller (requires knowing
   * whether an adapter exists and clears G3 — information this module and
   * `estimateReadiness` don't have). Defaults to a mapping from
   * `estimate.verdict` that assumes no adapter exists yet (S0 runs before
   * G-Convert), i.e. 'impossible' -> 'impossible', 'estimate' ->
   * 'needs-implementation'.
   */
  readonly finalVerdict?: 'impossible' | 'needs-implementation' | 'ready';
  /** Caller-supplied timestamp label for the header (no Date.now here). */
  readonly generatedAtLabel?: string;
}

/** ONBOARDING-GUIDE.md section each P-Score item's remediation points to. */
const GUIDE_SECTION: Record<string, string> = {
  P2: 'docs/ONBOARDING-GUIDE.md §1(무작위성의 원천), §2(결정론)',
  P3: 'docs/ONBOARDING-GUIDE.md §1(결정 지점 목록), §2(encodeChoice/멀티스텝 턴)',
  P4: 'docs/ONBOARDING-GUIDE.md §1(은닉 정보 경계), §2(관찰 빌더/hiddenInfoProbe)',
  P5: 'docs/ONBOARDING-GUIDE.md §1(종국 보장 규칙), §5.5(결정론 게임 추가 규칙)',
  P6: 'docs/ONBOARDING-GUIDE.md §2(룰 엔진 분리)',
  P7: 'docs/ONBOARDING-GUIDE.md §1(기존 AI/NPC 로직 위치), §4(G-Parity)',
};

function renderRuleClassification(profile: GameProfileShape): string {
  const lines: string[] = [];
  lines.push('## 1. 룰 시스템 분류');
  lines.push('');
  lines.push(`- **게임**: ${profile.gameId} — ${profile.summary}`);
  lines.push(`- **플레이어 수**: ${profile.playerCount}`);
  lines.push('');

  lines.push('### 페이즈 구조');
  if (profile.phases.length === 0) {
    lines.push('_(선언된 페이즈 없음)_');
  } else {
    lines.push('| id | 설명 |');
    lines.push('|---|---|');
    for (const phase of profile.phases) {
      lines.push(`| ${phase.id} | ${phase.description} |`);
    }
  }
  lines.push('');

  lines.push('### 결정 지점');
  if (profile.decisionPoints.length === 0) {
    lines.push('_(선언된 결정 지점 없음)_');
  } else {
    lines.push('| id | 설명 | 이산 열거 가능 | 결정 시 보이는 은닉 정보 |');
    lines.push('|---|---|---|---|');
    for (const point of profile.decisionPoints) {
      const enumerable =
        point.enumerable === undefined ? '미기입' : point.enumerable ? '예' : '아니오';
      lines.push(
        `| ${point.id} | ${point.description} | ${enumerable} | ${point.hiddenInfoVisible} |`,
      );
    }
  }
  lines.push('');

  lines.push('### 무작위성 원천');
  if (profile.randomnessSources.length === 0) {
    lines.push('_(무작위성 원천 없음)_');
  } else {
    lines.push('| id | 설명 | 시드 가능 |');
    lines.push('|---|---|---|');
    for (const source of profile.randomnessSources) {
      lines.push(`| ${source.id} | ${source.description} | ${source.seedable ? '예' : '아니오'} |`);
    }
  }
  lines.push('');

  lines.push('### 은닉 정보 경계');
  if (profile.hiddenInformation.length === 0) {
    lines.push('_(완전정보 게임 — 은닉 정보 없음)_');
  } else {
    lines.push('| id | 설명 | 누구에게 은닉 | 경계 명시 |');
    lines.push('|---|---|---|---|');
    for (const info of profile.hiddenInformation) {
      const explicit =
        info.boundaryExplicit === undefined ? '미기입' : info.boundaryExplicit ? '예' : '아니오';
      lines.push(`| ${info.id} | ${info.description} | ${info.hiddenFrom} | ${explicit} |`);
    }
  }
  lines.push('');

  lines.push('### 승패·종국 규칙');
  lines.push(`- **승패 규칙**: ${profile.outcomeRule}`);
  lines.push(
    `- **종국 보장 규칙**: ${
      profile.terminationGuarantee !== undefined && profile.terminationGuarantee.length > 0
        ? profile.terminationGuarantee
        : '_(미기입 — 원본 소스에서 직접 검증 필요, GAP-4 Z7)_'
    }`,
  );

  return lines.join('\n');
}

function renderLoopForgePerspective(profile: GameProfileShape): string {
  const hasHiddenInfo = profile.hiddenInformation.length > 0;
  const infoKind = hasHiddenInfo ? '은닉 정보' : '완전 정보';
  const expectedArchetype = hasHiddenInfo ? 'hidden-info' : 'perfect-info';
  const lines = [
    '## 2. 루프포지 관점의 특성',
    '',
    `- **정보 구조**: ${infoKind} 게임`,
    `- **예상 아키타입(프로필 기반 추정)**: \`${expectedArchetype}\``,
    '- 이 분류는 GameProfile만으로 낸 추정이다. 어댑터가 완성되면 `classifyGame`의',
    '  실측 분류로 갱신된다(추정과 실측이 다르면 실측이 정본).',
  ];
  return lines.join('\n');
}

interface RemediationRow {
  readonly id: string;
  readonly label: string;
  readonly lost: number;
  readonly weight: number;
  readonly reason: string;
  readonly guideSection: string;
}

function renderRemediationList(estimate: ReadinessEstimateShape): string {
  const lines = ['## 3. 보완 구현 목록', ''];

  if (estimate.verdict === 'impossible') {
    lines.push(
      '이 게임은 P1 범위 게이트를 통과하지 못했다 — **구현으로도 해결되지 않는다**. ' +
        '아래는 어느 전제가 왜 깨지는지의 사유서다:',
    );
    lines.push('');
    for (const reason of estimate.gate.failureReasons) {
      lines.push(`- ${reason}`);
    }
    return lines.join('\n');
  }

  const items = estimate.items ?? [];
  if (items.length === 0) {
    lines.push('_(채점 항목 없음)_');
    return lines.join('\n');
  }

  const rows: RemediationRow[] = items
    .map((item) => ({
      id: item.id,
      label: item.label,
      lost: item.weight - item.score,
      weight: item.weight,
      reason: item.reason,
      guideSection: GUIDE_SECTION[item.id] ?? 'docs/ONBOARDING-GUIDE.md',
    }))
    .filter((row) => row.lost > 0)
    .sort((a, b) => b.lost - a.lost);

  if (rows.length === 0) {
    lines.push('감점 항목 없음 — 모든 P-Score 항목이 만점이다.');
    return lines.join('\n');
  }

  lines.push('감점이 큰 항목 순으로 정렬했다:');
  lines.push('');
  for (const row of rows) {
    lines.push(
      `- **${row.id} ${row.label}** (${row.weight - row.lost}/${row.weight}점, ` +
        `${row.lost}점 감점): ${row.reason} → 가이드: ${row.guideSection}`,
    );
  }
  return lines.join('\n');
}

function defaultFinalVerdict(
  estimateVerdict: 'impossible' | 'estimate',
): 'impossible' | 'needs-implementation' | 'ready' {
  return estimateVerdict === 'impossible' ? 'impossible' : 'needs-implementation';
}

function renderVerdictStatement(
  estimate: ReadinessEstimateShape,
  options: RulebookOptions,
): string {
  const finalVerdict = options.finalVerdict ?? defaultFinalVerdict(estimate.verdict);
  const lines = ['## 4. 판정문', ''];

  if (finalVerdict === 'impossible') {
    lines.push('**판정: 불가능**');
    lines.push('');
    lines.push(
      '이 프로필은 P1 범위 게이트에서 실패했다 — 백분율을 계산하지 않는다(94%짜리 ' +
        '실시간 게임 같은 오해를 원천 차단하기 위함). 위 §3의 사유서를 참고하라.',
    );
    return lines.join('\n');
  }

  if (finalVerdict === 'needs-implementation') {
    const total = estimate.totalScore ?? 0;
    lines.push('**판정: 구현 필요**');
    lines.push('');
    lines.push(
      `추정 준비도 ${total}%(P-Score, **추정** — 어댑터가 없으므로 실측 불가) — ` +
        '어댑터 완성 후에는 `scoreAdapter`의 C-Score(**실측**)가 이 숫자를 대체한다.',
    );
    lines.push('');
    lines.push('다음 행동: `npm run onboard -- scaffold`로 어댑터 골격을 생성한다.');
    return lines.join('\n');
  }

  const total = estimate.totalScore;
  lines.push('**판정: 실행 가능**');
  lines.push('');
  lines.push(
    `어댑터가 존재하고 G3(C7 제외 blocker 0개)를 통과했다 — 지금 바로 ` +
      '`npm run onboard -- wave`로 첫 웨이브를 돌릴 수 있다.' +
      (total !== undefined ? ` (참고: P-Score 추정치는 ${total}%였다.)` : ''),
  );
  return lines.join('\n');
}

/**
 * Render a GameProfile + its ReadinessEstimate as RULEBOOK.md content.
 * Pure function — no I/O, no clock. `options.generatedAtLabel`, if given,
 * is a caller-supplied timestamp string (this module never calls
 * `Date.now()`).
 */
export function renderRulebook(
  profile: GameProfileShape,
  estimate: ReadinessEstimateShape,
  options: RulebookOptions = {},
): string {
  const sections = [
    `# RULEBOOK — ${profile.gameId}`,
    '',
    options.generatedAtLabel !== undefined ? `_생성 시각: ${options.generatedAtLabel}_\n` : '',
    renderVerdictStatement(estimate, options),
    '',
    renderRuleClassification(profile),
    '',
    renderLoopForgePerspective(profile),
    '',
    renderRemediationList(estimate),
    '',
  ];
  return sections.join('\n');
}
