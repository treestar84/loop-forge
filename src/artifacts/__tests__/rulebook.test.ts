import { renderRulebook, type GameProfileShape, type ReadinessEstimateShape } from '../rulebook';

function baseProfile(overrides: Partial<GameProfileShape> = {}): GameProfileShape {
  return {
    gameId: 'mini-trick',
    summary: 'A minimal 2-player trick-taking game.',
    playerCount: 2,
    phases: [{ id: 'play', description: 'Six tricks are played.' }],
    decisionPoints: [
      { id: 'play', description: 'Play a legal card.', hiddenInfoVisible: 'none', enumerable: true },
    ],
    randomnessSources: [{ id: 'shuffle', description: 'Initial deal shuffle.', seedable: true }],
    hiddenInformation: [],
    outcomeRule: 'Most tricks won wins.',
    uiCouplingNotes: [],
    knownIssues: [],
    ...overrides,
  };
}

const passingGate: ReadinessEstimateShape['gate'] = {
  passed: true,
  checks: [
    { id: 'turnBased', passed: true, reason: '' },
    { id: 'competitive', passed: true, reason: '' },
    { id: 'independentGames', passed: true, reason: '' },
    { id: 'decisionsStructurable', passed: true, reason: '' },
  ],
  failureReasons: [],
};

describe('renderRulebook — needs-implementation (estimate) verdict', () => {
  const estimate: ReadinessEstimateShape = {
    verdict: 'estimate',
    gate: passingGate,
    items: [
      { id: 'P2', label: '무작위성 시드화', weight: 25, score: 25, reason: '전부 시드 가능.' },
      { id: 'P3', label: '결정 지점 이산성', weight: 20, score: 20, reason: '전부 이산 열거 가능.' },
      { id: 'P4', label: '은닉 경계 명확성', weight: 15, score: 15, reason: '완전정보 게임.' },
      { id: 'P5', label: '종국 보장 규칙', weight: 15, score: 0, reason: '종국 보장 규칙 미기입.' },
      { id: 'P6', label: '룰-UI 분리 용이성', weight: 15, score: 15, reason: '결합 노트 없음.' },
      { id: 'P7', label: '참조 구현 완전성', weight: 10, score: 0, reason: '참조 구현 미기입.' },
    ],
    totalScore: 75,
  };

  it('includes the verdict statement with an explicit "추정" label and the percentage', () => {
    const markdown = renderRulebook(baseProfile(), estimate);
    expect(markdown).toContain('판정: 구현 필요');
    expect(markdown).toContain('추정');
    expect(markdown).toContain('75%');
  });

  it('lists remediation items sorted by points lost, descending, with guide links', () => {
    const markdown = renderRulebook(baseProfile(), estimate);
    const p5Index = markdown.indexOf('P5 종국 보장 규칙');
    const p7Index = markdown.indexOf('P7 참조 구현 완전성');
    expect(p5Index).toBeGreaterThan(-1);
    expect(p7Index).toBeGreaterThan(-1);
    // P5 lost 15pts, P7 lost 10pts -> P5 must appear first.
    expect(p5Index).toBeLessThan(p7Index);
    expect(markdown).toContain('ONBOARDING-GUIDE.md');
    // Full-mark items (P2, P3, P4, P6) should not appear in the remediation list.
    expect(markdown).not.toContain('P2 무작위성 시드화');
  });

  it('includes the rule classification and Loop Forge perspective sections', () => {
    const markdown = renderRulebook(baseProfile(), estimate);
    expect(markdown).toContain('## 1. 룰 시스템 분류');
    expect(markdown).toContain('## 2. 루프포지 관점의 특성');
    expect(markdown).toContain('## 3. 보완 구현 목록');
    expect(markdown).toContain('## 4. 판정문');
  });
});

describe('renderRulebook — impossible verdict', () => {
  const impossibleEstimate: ReadinessEstimateShape = {
    verdict: 'impossible',
    gate: {
      passed: false,
      checks: [
        {
          id: 'turnBased',
          passed: false,
          reason: '실시간·신체(덱스터리티) 게임: 턴제 AEC 모델과 근본 불일치 — 지원 계획 없음.',
        },
      ],
      failureReasons: [
        '실시간·신체(덱스터리티) 게임: 턴제 AEC 모델과 근본 불일치 — 지원 계획 없음.',
      ],
    },
  };

  it('renders the waiver instead of a percentage, and labels the verdict "불가능"', () => {
    const markdown = renderRulebook(baseProfile(), impossibleEstimate);
    expect(markdown).toContain('판정: 불가능');
    expect(markdown).toContain('구현으로도 해결되지 않는다');
    expect(markdown).toContain('지원 계획 없음');
    expect(markdown).not.toMatch(/추정 준비도 \d+%/);
  });
});

describe('renderRulebook — perfect-information vs hidden-information classification', () => {
  it('classifies a profile with no hiddenInformation as perfect-info', () => {
    const estimate: ReadinessEstimateShape = { verdict: 'estimate', gate: passingGate, items: [], totalScore: 100 };
    const markdown = renderRulebook(baseProfile({ hiddenInformation: [] }), estimate);
    expect(markdown).toContain('완전 정보');
    expect(markdown).toContain('perfect-info');
  });

  it('classifies a profile with hiddenInformation entries as hidden-info', () => {
    const estimate: ReadinessEstimateShape = { verdict: 'estimate', gate: passingGate, items: [], totalScore: 100 };
    const markdown = renderRulebook(
      baseProfile({
        hiddenInformation: [
          { id: 'hand', description: "opponent's hand", hiddenFrom: 'all opponents', boundaryExplicit: true },
        ],
      }),
      estimate,
    );
    expect(markdown).toContain('은닉 정보');
    expect(markdown).toContain('hidden-info');
  });
});
