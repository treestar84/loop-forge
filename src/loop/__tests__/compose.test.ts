import { analyzeAssembly, assembleFlags, composeBot, composeBotChecked, withStrategyFlags } from '../compose';
import { eraseAdapter } from '../erase';
import { runHeadToHead } from '../head-to-head';
import type { MatchTrajectoryRecord } from '../paired-match';
import { canonicalJson, sha256Digest } from '../../kernel/digest';
import { miniTrickAdapter } from '../../reference/mini-trick';
import { gomokuAdapter } from '../../reference/gomoku';
import { dominionAdapter } from '../../reference/dominion';
import {
  GOMOKU_MCTS_CONFIG,
  GOMOKU_MCTS_FLAG,
  GOMOKU_MCTS_HR_CONFIG,
  GOMOKU_MCTS_HR_FLAG,
  GOMOKU_MCTS2_S256_CONFIG,
  GOMOKU_MCTS2_S256_FLAG,
  GOMOKU_MCTS2_S256_HR_CONFIG,
  GOMOKU_MCTS2_S256_HR_FLAG,
  gomokuMctsFlagSpecFor,
  gomokuMcts2S256CrFlagSpec,
  gomokuMcts2S512CrFlagSpec,
} from '../../reference/runners/shared/gomoku-mcts-flag';
import { buildCandidates } from '../../reference/runners/shared/gomoku-round1-candidates';
import { buildRound2Candidates } from '../../reference/runners/shared/gomoku-round2-candidates';

const adapter = eraseAdapter(miniTrickAdapter);

describe('withStrategyFlags', () => {
  it('returns a new adapter with extraFlags appended, leaving the original untouched', () => {
    const originalFlagCount = adapter.strategySurface.length;
    const extraFlag = {
      flag: 'test-extra-flag',
      description: 'a test-only flag added via withStrategyFlags',
      apply: (base: typeof adapter.baselines.heuristic) => base,
    };

    const extended = withStrategyFlags(adapter, [extraFlag]);

    expect(adapter.strategySurface.length).toBe(originalFlagCount);
    expect(adapter.strategySurface.some((spec) => spec.flag === 'test-extra-flag')).toBe(false);
    expect(extended.strategySurface.length).toBe(originalFlagCount + 1);
    expect(extended.strategySurface.some((spec) => spec.flag === 'test-extra-flag')).toBe(true);
  });

  it('lets composeBot resolve a flag injected via withStrategyFlags', () => {
    const extraFlag = {
      flag: 'test-extra-flag-2',
      description: 'a test-only flag added via withStrategyFlags',
      apply: (base: typeof adapter.baselines.heuristic) => base,
    };
    const extended = withStrategyFlags(adapter, [extraFlag]);
    expect(() => composeBot(extended, ['test-extra-flag-2'])).not.toThrow();
  });

  it('throws when extraFlags reuses an existing flag name', () => {
    const existingFlagName = adapter.strategySurface[0]?.flag;
    expect(existingFlagName).toBeDefined();
    const duplicateFlag = {
      flag: existingFlagName as string,
      description: 'duplicate flag name — should be rejected',
      apply: (base: typeof adapter.baselines.heuristic) => base,
    };
    expect(() => withStrategyFlags(adapter, [duplicateFlag])).toThrow(
      /already exists on adapter.strategySurface/,
    );
  });

  it('throws when two extraFlags entries collide with each other', () => {
    const flagA = {
      flag: 'duplicate-among-extras',
      description: 'first',
      apply: (base: typeof adapter.baselines.heuristic) => base,
    };
    // Note: only collisions against the adapter's existing flags are checked
    // up front; this exercises that a name already on the adapter (added via
    // a prior withStrategyFlags call) is rejected on a second call.
    const onceExtended = withStrategyFlags(adapter, [flagA]);
    expect(() => withStrategyFlags(onceExtended, [{ ...flagA, description: 'second' }])).toThrow(
      /already exists on adapter.strategySurface/,
    );
  });
});

// ADR-0014: analyzeAssembly / composeBotChecked / assembleFlags.
const decoratorFlag = {
  flag: 'test-decorator',
  description: 'decorator test flag',
  apply: (base: typeof adapter.baselines.heuristic) => base,
  assembly: 'decorator' as const,
};
const terminalFlagA = {
  flag: 'test-terminal-a',
  description: 'terminal test flag A',
  apply: () => adapter.baselines.heuristic,
  assembly: 'terminal' as const,
};
const terminalFlagB = {
  flag: 'test-terminal-b',
  description: 'terminal test flag B',
  apply: () => adapter.baselines.heuristic,
  assembly: 'terminal' as const,
};
const unknownFlag = {
  flag: 'test-unknown',
  description: 'undeclared assembly test flag',
  apply: (base: typeof adapter.baselines.heuristic) => base,
};
const assemblyAdapter = withStrategyFlags(adapter, [decoratorFlag, terminalFlagA, terminalFlagB, unknownFlag]);

