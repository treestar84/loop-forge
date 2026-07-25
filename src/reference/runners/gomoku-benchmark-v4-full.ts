/**
 * gomoku-benchmark-v4-full — a second, independently-seeded 3-column
 * win-rate measurement of registry v4 (docs/BENCHMARK-EXPERIMENT.md),
 * requested to re-verify mcts2-s256-hr's per-game cost and give the mcts2
 * candidate a fresh, non-overlapping seed sample on top of
 * gomoku-benchmark-v4.ts's existing `benchmark-3col-v4.json/md` (N=700,
 * seeds 70,000-70,699, generated 2026-07-23). That existing file is NOT
 * overwritten by this one — separate RUN_SUFFIX, separate output filenames,
 * separate seed range (task instruction: "산출물명 benchmark-3col-v4-full
 * 등 기존 v4 파일과 구분").
 *
 * CORRECTION (task report): the task that requested this file described the
 * existing v4 output as "N=20 소표본" (docs/BENCHMARK-LEADERBOARD.md's
 * "결과 3" entry, based on a stale GAP-ANALYSIS-8 note). Direct inspection of
 * `runs/gomoku/benchmark-3col-v4.json` shows it was actually already run at
 * N=700 (elapsedSeconds=1606.8, seeds 70,000-70,699, generated
 * 2026-07-23T16:17Z) — a properly-sized, properly-disclosed (N<2000, flagged
 * per BENCHMARK-EXPERIMENT.md §3's adjustment clause) result, not a N=20
 * smoke sample. This file's N=700-independent-seeds run is additional
 * evidence on top of that, not a fix for a small-sample problem that turned
 * out not to exist.
 *
 * Column definitions unchanged from v3/v4:
 *   A. Opus 설계봇      vs 기본봇(baselines.heuristic)
 *   B. 루프포지봇        vs 기본봇(baselines.heuristic)
 *   C. Opus 설계봇      vs 루프포지봇
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
  gomokuMctsFlagSpecFor,
} from './shared/gomoku-mcts-flag';

const GAME_ID = 'gomoku';
const ADOPTED_VERDICT = 'adopted';
const RUN_SUFFIX = '-v4-full';

/**
 * N chosen from an empirical timing trial (this file run with `--n=3`, nice
 * -n 10, single process, output not checked in — see task report for the raw
 * log): A) 0.0s/3 blocks (negligible), B) 3.3s/3 blocks (~1.1s/block), C)
 * 1.6s/3 blocks (~0.533s/block) — consistent with gomoku-benchmark-v4.ts's
 * own trial (B~1.275s/block, C~0.595s/block); mcts2-s256-hr dominates both
 * columns since apply() discards `base`. Combined B+C rate ≈ 1.63s/block.
 * N=700 (matching the existing v4 file's N so the two independent samples
 * are directly poolable/comparable) costs 700*1.63s ≈ 1,141s (~19 min),
 * comfortably inside the 30-minute (1,800s) wave budget.
 */
const DEFAULT_N = 700;
/** Non-overlapping with v3 (50,000-51,999) and v4 (70,000-70,699). */
const SEED_BASE = 80_000;

/** Distinct bot-seed bases per column so the three matchups never share a
 * derived bot-seed stream (cross-contamination guard, per task spec). Also
 * distinct from v4's bases (900_101-3). */
