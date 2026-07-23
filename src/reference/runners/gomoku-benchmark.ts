/**
 * gomoku-benchmark — the 3-column win-rate benchmark of
 * docs/BENCHMARK-EXPERIMENT.md, run for gomoku. This is NOT an onboarding
 * runner (that is reference/runners/gomoku.ts, which scores conformance and
 * runs gated waves); it is a pure gate-free aggregation that compares three
 * bots head-to-head:
 *
 *   A. Opus 설계봇      vs 기본봇(baselines.heuristic)
 *   B. 루프포지봇        vs 기본봇(baselines.heuristic)
 *   C. Opus 설계봇      vs 루프포지봇
 *
 * "Opus 설계봇" = reference/experiments/gomoku-opus-bot.ts, a one-shot LLM
 * design that never touched the Loop Forge scoring/wave/gate pipeline.
 * "루프포지봇" = baselines.heuristic with the wave-adopted strategy flags
 * composed on top (loop/compose.ts).
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
import {
  loadOrCreateLedger,
  loadOrCreateRegistry,
} from '../../artifacts/game-state';
import { gomokuAdapter } from '../gomoku';
import { gomokuOpusBot } from '../experiments/gomoku-opus-bot';
import { gomokuMctsFlagSpec, GOMOKU_MCTS_FLAG } from './shared/gomoku-mcts-flag';

const GAME_ID = 'gomoku';
const ADOPTED_VERDICT = 'adopted';

/**
 * v3 follow-up (docs/GAP-ANALYSIS-7.md O6/O7): registry v3 promoted
 * `mcts-s64` on top of v2's hand-authored flags (runs/gomoku/registry.json).
 * `mcts-s64` lives on `gomoku.ts`'s runtime-extended adapter
 * (`withStrategyFlags`), not on `gomokuAdapter.strategySurface` itself, so
 * `composeBot` would throw "unknown strategy flag" if handed the bare
 * adapter and registry.latest().flags unchanged. Re-derive the identical
 * extension here (see shared/gomoku-mcts-flag.ts for why this must match
 * gomoku.ts's config exactly) so column B/C can compose whatever the
 * registry currently says, mcts-s64 included.
 */
const RUN_SUFFIX = '-v3';

/** Column seed count. Overridable via `--n=<count>` so the timing trial and
 * the full run share one entrypoint. Seeds are drawn from a fixed base so the
 * benchmark is fully reproducible. */
const DEFAULT_N = 2000;
const SEED_BASE = 50_000;

/** Distinct bot-seed bases per column so the three matchups never share a
 * derived bot-seed stream (cross-contamination guard, per task spec). */