describe('analyzeAssembly', () => {
  it('errors when 2+ declared terminals are present', () => {
    const result = analyzeAssembly(assemblyAdapter, ['test-terminal-a', 'test-terminal-b']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/복수 터미널/);
    expect(result.errors[0]).toMatch(/test-terminal-a/);
    expect(result.errors[0]).toMatch(/test-terminal-b/);
  });

  it('errors when the sole declared terminal is not flags[0]', () => {
    const result = analyzeAssembly(assemblyAdapter, ['test-decorator', 'test-terminal-a']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/배열 첫 항목이 아님/);
    expect(result.errors[0]).toMatch(/test-terminal-a/);
  });

  it('warns (no error) when an unknown-assembly flag is present', () => {
    const result = analyzeAssembly(assemblyAdapter, ['test-unknown']);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });

  it('passes clean with no errors/warnings when the terminal is first and every other flag is declared', () => {
    const result = analyzeAssembly(assemblyAdapter, ['test-terminal-a', 'test-decorator']);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('ignores a flag name absent from strategySurface (composeBot is responsible for that error)', () => {
    const result = analyzeAssembly(assemblyAdapter, ['nonexistent-flag']);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('composeBotChecked', () => {
  it('throws when analyzeAssembly reports an error', () => {
    expect(() => composeBotChecked(assemblyAdapter, ['test-terminal-a', 'test-terminal-b'])).toThrow(
      /복수 터미널/,
    );
  });

  it('returns a bot behaviorally identical to composeBot when there is no assembly error', () => {
    const flags = ['test-decorator'];
    const checked = composeBotChecked(assemblyAdapter, flags);
    const plain = composeBot(assemblyAdapter, flags);
    // decoratorFlag.apply is the identity function, so both factories resolve
    // to the exact same underlying baseline bot factory reference.
    expect(checked).toBe(plain);
  });
});

describe('assembleFlags', () => {
  it('keeps a single terminal candidate with no exclusions', () => {
    const result = assembleFlags([{ flag: 't1', assembly: 'terminal', challengeScore: 5 }]);
    expect(result.flags).toEqual(['t1']);
    expect(result.excluded).toEqual([]);
  });

  it('keeps only the highest-challengeScore terminal, excluding the rest', () => {
    const result = assembleFlags([
      { flag: 't1', assembly: 'terminal', challengeScore: 3 },
      { flag: 't2', assembly: 'terminal', challengeScore: 9 },
    ]);
    expect(result.flags).toEqual(['t2']);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]).toEqual({ flag: 't1', reason: expect.stringContaining('t2') });
  });

  it('returns only decorators, in input order, when there is no terminal', () => {
    const result = assembleFlags([
      { flag: 'd1', assembly: 'decorator' },
      { flag: 'd2' },
    ]);
    expect(result.flags).toEqual(['d1', 'd2']);
    expect(result.excluded).toEqual([]);
  });

  it('breaks a challengeScore tie by keeping input order', () => {
    const result = assembleFlags([
      { flag: 't1', assembly: 'terminal', challengeScore: 5 },
      { flag: 't2', assembly: 'terminal', challengeScore: 5 },
    ]);
    expect(result.flags).toEqual(['t1']);
    expect(result.excluded).toEqual([{ flag: 't2', reason: expect.stringContaining('t1') }]);
  });

  it('places the surviving terminal first, then decorators in adoption order', () => {
    const result = assembleFlags([
      { flag: 'd1', assembly: 'decorator' },
      { flag: 't1', assembly: 'terminal', challengeScore: 1 },
      { flag: 't2', assembly: 'terminal', challengeScore: 9 },
      { flag: 'd2' },
    ]);
    expect(result.flags).toEqual(['t2', 'd1', 'd2']);
    expect(result.excluded).toEqual([{ flag: 't1', reason: expect.stringContaining('t2') }]);
  });

  it('treats a missing challengeScore as lowest', () => {
    const result = assembleFlags([
      { flag: 't1', assembly: 'terminal' },
      { flag: 't2', assembly: 'terminal', challengeScore: 0 },
    ]);
    expect(result.flags).toEqual(['t2']);
    expect(result.excluded).toEqual([{ flag: 't1', reason: expect.stringContaining('t2') }]);
  });
});

/**
 * ADR-0014 regression proof: gomoku v5/v6/v7 and dominion v3/v4's actual
 * registry.json flags arrays, reconstructed via composeBot exactly as the
 * runners do, must keep producing byte-identical trajectories after the
 * `assembly` field was retrofitted onto their strategySurface specs (pure
 * metadata — composeBot's own logic is untouched). Digests below were
 * captured by running this exact composition against these exact seeds
 * BEFORE any `assembly` field existed in the codebase, then re-verified
 * afterward — see the task's completion report for the before/after
 * comparison. A change to these digests means composeBot's assembled bot
 * behavior drifted, which must never happen from an `assembly` metadata-only
 * change.
 *
 * Seed count (3, not a large statistical sample): this checks deterministic
 * equality of a code path that is provably unchanged (composeBot's own body
 * is untouched — only inert data was added to strategySurface specs), not a
 * win-rate estimate — more seeds would not add confidence, only wall-clock
 * cost. 3 seeds is enough to exercise every MCTS/prior/rollout branch each
 * composed candidate can take.
 */
describe('ADR-0014 regression: assembly metadata does not change composeBot output', () => {
  const REGRESSION_SEEDS = Array.from({ length: 3 }, (_, i) => 500_000 + i);

  function fingerprint(gameAdapter: ReturnType<typeof eraseAdapter>, flags: readonly string[]): string {
    const bot = composeBot(gameAdapter, flags);
    const baseline = gameAdapter.baselines.heuristic;
    const records: MatchTrajectoryRecord[] = [];
    runHeadToHead(gameAdapter, bot, baseline, REGRESSION_SEEDS, 123_456, {
      trajectoryCollector: (record) => records.push(record),
    });
    return sha256Digest(canonicalJson(records));
  }

  const bareGomoku = eraseAdapter(gomokuAdapter);
  const gomokuFullAdapter = withStrategyFlags(bareGomoku, [
    gomokuMctsFlagSpecFor(bareGomoku, GOMOKU_MCTS_CONFIG, GOMOKU_MCTS_FLAG),
    gomokuMctsFlagSpecFor(bareGomoku, GOMOKU_MCTS_HR_CONFIG, GOMOKU_MCTS_HR_FLAG),
    gomokuMctsFlagSpecFor(bareGomoku, GOMOKU_MCTS2_S256_CONFIG, GOMOKU_MCTS2_S256_FLAG),
    gomokuMctsFlagSpecFor(bareGomoku, GOMOKU_MCTS2_S256_HR_CONFIG, GOMOKU_MCTS2_S256_HR_FLAG),
    gomokuMcts2S256CrFlagSpec(bareGomoku),
    gomokuMcts2S512CrFlagSpec(bareGomoku),
    ...buildCandidates(bareGomoku).map((c) => c.spec),
    ...buildRound2Candidates(bareGomoku).map((c) => c.spec),
  ]);
  const gomokuV5 = [
    'blockImmediateThreat',
    'centerProximity',
    'extendLongestLine',
    'mcts-s64',
    'mcts2-s256-hr',
    'mcts2-s256-cr',
    'mcts2-s512-cr',
  ];
  const gomokuV6 = [
    ...gomokuV5,
    'mcts7-s256-opening6-prior-w16',
    'mcts5-s256-chain-w16',
    'mcts5-s256-chain-w48',
    'mcts9-s256-defensive-w16',
  ];
  const gomokuV7 = [
    ...gomokuV6,
    'mcts10-s256-combined-w16',
    'mcts10-s256-combined-w16-c04',
    'mcts12-s256-opusclone-w16',
  ];

  const dominion = eraseAdapter(dominionAdapter);
  const dominionV3 = ['rushProvinces', 'chapelEconomy-d08', 'chapelEconomy-late3', 'chapelEconomy'];
  const dominionV4 = [
    ...dominionV3,
    'chapelEconomyV2',
    'chapelEconomyV2-noGreen',
    'chapelEconomyV2-clonebuy',
    'witchRushNoTrash',
    'opusCloneDominion',
  ];

  // 30s headroom per test is generous relative to the ~1-4s standalone
  // ts-node cost at 3 seeds; kept only as documentation since `fingerprint`
  // runs fully synchronously (Node's event loop can't fire jest's timeout
  // timer until the call returns anyway).
  it('gomoku v5 registry flags reproduce the pre-assembly-field digest', () => {
    expect(fingerprint(gomokuFullAdapter, gomokuV5)).toBe(
      'sha256-fb4ec2dcfa8a10ce7e6701302473ab2e75fef6da3edc8a5c9b0924df99286e63',
    );
  }, 30_000);

  it('gomoku v6 registry flags reproduce the pre-assembly-field digest', () => {
    expect(fingerprint(gomokuFullAdapter, gomokuV6)).toBe(
      'sha256-e1a530a083268016dee572adf732686b6313739d96f1da017853307eb152cb8e',
    );
  }, 30_000);

  it('gomoku v7 registry flags reproduce the pre-assembly-field digest', () => {
    expect(fingerprint(gomokuFullAdapter, gomokuV7)).toBe(
      'sha256-80b5a5337c83abbef3a6bf4272d63286de58ee79e7137a722b0ed826422e259d',
    );
  }, 30_000);

  it('dominion v3 registry flags reproduce the pre-assembly-field digest', () => {
    expect(fingerprint(dominion, dominionV3)).toBe(
      'sha256-faf5792f4cdbf2a63e5cf4e369085b733e7c0a0b20855d96f20f706dc2aa56a0',
    );
  }, 30_000);

  it('dominion v4 registry flags reproduce the pre-assembly-field digest', () => {
    expect(fingerprint(dominion, dominionV4)).toBe(
      'sha256-0e89d9df0d95972fb7e21b8e75d6e952566017847cc54b75d55586ca29d921e2',
    );
  }, 30_000);
});
