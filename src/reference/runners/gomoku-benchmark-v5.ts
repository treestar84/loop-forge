/**
 * gomoku-benchmark-v5 — v5 follow-up to gomoku-benchmark-v4.ts's/
 * gomoku-benchmark-v4-full.ts's 3-column win-rate benchmark
 * (docs/BENCHMARK-EXPERIMENT.md), run after mcts-wave-4
 * (docs/GAP-ANALYSIS-8.md gomoku C-column retry) promoted both
 * `mcts2-s256-cr` and `mcts2-s512-cr` into registry v5. A separate file
 * rather than editing gomoku-benchmark-v4*.ts in place: those files'
 * benchmark-3col-v4[.-full].json/md outputs must not be overwritten
 * (comparability key differs — different specDigest/registry version,
 * docs/INTERPRETATION.md rule 1), so v5 gets its own entrypoint and its own
 * output filenames.
 *
 * Column definitions unchanged from v3/v4:
 *   A. Opus 설계봇      vs 기본봇(baselines.heuristic)
 *   B. 루프포지봇        vs 기본봇(baselines.heuristic)
 *   C. Opus 설계봇      vs 루프포지봇
 *
 * "루프포지봇" here composes registry v5's flags — which end with
 * `mcts2-s512-cr` (every MCTS flag on this adapter discards `base` in
 * apply(), so composing them in order means the LAST one, mcts2-s512-cr,
 * alone determines every decision the composed bot makes; every earlier flag
 * in v5's chain, including mcts2-s256-cr itself, has no observable effect
 * once mcts2-s512-cr is applied on top).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer) per src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { canonicalJson, sha256Digest } from '../../kernel/digest';
import { loadOrCreateLedger, loadOrCreateRegistry } from '../../artifacts/game-state';
import { gomokuAdapter } from '../gomoku';
import { gomokuOpusBot } from '../experiments/gomoku-opus-bot';
import {
  GOMOKU_MCTS_CONFIG,
  GOMOKU_MCTS_FLAG,
  GOMOKU_MCTS_HR_CONFIG,
  GOMOKU_MCTS_HR_FLAG,
  GOMOKU_MCTS2_S256_CONFIG,
  GOMOKU_MCTS2_S256_FLAG,
  GOMOKU_MCTS2_S256_HR_CONFIG,
  GOMOKU_MCTS2_S256_HR_FLAG,
  GOMOKU_MCTS2_S256_CR_FLAG,
  GOMOKU_MCTS2_S512_CR_FLAG,
  gomokuMctsFlagSpecFor,
  gomokuMcts2S256CrFlagSpec,
  gomokuMcts2S512CrFlagSpec,
} from './shared/gomoku-mcts-flag';

const GAME_ID = 'gomoku';
const ADOPTED_VERDICT = 'adopted';
const RUN_SUFFIX = '-v5';

/**
 * N chosen from an empirical timing trial (this file run with `--n=20`, nice
 * -n 10, single process; trial also wrote benchmark-3col-v5.json/md, later
 * overwritten by the real N run below): A) 0.0s/20 blocks (negligible — no
 * MCTS on either side), B) 10.6s/20 blocks (~0.53s/block), C) 6.8s/20 blocks
 * (~0.34s/block) — combined B+C rate ≈ 0.87s/block, higher than the initial
 * ≈0.59s/block estimate from the mcts-wave-4 diagnostic's aggregate
 * 88-189ms/game figure (that figure covered CR-vs-internal-baseline
 * matchups only, not the Opus-bot matchups here). N=2,000 at this rate would
 * cost ≈1,740s (~29 min), too close to the 30-minute (1,800s) budget given
 * the variance already observed across other waves (worst-case runs ~1.2-1.4x
 * the trial rate) — so N is scaled down to 1,300, costing
 * 1,300*0.87s ≈ 1,131s (~19 min) at the trial rate, ≈1,357-1,583s
 * (~23-26 min) worst-case, safely inside the 30-minute budget with headroom
 * even in the worst case.
 */
