/**
 * wingspan-benchmark-v2 — v2 follow-up to the 3-column win-rate benchmark of
 * docs/BENCHMARK-EXPERIMENT.md, run for wingspan after ismcts-wave-2
 * (docs/FIX-BACKLOG.md P4/P6) promoted `ismcts-s256-hr` into registry v2. This
 * is NOT the onboarding runner (that is reference/runners/wingspan.ts, which
 * scores conformance and runs gated waves); it is a pure gate-free
 * aggregation comparing three bots head-to-head:
 *
 *   A. Opus 설계봇      vs 기본봇(baselines.heuristic)
 *   B. 루프포지봇        vs 기본봇(baselines.heuristic)
 *   C. Opus 설계봇      vs 루프포지봇
 *
 * "Opus 설계봇" = reference/experiments/wingspan-opus-bot.ts, a one-shot LLM
 * design that never touched the Loop Forge scoring/wave/gate pipeline.
 * "루프포지봇" = baselines.heuristic with the wave-adopted strategy flags
 * composed on top (loop/compose.ts). The v1 version of this file (git
 * history) predates ismcts-wave-2 and never extended the adapter's
 * strategySurface with the ismcts-s256-hr flag spec, so
 * composeBot(['ismcts-s256-hr']) would throw "unknown strategy flag" once the
 * registry promoted it — this v2 file fixes that by composing the same
 * withStrategyFlags extension reference/runners/wingspan.ts's ismcts-wave-2
 * uses (mirrors gomoku-benchmark-v4.ts's precedent for the same class of
 * bug). Column B is therefore, for the first time, the actual
 * ismcts-s256-hr candidate rather than the pristine heuristic.
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
import { wingspanAdapter } from '../wingspan';
import { wingspanOpusBot } from '../experiments/wingspan-opus-bot';
import { wingspanIsmctsFlagSpec } from './shared/wingspan-ismcts-flag';

const GAME_ID = 'wingspan';
const ADOPTED_VERDICT = 'adopted';
const RUN_SUFFIX = '-v2';

/** Column seed count. Overridable via `--n=<count>` so the timing trial and
 * the full run share one entrypoint. Seeds are drawn from a fixed base so the
 * benchmark is fully reproducible. wingspan's ismcts-s256-hr is cheap
 * (~17.3ms/game in isolation, shared/wingspan-ismcts-flag.ts). Empirical
 * timing trial (this file run with `--n=3`, nice -n 10, single process,
 * output not checked in — see task report for the raw log): A) 0.0s/3
 * blocks, B) 0.2s/3 blocks (~0.067s/block), C) 0.1s/3 blocks (~0.033s/block)
 * — combined B+C rate ≈ 0.1s/block, so the full N=2000 default finishes in
 * roughly 200s (~3.3 min), comfortably inside the 30-minute wave budget. */
const DEFAULT_N = 2000;
const SEED_BASE = 55_000;

/** Distinct bot-seed bases per column so the three matchups never share a
 * derived bot-seed stream (cross-contamination guard, per task spec). Also
 * distinct from the v1 file's bases since v1 never persisted an output and
 * this run uses a different seed range anyway. */
const BOT_SEED_BASE = { A: 951_101, B: 952_202, C: 953_303 } as const;

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
 * heuristic. In this repo the onboarding runner records adoptions in the
 * ledger but does NOT promote them into a new BaselineRegistry version — so
 * registry.latest() is still the pristine v1 (flags: []). We therefore source
 * the flags from the ledger's `adopted` entries and report the
 * registry-vs-ledger divergence so the number is never silently mistaken for a
 * promoted baseline. For wingspan the ledger holds zero `adopted` entries, so
 * `flags` is empty and the composed bot equals the baseline.
 */