const BOT_SEED_BASE = { A: 900_001, B: 900_002, C: 900_003 } as const;

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
 * the flags from the ledger's `adopted` entries (the actual pipeline output),
 * and report the registry-vs-ledger divergence in the output so the number is
 * never silently mistaken for a promoted baseline.
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

  // Prefer a promoted registry baseline when one exists; otherwise fall back to
  // the ledger's adopted flags so column B reflects what the pipeline validated.
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
  // Extend with mcts-s64 so composeBot can resolve it when the registry's
  // latest flags include it (v3) — additive only, harmless for versions
  // that don't reference the flag (v1/v2).
  const adapter = withStrategyFlags(bareAdapter, [gomokuMctsFlagSpec(bareAdapter)]);
  const specDigest = sha256Digest(canonicalJson(bareAdapter.spec));
  const seeds = buildSeeds(n);

  const opusBot = gomokuOpusBot;
  const baseline = gomokuAdapter.baselines.heuristic;
  const resolved = resolveLoopForgeFlags(rootDir);
  const loopForgeBot = composeBot(adapter, resolved.flags);
  const usesMcts = resolved.flags.includes(GOMOKU_MCTS_FLAG);

  console.log(`=== gomoku 3-column benchmark v3 (N=${n} seeds/column) ===`);
  console.log(`  registry latest: ${resolved.registryLatestVersion} flags=[${resolved.registryLatestFlags.join(', ') || '(none)'}]`);
  console.log(`  루프포지봇 composed flags: [${resolved.flags.join(', ') || '(none)'}]`);
  console.log(`  specDigest: ${specDigest}`);
  if (resolved.registryLatestFlags.length === 0 && resolved.flags.length > 0) {
    console.log('  NOTE: registry latest had no flags; using ledger-adopted flags for column B.');
  }
  if (usesMcts) {
    console.log(`  NOTE: 루프포지봇 flags include "${GOMOKU_MCTS_FLAG}" — per-game cost is much higher than the hand-authored flags (search rollout).`);
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
      'v3 run: gomokuAdapter.spec now declares `utility` (docs/GAP-ANALYSIS-7.md O1/O2), which changed specDigest — NOT directly comparable to the pre-v3 benchmark-3col.json/md (different comparability context, docs/INTERPRETATION.md rule 1).',
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
  return `# 오목(gomoku) — 3열 벤치마크 (v3)

생성: ${new Date().toISOString()}
N = ${n} 시드/열 · 좌석 페어드 미러링 · 게이트 없음(runHeadToHead)
specDigest = \`${specDigest}\`

> **v3 표기**: registry v3(mcts-s64 승격) 반영. gomoku spec에 \`utility\` 필드가
> 추가되며 specDigest가 바뀌었으므로(docs/GAP-ANALYSIS-7.md O1/O2), 이 결과는
> \`benchmark-3col.json/md\`(v2 이전, 구 문맥)와 직접 비교하지 않는다
> (docs/INTERPRETATION.md 제1규칙: 동일 comparabilityKey 문맥 안에서만 비교).

## 루프포지봇 구성

- 합성 플래그: ${resolved.flags.length > 0 ? resolved.flags.map((f) => `\`${f}\``).join(', ') : '(없음)'}
- 플래그 출처: **${flagSource}**
- registry 최신 버전: ${resolved.registryLatestVersion ?? '(없음)'} (flags=${resolved.registryLatestFlags.length > 0 ? resolved.registryLatestFlags.join(', ') : '없음'})
${
  resolved.registryLatestFlags.length === 0 && resolved.flags.length > 0
    ? '- ⚠ registry 최신(v1)에는 플래그가 승격돼 있지 않아, ledger에서 `adopted` 판정된 플래그를 사용함 (BENCHMARK-EXPERIMENT.md §2 B열 정의에 맞춤).\n'
    : ''
}${
  usesMcts
    ? '- ⚠ 합성 플래그에 `mcts-s64`(탐색 후보) 포함 — B/C열은 판당 비용이 hand-authored 플래그보다 훨씬 큼(UCT 롤아웃).\n'
    : ''
}
## 결과

| 열 | 매치업 | 승률 | 95% CI | draw/split | 블록수 |
|---|---|---|---|---|---|
| A | Opus봇 vs 기본봇 | ${pct(colA.candidateWinRate)} | ${ci(colA)} | ${pct(colA.drawRate)} | ${colA.blocks} |
| B | 루프포지봇 vs 기본봇 | ${pct(colB.candidateWinRate)} | ${ci(colB)} | ${pct(colB.drawRate)} | ${colB.blocks} |
| C | Opus봇 vs 루프포지봇 | ${pct(colC.candidateWinRate)} | ${ci(colC)} | ${pct(colC.drawRate)} | ${colC.blocks} |

채택 전략 수: ${resolved.flags.length}/4 (v3: blockImmediateThreat, centerProximity, extendLongestLine, mcts-s64)

## 해석 주의

- 승률은 게임 간 비교 불가(게임마다 \`baselines.heuristic\` 강함이 다름). 오목 내부에서 A·B·C 3개를 함께 보는 것이 실험 단위.
- \`draw/split\`은 candidateWinFraction===0.5인 블록 비율 — 순수 무승부와 "한 좌석 승·한 좌석 패"(미러링 분할)를 모두 포함한다. 순수 무승부율이 아니다.
- 좌석 미러링으로 선공 이점은 상쇄됨.
- 게이트(SPRT/holdout)를 거치지 않은 순수 집계값(관찰 보고용).
- 이 파일(v3)은 spec 변경으로 이전 \`benchmark-3col.json/md\`와 직접 비교 불가.

총 소요: ${totalSeconds.toFixed(1)}s
`;
}

main();
