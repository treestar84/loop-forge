/**
 * splendor-benchmark-v3 — v3 follow-up to the 3-column win-rate benchmark of
 * docs/BENCHMARK-EXPERIMENT.md, run for splendor after ismcts-wave-3
 * (docs/GAP-ANALYSIS-8.md §4.5's near-miss, DESIGN.md §6.1 near-miss loop
 * retry) promoted `ismcts-s128-cr` into registry v3 on top of v2's
 * `buyHighestPoints`. This is NOT an onboarding runner (that is
 * reference/runners/splendor.ts, which scores conformance and runs gated
 * waves); it is a pure gate-free aggregation that compares three bots
 * head-to-head:
 *
 *   A. Opus 설계봇      vs 기본봇(baselines.heuristic)
 *   B. 루프포지봇        vs 기본봇(baselines.heuristic)
 *   C. Opus 설계봇      vs 루프포지봇
 *
 * "Opus 설계봇" = reference/experiments/splendor-opus-bot.ts, a one-shot LLM
 * design that never touched the Loop Forge scoring/wave/gate pipeline (reused
 * verbatim from the v1/v2 measurement — never re-designed, per task spec).
 * "루프포지봇" = baselines.heuristic with the wave-adopted strategy flags
 * composed on top (loop/compose.ts). The v1 measurement file
 * (splendor-benchmark.ts, preserved as-is, not overwritten) predates
 * ismcts-wave-3 and never extended the adapter's strategySurface with the
 * `ismcts-s128-cr` flag spec, so composeBot(['buyHighestPoints',
 * 'ismcts-s128-cr']) would throw "unknown strategy flag" once the registry
 * promoted it to v3 — this v3 file fixes that by composing the same
 * withStrategyFlags extension reference/runners/splendor.ts's ismcts-wave-3
 * uses (mirrors gomoku-benchmark-v4.ts's and hearthstone-benchmark.ts's
 * (v2) precedent for the same class of bug). Column B is therefore, for the
 * first time, the actual `ismcts-s128-cr` candidate rather than the v2
 * `buyHighestPoints`-only heuristic.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer) per src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import {
  loadOrCreateLedger,
  loadOrCreateRegistry,
} from '../../artifacts/game-state';
import { splendorAdapter } from '../splendor';
import { splendorOpusBot } from '../experiments/splendor-opus-bot';
import { splendorIsmctsChampionRolloutFlagSpec } from './shared/splendor-ismcts-flag';

const GAME_ID = 'splendor';
const ADOPTED_VERDICT = 'adopted';
const RUN_SUFFIX = '-v3';

/**
 * N chosen from an empirical timing trial (this file run with `--n=3`, nice
 * -n 10, single process, output not checked in — see task report for the raw
 * log). ismcts-s128-cr is materially more expensive than the pristine
 * heuristic (SO-ISMCTS search, 128 simulations/decision, champion-composite
 * rollouts instead of raw heuristic rollouts), so N is scaled down from v1/v2's
 * 2,000 to stay inside the 30-minute wave budget with headroom for per-game
 * variance.
 */
const DEFAULT_N = 400;
const SEED_BASE = 60_000;

/** Distinct bot-seed bases per column so the three matchups never share a
 * derived bot-seed stream (cross-contamination guard, per task spec). Also
 * distinct from the v1 file's bases (810_001-3) and any other benchmark's
 * bases. */
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