function resolveLoopForgeFlags(rootDir: string): {
  flags: string[];
  registryLatestVersion: string | null;
  registryLatestFlags: string[];
  adoptedCount: number;
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
    adoptedCount: adopted.length,
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
  const bareAdapter = eraseAdapter(wingspanAdapter);
  // registry v2's adopted flag (ismcts-s256-hr) is only present on the
  // runner's wave-time adapter (reference/runners/wingspan.ts's
  // ismcts-wave-2), never on wingspanAdapter itself — extend here with the
  // exact same spec so composeBot can resolve it (same fix as
  // gomoku-benchmark-v4.ts).
  const adapter = withStrategyFlags(bareAdapter, [wingspanIsmctsFlagSpec(bareAdapter)]);
  const seeds = buildSeeds(n);

  const opusBot = wingspanOpusBot;
  const baseline = wingspanAdapter.baselines.heuristic;
  const resolved = resolveLoopForgeFlags(rootDir);
  const loopForgeBot = composeBot(adapter, resolved.flags);

  console.log(`=== wingspan 3-column benchmark v2 (N=${n} seeds/column) ===`);
  console.log(`  registry latest: ${resolved.registryLatestVersion} flags=[${resolved.registryLatestFlags.join(', ') || '(none)'}]`);
  console.log(`  루프포지봇 composed flags: [${resolved.flags.join(', ') || '(none)'}] (adopted=${resolved.adoptedCount})`);
  if (resolved.adoptedCount === 0) {
    console.log('  NOTE: wave adopted 0 flags; column B bot == baseline (win rate ~50% by construction).');
  } else {
    console.log(
      '  NOTE: 루프포지봇 flags include ismcts-s256-hr — per-game cost is much higher than the pristine heuristic (SO-ISMCTS search rollout).',
    );
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
      adoptedCount: resolved.adoptedCount,
      registryLatestVersion: resolved.registryLatestVersion,
      registryLatestFlags: resolved.registryLatestFlags,
      flagSource: resolved.registryLatestFlags.length > 0 ? 'registry-latest' : 'ledger-adopted',
      columnBEqualsBaseline: resolved.flags.length === 0,
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
      resolved.adoptedCount === 0
        ? 'wingspan wave adopted 0 flags, so column B bot == baseline; its win rate is ~50% by construction, NOT a failure (BENCHMARK-EXPERIMENT.md §4).'
        : `wingspan wave adopted ${resolved.adoptedCount} flag(s) (${resolved.flags.join(', ')}); column B composes them onto baselines.heuristic.`,
      'v2 run: registry v2 promoted ismcts-s256-hr (docs/FIX-BACKLOG.md P4/P6, ismcts-wave-2) on top of v1 — the v1 version of this file predated that promotion and never extended the adapter strategySurface with the flag, so its column B silently fell back to the pristine heuristic (composeBot would have thrown otherwise). This v2 run is the FIRST time column B reflects the actual adopted candidate.',
      'Win rates across different games are NOT comparable (different baselines.heuristic strength); only A vs B vs C within wingspan are.',
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
  const adoptedLabel =
    resolved.adoptedCount === 0
      ? `${resolved.adoptedCount} (아직 개선 없음)`
      : `${resolved.adoptedCount} (${resolved.flags.join(', ')})`;
  return `# 윙스팬(wingspan) — 3열 벤치마크 (v2)

생성: ${new Date().toISOString()}
N = ${n} 시드/열 · 좌석 페어드 미러링 · 게이트 없음(runHeadToHead)

> **v2 표기**: registry v2(ismcts-s256-hr 승격, docs/FIX-BACKLOG.md P4/P6,
> ismcts-wave-2) 반영. 이 파일의 이전 버전(v1)은 이 승격 이전에 작성돼
> 어댑터의 strategySurface를 ismcts-s256-hr 플래그로 확장하지 않았다 —
> composeBot이 이 플래그를 resolve할 수 없어 B열이 사실상 항상 순정
> heuristic으로 폴백됐을 것이다(v1 산출물은 디스크에 저장된 적이 없어 직접
> 비교 불가). **B열이 실제 ismcts-s256-hr 후보를 반영하는 것은 이 v2가
> 처음**이다.

## 루프포지봇 구성

- 합성 플래그: ${resolved.flags.length > 0 ? resolved.flags.map((f) => `\`${f}\``).join(', ') : '(없음)'}
- 플래그 출처: **${flagSource}**
- registry 최신 버전: ${resolved.registryLatestVersion ?? '(없음)'} (flags=${resolved.registryLatestFlags.length > 0 ? resolved.registryLatestFlags.join(', ') : '없음'})
${
  resolved.adoptedCount === 0
    ? '- ⚠ 채택 0개다. 따라서 B열 봇은 기본봇과 완전히 동일하며, B열 승률은 구조상 ~50%로 나온다 — 실패가 아니라 "루프 포지가 아직 이 게임에서 유의미한 전략을 발굴하지 못했다"는 뜻(BENCHMARK-EXPERIMENT.md §4).\n'
    : '- ⚠ 합성 플래그에 IS-MCTS 후보(`ismcts-s256-hr`) 포함 — apply()가 base를 무시하므로 이 플래그가 봇의 전체 결정을 지배함. 판당 비용이 순정 heuristic보다 훨씬 큼(SO-ISMCTS 롤아웃, 시뮬레이션 256회).\n'
}
## 결과

| 열 | 매치업 | 승률 | 95% CI | draw/split | 블록수 |
|---|---|---|---|---|---|
| A | Opus봇 vs 기본봇 | ${pct(colA.candidateWinRate)} | ${ci(colA)} | ${pct(colA.drawRate)} | ${colA.blocks} |
| B | 루프포지봇 vs 기본봇 | ${pct(colB.candidateWinRate)} | ${ci(colB)} | ${pct(colB.drawRate)} | ${colB.blocks} |
| C | Opus봇 vs 루프포지봇 | ${pct(colC.candidateWinRate)} | ${ci(colC)} | ${pct(colC.drawRate)} | ${colC.blocks} |

채택 전략 수: ${adoptedLabel}

## 해석 주의

- 승률은 게임 간 비교 불가(게임마다 \`baselines.heuristic\` 강함이 다름). 윙스팬 내부에서 A·B·C 3개를 함께 보는 것이 실험 단위.
- \`draw/split\`은 candidateWinFraction===0.5인 블록 비율 — 순수 무승부와 "한 좌석 승·한 좌석 패"(미러링 분할)를 모두 포함한다. 순수 무승부율이 아니다.
- 좌석 미러링으로 선공 이점은 상쇄됨.
- 게이트(SPRT/holdout)를 거치지 않은 순수 집계값(관찰 보고용).
- 이 파일(v2)은 registry v2와 새 시드를 반영해 \`benchmark-3col.json/md\`(v1, 저장된 적 없음)와 직접 비교 불가.

총 소요: ${totalSeconds.toFixed(1)}s
`;
}

main();