const BOT_SEED_BASE = { A: 960_101, B: 960_102, C: 960_103 } as const;

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
  ]);
  const specDigest = sha256Digest(canonicalJson(bareAdapter.spec));
  const seeds = buildSeeds(n);

  const opusBot = gomokuOpusBot;
  const baseline = gomokuAdapter.baselines.heuristic;
  const resolved = resolveLoopForgeFlags(rootDir);
  const loopForgeBot = composeBot(adapter, resolved.flags);
  const usesMcts = resolved.flags.includes(GOMOKU_MCTS_FLAG) || resolved.flags.includes(GOMOKU_MCTS2_S256_HR_FLAG);

  console.log(`=== gomoku 3-column benchmark v4-full (N=${n} seeds/column, seedBase=${SEED_BASE}) ===`);
  console.log(
    `  registry latest: ${resolved.registryLatestVersion} flags=[${resolved.registryLatestFlags.join(', ') || '(none)'}]`,
  );
  console.log(`  루프포지봇 composed flags: [${resolved.flags.join(', ') || '(none)'}]`);
  console.log(`  specDigest: ${specDigest}`);
  if (usesMcts) {
    console.log(
      `  NOTE: 루프포지봇 flags include an MCTS candidate — per-game cost is much higher than the hand-authored flags (search rollout).`,
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
      `v4-full run: independent second sample of registry v4 (mcts2-s256-hr), seeds ${SEED_BASE}-${SEED_BASE + n - 1} — non-overlapping with benchmark-3col-v4.json/md's seeds 70,000-70,699. Requested to re-verify mcts2-s256-hr's per-game cost/win rate; the existing v4 file turned out to already be N=700 (not the N=20 the requesting task described, which traced to a stale leaderboard note) so this is additional evidence, not a small-sample fix.`,
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
  return `# 오목(gomoku) — 3열 벤치마크 (v4-full)

생성: ${new Date().toISOString()}
N = ${n} 시드/열(시드 ${SEED_BASE}-${SEED_BASE + n - 1}) · 좌석 페어드 미러링 · 게이트 없음(runHeadToHead)
specDigest = \`${specDigest}\`

> **v4-full 표기**: registry v4(mcts2-s256-hr 승격) 위에서 \`benchmark-3col-v4.json/md\`
> (N=700, 시드 70,000-70,699, 2026-07-23 생성)와 **겹치지 않는 새 시드**로 돌린
> 독립 2차 표본. 이 작업을 요청한 지시는 기존 v4 결과를 "N=20 소표본"으로
> 설명했으나, 실제 파일을 확인한 결과 이미 N=700으로 정상 측정돼 있었다
> (docs/BENCHMARK-LEADERBOARD.md의 "결과 3" 항목이 낡은 근거를 인용한 것으로
> 추정). 따라서 이 파일은 "소표본 문제 해결"이 아니라 mcts2-s256-hr 판당
> 비용·승률의 **독립 재검증 표본**이다.

## 루프포지봇 구성

- 합성 플래그: ${resolved.flags.length > 0 ? resolved.flags.map((f) => `\`${f}\``).join(', ') : '(없음)'}
- 플래그 출처: **${flagSource}**
- registry 최신 버전: ${resolved.registryLatestVersion ?? '(없음)'} (flags=${resolved.registryLatestFlags.length > 0 ? resolved.registryLatestFlags.join(', ') : '없음'})
${
  usesMcts
    ? '- ⚠ 합성 플래그에 MCTS 후보(`mcts2-s256-hr`) 포함 — apply()가 base를 무시하므로 마지막에 합성된 이 플래그가 봇의 전체 결정을 지배함. 판당 비용이 hand-authored 플래그보다 훨씬 큼(UCT 롤아웃, 시뮬레이션 256회).\n'
    : ''
}
## 결과

| 열 | 매치업 | 승률 | 95% CI | draw/split | 블록수 |
|---|---|---|---|---|---|
| A | Opus봇 vs 기본봇 | ${pct(colA.candidateWinRate)} | ${ci(colA)} | ${pct(colA.drawRate)} | ${colA.blocks} |
| B | 루프포지봇 vs 기본봇 | ${pct(colB.candidateWinRate)} | ${ci(colB)} | ${pct(colB.drawRate)} | ${colB.blocks} |
| C | Opus봇 vs 루프포지봇 | ${pct(colC.candidateWinRate)} | ${ci(colC)} | ${pct(colC.drawRate)} | ${colC.blocks} |

채택 전략 수: ${resolved.flags.length}/5 (v4: blockImmediateThreat, centerProximity, extendLongestLine, mcts-s64, mcts2-s256-hr)

## 해석 주의

- 승률은 게임 간 비교 불가(게임마다 \`baselines.heuristic\` 강함이 다름). 오목 내부에서 A·B·C 3개를 함께 보는 것이 실험 단위.
- \`draw/split\`은 candidateWinFraction===0.5인 블록 비율 — 순수 무승부와 "한 좌석 승·한 좌석 패"(미러링 분할)를 모두 포함한다. 순수 무승부율이 아니다.
- 좌석 미러링으로 선공 이점은 상쇄됨.
- 게이트(SPRT/holdout)를 거치지 않은 순수 집계값(관찰 보고용).
- 이 파일(v4-full)은 \`benchmark-3col-v4.json/md\`와 시드가 달라 독립 표본이지만, registry 버전·specDigest·N은 동일 — 같은 comparabilityKey 문맥이므로 두 표본을 나란히 비교(합치거나 평균)해도 되는 유일한 쌍이다.

총 소요: ${totalSeconds.toFixed(1)}s
`;
}

main();