/**
 * Resolve the flags that define "루프포지봇". BENCHMARK-EXPERIMENT.md §2 column
 * B defines this bot as the wave-adopted strategy flags composed on the
 * heuristic. Unlike the v1 measurement (registry was still v1/flags: [] at
 * the time), registry.json now has a v3 baseline (ismcts-wave-3 promoted
 * `ismcts-s128-cr` on top of v2's `buyHighestPoints`, docs/FIX-BACKLOG.md R9
 * having been addressed for this game), so registry.latest() resolves the
 * candidate directly and the ledger-fallback branch below is not expected to
 * be taken — it is kept only as the same defensive fallback the v1/hearthstone
 * v2 files use, and the output records which path was actually taken.
 */
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
  const bareAdapter = eraseAdapter(splendorAdapter);
  // registry v3's second adopted flag (ismcts-s128-cr) is only present on the
  // runner's wave-time adapter (reference/runners/splendor.ts's
  // ismcts-wave-3), never on splendorAdapter itself — extend here with the
  // exact same spec so composeBot can resolve it (same fix as
  // gomoku-benchmark-v4.ts / hearthstone-benchmark.ts's v2).
  const adapter = withStrategyFlags(bareAdapter, [splendorIsmctsChampionRolloutFlagSpec(bareAdapter)]);
  const seeds = buildSeeds(n);

  const opusBot = splendorOpusBot;
  const baseline = splendorAdapter.baselines.heuristic;
  const resolved = resolveLoopForgeFlags(rootDir);
  const loopForgeBot = composeBot(adapter, resolved.flags);

  console.log(`=== splendor 3-column benchmark v3 (N=${n} seeds/column) ===`);
  console.log(`  registry latest: ${resolved.registryLatestVersion} flags=[${resolved.registryLatestFlags.join(', ') || '(none)'}]`);
  console.log(`  루프포지봇 composed flags: [${resolved.flags.join(', ') || '(none)'}]`);
  if (resolved.registryLatestFlags.length === 0 && resolved.flags.length > 0) {
    console.log('  NOTE: registry latest had no flags; using ledger-adopted flags for column B.');
  }
  if (resolved.flags.includes('ismcts-s128-cr')) {
    console.log('  NOTE: 루프포지봇 flags include ismcts-s128-cr — per-game cost is much higher than the pristine heuristic (SO-ISMCTS search, champion-composite rollouts).');
  }

  const t0 = Date.now();
  console.log('  A) Opus봇 vs 기본봇 …');
  const colA = runHeadToHead(adapter, opusBot, baseline, seeds, BOT_SEED_BASE.A);
  const tA = Date.now();
  console.log(`     winRate=${pct(colA.candidateWinRate)} CI=${ci(colA)} draw/split=${pct(colA.drawRate)} blocks=${colA.blocks} (${((tA - t0) / 1000).toFixed(1)}s)`);

  console.log('  B) 루프포지봇 vs 기본봇 …');
  const colB = runHeadToHead(adapter, loopForgeBot, baseline, seeds, BOT_SEED_BASE.B);
  const tB = Date.now();
  console.log(`     winRate=${pct(colB.candidateWinRate)} CI=${ci(colB)} draw/split=${pct(colB.drawRate)} blocks=${colB.blocks} (${((tB - tA) / 1000).toFixed(1)}s)`);

  console.log('  C) Opus봇 vs 루프포지봇 …');
  const colC = runHeadToHead(adapter, opusBot, loopForgeBot, seeds, BOT_SEED_BASE.C);
  const tC = Date.now();
  console.log(`     winRate=${pct(colC.candidateWinRate)} CI=${ci(colC)} draw/split=${pct(colC.drawRate)} blocks=${colC.blocks} (${((tC - tB) / 1000).toFixed(1)}s)`);

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
    loopForge: {
      composedFlags: resolved.flags,
      registryLatestVersion: resolved.registryLatestVersion,
      registryLatestFlags: resolved.registryLatestFlags,
      flagSource: resolved.registryLatestFlags.length > 0 ? 'registry-latest' : 'ledger-adopted',
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
      'v3 run: registry v3 promoted ismcts-s128-cr (ismcts-wave-3, DESIGN.md §6.1 near-miss retry) on top of v2 (buyHighestPoints). The v1 measurement file (splendor-benchmark.ts, preserved unmodified) predates this promotion and never extended the adapter strategySurface with ismcts-s128-cr, so re-running it now would throw "unknown strategy flag ismcts-s128-cr" — this v3 file is the first to measure the actual v3 candidate.',
      `N=${n} chosen from an empirical timing trial (task report) to stay inside the 30-minute wave budget given ismcts-s128-cr's per-game cost.`,
      'Win rates across different games are NOT comparable (different baselines.heuristic strength); only A vs B vs C within splendor are.',
      'Win rates are NOT directly comparable to the v1 measurement (runs/splendor/benchmark-3col.json, A=36.6%/B=83.0%/C=6.9%, N=2,000) either: different registry baseline version (v3 vs v2), different composed flags, different seed base/N, and a materially different column-B bot (IS-MCTS search vs pure buyHighestPoints heuristic).',
    ],
  };
  writeFileSync(join(outDir, `benchmark-3col${RUN_SUFFIX}.json`), JSON.stringify(jsonPayload, null, 2));
  console.log(`  저장: runs/${GAME_ID}/benchmark-3col${RUN_SUFFIX}.json`);

  const md = renderMarkdown(n, resolved, colA, colB, colC, totalSeconds);
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
): string {
  const flagSource = resolved.registryLatestFlags.length > 0 ? 'registry-latest' : 'ledger-adopted';
  return `# 스플랜더(splendor) — 3열 벤치마크 (v3)

생성: ${new Date().toISOString()}
N = ${n} 시드/열 · 좌석 페어드 미러링 · 게이트 없음(runHeadToHead)

> **v3 표기**: registry v3(ismcts-s128-cr 승격, ismcts-wave-3, DESIGN.md §6.1
> near-miss 재도전) 반영. 이 파일의 v1 측정본(\`splendor-benchmark.ts\`, 수정 없이
> 보존됨)은 이 승격 이전(v1/v2 문맥)에 작성돼 어댑터의 strategySurface를
> \`ismcts-s128-cr\` 플래그로 확장하지 않았다 — composeBot이 이 플래그를 resolve할 수
> 없어 그대로 재실행하면 "unknown strategy flag" 에러가 난다. **B열이 실제
> ismcts-s128-cr 후보(챔피언 롤아웃)를 반영하는 것은 이 v3가 처음**이다.
>
> **v1 수치(A=36.6%, B=83.0%, C=6.9%, N=2,000, \`benchmark-3col.json\`)와 직접
> 비교 금지** — registry 기준선 버전(v2 vs v3), 합성 플래그, seed base/N, 그리고
> B열 봇의 성격(순정 \`buyHighestPoints\` 휴리스틱 vs IS-MCTS 탐색)이 전부 다르다.

## 루프포지봇 구성

- 합성 플래그: ${resolved.flags.length > 0 ? resolved.flags.map((f) => `\`${f}\``).join(', ') : '(없음)'}
- 플래그 출처: **${flagSource}**
- registry 최신 버전: ${resolved.registryLatestVersion ?? '(없음)'} (flags=${resolved.registryLatestFlags.length > 0 ? resolved.registryLatestFlags.join(', ') : '없음'})
- ⚠ 합성 플래그에 IS-MCTS 후보(\`ismcts-s128-cr\`) 포함 — apply()가 base를 무시하므로 이 플래그가 봇의 전체 결정을 지배함(단, 롤아웃은 챔피언 컴포지트 \`buyHighestPoints\` 봇이 담당). 판당 비용이 순정 heuristic보다 훨씬 큼(SO-ISMCTS 128 시뮬레이션).

## 결과

| 열 | 매치업 | 승률 | 95% CI | draw/split | 블록수 |
|---|---|---|---|---|---|
| A | Opus봇 vs 기본봇 | ${pct(colA.candidateWinRate)} | ${ci(colA)} | ${pct(colA.drawRate)} | ${colA.blocks} |
| B | 루프포지봇 vs 기본봇 | ${pct(colB.candidateWinRate)} | ${ci(colB)} | ${pct(colB.drawRate)} | ${colB.blocks} |
| C | Opus봇 vs 루프포지봇 | ${pct(colC.candidateWinRate)} | ${ci(colC)} | ${pct(colC.drawRate)} | ${colC.blocks} |

채택 전략 수: ${resolved.flags.length}/3 (buyHighestPoints, ismcts-s128-cr)

## 해석 주의

- 승률은 게임 간 비교 불가(게임마다 \`baselines.heuristic\` 강함이 다름). 스플랜더 내부에서 A·B·C 3개를 함께 보는 것이 실험 단위.
- \`draw/split\`은 candidateWinFraction===0.5인 블록 비율 — 순수 무승부와 "한 좌석 승·한 좌석 패"(미러링 분할)를 모두 포함한다. 순수 무승부율이 아니다.
- 좌석 미러링으로 선공 이점은 상쇄됨.
- 게이트(SPRT/holdout)를 거치지 않은 순수 집계값(관찰 보고용).
- 이 파일(v3)은 registry v3와 새 세션 시드를 반영해 v1 \`benchmark-3col.json/md\`와 직접 비교 불가(위 안내 참고).

총 소요: ${totalSeconds.toFixed(1)}s
`;
}

main();