const DEFAULT_N = 1300;
/** Fresh, unused range: does not overlap gomoku-benchmark.ts (50,000-51,999),
 * gomoku-benchmark-v4.ts (70,000-70,699), gomoku-benchmark-v4-full.ts
 * (80,000-80,699), any gomoku-runner- or gomoku-mcts-N wave seed bank in
 * gomoku.ts (1-999, 1000-2029, 8000-10014, 20000-23039, 60000-63039,
 * 70000-73039), gomoku.ts's calibration identitySeeds (700,000-700,099), or
 * scratch-diag/gomoku-diag-c-column.ts (9,000,000+). NOTE: this wave's own
 * `gomoku-mcts4-smoke` bank (70000-70029, wired in gomoku.ts's mcts-wave-4)
 * was discovered, after the wave already ran, to overlap
 * gomoku-benchmark-v4.ts's seeds 70,000-70,699 — see this task's final
 * report. That overlap does not affect this file's seed choice since 90,000+
 * is clear of all of the above either way.
 */
const SEED_BASE = 90_000;

/** Distinct bot-seed bases per column so the three matchups never share a
 * derived bot-seed stream (cross-contamination guard, per task spec). Also
 * distinct from v4 (900_101-3) and v4-full (960_101-3). */
const BOT_SEED_BASE = { A: 970_201, B: 970_202, C: 970_203 } as const;

function parseN(argv: readonly string[]): number {
  for (const arg of argv) {
    const match = /^--n=(\d+)$/.exec(arg);
    if (match) {
      const value = Number.parseInt(match[1] as string, 10);
      if (value > 0) return value;
    }
  }
  return DEFAULT_N;
}

function buildSeeds(n: number): number[] {
  return Array.from({ length: n }, (_, i) => SEED_BASE + i);
}

/** Same fallback logic as gomoku-benchmark.ts's resolveLoopForgeFlags: prefer
 * registry.latest() flags, fall back to ledger-adopted flags. */
