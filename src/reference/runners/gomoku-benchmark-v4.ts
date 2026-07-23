/**
 * gomoku-benchmark-v4 — v4 follow-up to gomoku-benchmark.ts's 3-column
 * win-rate benchmark (docs/BENCHMARK-EXPERIMENT.md), run after mcts-wave-3
 * (docs/FIX-BACKLOG.md P5) promoted `mcts2-s256-hr` into registry v4. A
 * separate file rather than editing gomoku-benchmark.ts in place: that file's
 * `benchmark-3col-v3.json/md` output must not be overwritten (comparability
 * key differs — different specDigest/registry version, docs/INTERPRETATION.md
 * rule 1), so v4 gets its own entrypoint and its own output filenames.
 *
 * Column definitions unchanged from v3:
 *   A. Opus 설계봇      vs 기본봇(baselines.heuristic)
 *   B. 루프포지봇        vs 기본봇(baselines.heuristic)
 *   C. Opus 설계봇      vs 루프포지봇
 *
 * "루프포지봇" here composes registry v4's flags — which end with
 * `mcts2-s256-hr` (mcts2-s256-hr's apply() discards `base` just like every
 * other MCTS flag on this adapter, so composing it last means it alone
 * determines every decision the composed bot makes; the hand-authored flags
 * and mcts-s64 earlier in v4's flags array are present in the chain but have
 * no observable effect once mcts2-s256-hr is applied on top).
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
const RUN_SUFFIX = '-v4';

/**
 * N chosen from an empirical timing trial (this file run with `--n=20`,
 * nice -n 10, single process, output not checked in): A) 0.0s/20 blocks
 * (negligible — no MCTS on either side), B) 25.5s/20 blocks (~1.275s/block),
 * C) 11.9s/20 blocks (~0.595s/block) — column B/C cost is dominated by
 * mcts2-s256-hr's per-decision cost since it discards `base` and drives every
 * decision once composed onto the loop-forge bot. Combined B+C rate ≈
 * 1.87s/block. N=700 keeps the whole run inside the 30-minute (1,800s)
 * budget with headroom for the variance already observed in mcts-wave-3's
 * per-game timing (975ms-2,371ms across individual games there):
 *   B+C: 700 * 1.87s ≈ 1,309s (~21.8 min)
 *   + column A (negligible) ≈ 1,309s total, leaving ~8 min headroom under
 *   the 30-minute ceiling.
 * This does not overwrite runs/gomoku/benchmark-3col-v3.{json,md} — v3's
 * specDigest/registry version/N all differ, so v3 and v4 stay separate
 * comparability contexts (docs/INTERPRETATION.md rule 1).
 */
const DEFAULT_N = 700;
const SEED_BASE = 70_000;

/** Distinct bot-seed bases per column so the three matchups never share a
 * derived bot-seed stream (cross-contamination guard, per task spec). */
const BOT_SEED_BASE = { A: 900_101, B: 900_102, C: 900_103 } as const;

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
  // Extend with every MCTS flag spec ever defined (not just the one v4
  // happens to end with) so composeBot can resolve any flag registry.latest()
  // names, regardless of which wave introduced it — same reasoning as
  // reference/runners/gomoku.ts's allMctsFlagSpecs (docs/FIX-BACKLOG.md P5).
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

  console.log(`=== gomoku 3-column benchmark v4 (N=${n} seeds/column) ===`);
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
      `v4 run: registry v4 promoted mcts2-s256-hr (docs/FIX-BACKLOG.md P5) on top of v3 — NOT directly comparable to benchmark-3col-v3.json/md (different comparability context, docs/INTERPRETATION.md rule 1). N also differs from v3 (${n} vs 2000), chosen from an empirical per-game timing trial to stay inside the 30-minute wave budget with the larger MCTS search budget (256 vs 64 simulations).`,
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
  return `# 오목(gomoku) — 3열 벤치마크 (v4)

생성: ${new Date().toISOString()}
N = ${n} 시드/열 · 좌석 페어드 미러링 · 게이트 없음(runHeadToHead)
specDigest = \`${specDigest}\`

> **v4 표기**: registry v4(mcts2-s256-hr 승격, docs/FIX-BACKLOG.md P5) 반영.
> N=${n}로 v3(N=2,000)보다 작음 — s256이 s64보다 시뮬레이션 예산이 4배 커
> 판당 비용이 크게 늘어난 실측(mcts-wave-3 throughput표)에 맞춰 30분 예산
> 안에서 산정. 이 결과는 \`benchmark-3col-v3.json/md\`와 직접 비교하지 않는다
> (docs/INTERPRETATION.md 제1규칙: 동일 comparabilityKey 문맥 안에서만 비교,
> N도 다름).

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
- 이 파일(v4)은 registry 버전과 N이 달라 \`benchmark-3col-v3.json/md\`와 직접 비교 불가.

총 소요: ${totalSeconds.toFixed(1)}s
`;
}

main();