function resolveLoopForgeFlags(rootDir: string): {
  flags: string[];
  registryLatestVersion: string | null;
  registryLatestFlags: string[];
} {
  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const ledger = loadOrCreateLedger(rootDir, GAME_ID);

  const latest = registry.latest();
  const registryLatestFlags = latest ? [...latest.flags] : [];

  const adopted: string[] = [];
  for (const record of ledger.all()) {
    for (const entry of record.entries) {
      if (entry.verdict === ADOPTED_VERDICT) {
        for (const flag of entry.flags) {
          if (!adopted.includes(flag)) adopted.push(flag);
        }
      }
    }
  }

  const flags = registryLatestFlags.length > 0 ? registryLatestFlags : adopted;

  return {
    flags,
    registryLatestVersion: latest ? latest.version : null,
    registryLatestFlags,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function ci(result: HeadToHeadResult): string {
  return `${pct(result.winRateCI.lower)}–${pct(result.winRateCI.upper)}`;
}

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const n = parseN(process.argv.slice(2));
  const bareAdapter = eraseAdapter(gomokuAdapter);
  const adapter = withStrategyFlags(bareAdapter, [
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_CONFIG, GOMOKU_MCTS_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_HR_CONFIG, GOMOKU_MCTS_HR_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_CONFIG, GOMOKU_MCTS2_S256_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_HR_CONFIG, GOMOKU_MCTS2_S256_HR_FLAG),
    gomokuMcts2S256CrFlagSpec(bareAdapter),
    gomokuMcts2S512CrFlagSpec(bareAdapter),
  ]);
  const specDigest = sha256Digest(canonicalJson(bareAdapter.spec));
  const seeds = buildSeeds(n);

  const opusBot = gomokuOpusBot;
  const baseline = gomokuAdapter.baselines.heuristic;
  const resolved = resolveLoopForgeFlags(rootDir);
  const loopForgeBot = composeBot(adapter, resolved.flags);
  const usesMcts =
    resolved.flags.includes(GOMOKU_MCTS_FLAG) ||
    resolved.flags.includes(GOMOKU_MCTS2_S256_HR_FLAG) ||
    resolved.flags.includes(GOMOKU_MCTS2_S256_CR_FLAG) ||
    resolved.flags.includes(GOMOKU_MCTS2_S512_CR_FLAG);

  console.log(`=== gomoku 3-column benchmark v5 (N=${n} seeds/column, seedBase=${SEED_BASE}) ===`);
  console.log(
    `  registry latest: ${resolved.registryLatestVersion} flags=[${resolved.registryLatestFlags.join(', ') || '(none)'}]`,
  );
  console.log(`  루프포지봇 composed flags: [${resolved.flags.join(', ') || '(none)'}]`);
  console.log(`  specDigest: ${specDigest}`);
  if (usesMcts) {
    console.log(
      `  NOTE: 루프포지봇 flags include an MCTS candidate — per-game cost is much higher than the hand-authored flags (search rollout). v5's composed bot resolves to mcts2-s512-cr (last flag, apply() discards base).`,
    );
  }

  const t0 = Date.now();
  console.log('  A) Opus봇 vs 기본봇 …');
  const colA = runHeadToHead(adapter, opusBot, baseline, seeds, BOT_SEED_BASE.A);
  const tA = Date.now();
  console.log(
    `     winRate=${pct(colA.candidateWinRate)} CI=${ci(colA)} draw/split=${pct(colA.drawRate)} blocks=${colA.blocks} (${((tA - t0) / 1000).toFixed(1)}s)`,
  );

  console.log('  B) 루프포지봇 vs 기본봇 …');
  const colB = runHeadToHead(adapter, loopForgeBot, baseline, seeds, BOT_SEED_BASE.B);
  const tB = Date.now();
  console.log(
    `     winRate=${pct(colB.candidateWinRate)} CI=${ci(colB)} draw/split=${pct(colB.drawRate)} blocks=${colB.blocks} (${((tB - tA) / 1000).toFixed(1)}s)`,
  );

  console.log('  C) Opus봇 vs 루프포지봇 …');
  const colC = runHeadToHead(adapter, opusBot, loopForgeBot, seeds, BOT_SEED_BASE.C);
  const tC = Date.now();
  console.log(
    `     winRate=${pct(colC.candidateWinRate)} CI=${ci(colC)} draw/split=${pct(colC.drawRate)} blocks=${colC.blocks} (${((tC - tB) / 1000).toFixed(1)}s)`,
  );

  const totalSeconds = (tC - t0) / 1000;
  console.log(`  총 소요: ${totalSeconds.toFixed(1)}s`);

  const outDir = join(rootDir, 'runs', GAME_ID);
  mkdirSync(outDir, { recursive: true });

  const jsonPayload = {
    gameId: GAME_ID,
    generatedAt: new Date().toISOString(),
    n,
    seedBase: SEED_BASE,
    botSeedBase: BOT_SEED_BASE,
    specDigest,
    loopForge: {
      composedFlags: resolved.flags,
      registryLatestVersion: resolved.registryLatestVersion,
      registryLatestFlags: resolved.registryLatestFlags,
      flagSource: resolved.registryLatestFlags.length > 0 ? 'registry-latest' : 'ledger-adopted',
      usesMcts,
    },
    columns: {
      A_opusVsBaseline: colA,
      B_loopForgeVsBaseline: colB,
      C_opusVsLoopForge: colC,
    },
    elapsedSeconds: totalSeconds,
    notes: [
      'Gate-free aggregation (runHeadToHead): no screen/smoke/prune/holdout gating.',
      'candidate/opponent seats are paired-mirrored (runPairedBlock), so first-mover advantage is cancelled.',
      'drawRate here counts blocks with candidateWinFraction===0.5 — i.e. true draws AND seat-split (win one seat, lose the other), not draws alone.',
      'Win rates across different games are NOT comparable (different baselines.heuristic strength); only A vs B vs C within gomoku are.',
      `v5 run: registry v5 (mcts2-s256-cr + mcts2-s512-cr promoted from mcts-wave-4), seeds ${SEED_BASE}-${SEED_BASE + n - 1} — fresh range, non-overlapping with benchmark-3col-v4.json/md (70,000-70,699), benchmark-3col-v4-full.json/md (80,000-80,699), or benchmark-3col.json/md (50,000-51,999).`,
    ],
  };
  writeFileSync(join(outDir, `benchmark-3col${RUN_SUFFIX}.json`), JSON.stringify(jsonPayload, null, 2));
  console.log(`  저장: runs/${GAME_ID}/benchmark-3col${RUN_SUFFIX}.json`);

  const md = renderMarkdown(n, resolved, colA, colB, colC, totalSeconds, specDigest, usesMcts);
  writeFileSync(join(outDir, `benchmark-3col${RUN_SUFFIX}.md`), md);
  console.log(`  저장: runs/${GAME_ID}/benchmark-3col${RUN_SUFFIX}.md`);
}

function renderMarkdown(
  n: number,
  resolved: ReturnType<typeof resolveLoopForgeFlags>,
  colA: HeadToHeadResult,
  colB: HeadToHeadResult,
  colC: HeadToHeadResult,
  totalSeconds: number,
  specDigest: string,
  usesMcts: boolean,
): string {
  const flagSource = resolved.registryLatestFlags.length > 0 ? 'registry-latest' : 'ledger-adopted';
  return `# 오목(gomoku) — 3열 벤치마크 (v5)

생성: ${new Date().toISOString()}
N = ${n} 시드/열(시드 ${SEED_BASE}-${SEED_BASE + n - 1}) · 좌석 페어드 미러링 · 게이트 없음(runHeadToHead)
specDigest = \`${specDigest}\`

> **v5 표기**: registry v5(mcts2-s256-cr, mcts2-s512-cr 승격 — mcts-wave-4)
> 기준. 루프포지봇은 v5의 마지막 플래그인 \`mcts2-s512-cr\`(챔피언 롤아웃,
> 시뮬레이션 512회)이 전체 결정을 지배한다(모든 MCTS 플래그의 apply()가
> base를 무시하므로).

## 루프포지봇 구성

- 합성 플래그: ${resolved.flags.length > 0 ? resolved.flags.map((f) => `\`${f}\``).join(', ') : '(없음)'}
- 플래그 출처: **${flagSource}**
- registry 최신 버전: ${resolved.registryLatestVersion ?? '(없음)'} (flags=${resolved.registryLatestFlags.length > 0 ? resolved.registryLatestFlags.join(', ') : '없음'})
${
  usesMcts
    ? '- ⚠ 합성 플래그에 MCTS 후보 포함 — apply()가 base를 무시하므로 마지막에 합성된 `mcts2-s512-cr`이 봇의 전체 결정을 지배함. 판당 비용은 mcts2-s256-hr(v4)보다 낮음(챔피언 롤아웃이 얕은 heuristic-composite 플레이아웃이라 무작위/휴리스틱 롤아웃보다 저렴).\n'
    : ''
}
## 결과

| 열 | 매치업 | 승률 | 95% CI | draw/split | 블록수 |
|---|---|---|---|---|---|
| A | Opus봇 vs 기본봇 | ${pct(colA.candidateWinRate)} | ${ci(colA)} | ${pct(colA.drawRate)} | ${colA.blocks} |
| B | 루프포지봇 vs 기본봇 | ${pct(colB.candidateWinRate)} | ${ci(colB)} | ${pct(colB.drawRate)} | ${colB.blocks} |
| C | Opus봇 vs 루프포지봇 | ${pct(colC.candidateWinRate)} | ${ci(colC)} | ${pct(colC.drawRate)} | ${colC.blocks} |

채택 전략 수: ${resolved.flags.length}/7 (v5: blockImmediateThreat, centerProximity, extendLongestLine, mcts-s64, mcts2-s256-hr, mcts2-s256-cr, mcts2-s512-cr)

## 해석 주의

- 승률은 게임 간 비교 불가(게임마다 \`baselines.heuristic\` 강함이 다름). 오목 내부에서 A·B·C 3개를 함께 보는 것이 실험 단위.
- \`draw/split\`은 candidateWinFraction===0.5인 블록 비율 — 순수 무승부와 "한 좌석 승·한 좌석 패"(미러링 분할)를 모두 포함한다. 순수 무승부율이 아니다.
- 좌석 미러링으로 선공 이점은 상쇄됨.
- 게이트(SPRT/holdout)를 거치지 않은 순수 집계값(관찰 보고용).
- 이 파일(v5)은 registry 버전·specDigest가 v4/v4-full과 달라 별도 comparabilityKey 문맥 — v4/v4-full 결과와 직접 비교(합치거나 평균)하지 말 것(docs/INTERPRETATION.md 제1규칙).

총 소요: ${totalSeconds.toFixed(1)}s
`;
}

main();
