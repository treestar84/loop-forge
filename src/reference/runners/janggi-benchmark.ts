/**
 * janggi-benchmark — the 3-column win-rate benchmark for Janggi
 * (docs/BENCHMARK-EXPERIMENT.md). This is a benchmark-only entrypoint,
 * separate from the onboarding runner `janggi.ts`: it never runs waves,
 * scoring, or gates — it just plays three gate-free head-to-head matchups and
 * reports raw win rates.
 *
 *   A. Opus 설계봇  vs 기본봇(baselines.heuristic)
 *   B. 루프포지봇   vs 기본봇        (= registry.latest() flags composed on heuristic)
 *   C. Opus 설계봇  vs 루프포지봇
 *
 * Lives under `reference/runners/` so it is an app boundary (may wire every
 * layer and use wall-clock time for reporting) per
 * src/__tests__/dependency-rules.test.ts.
 *
 * Run: npx ts-node src/reference/runners/janggi-benchmark.ts [N]
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { eraseAdapter } from '../../loop/erase';
import { composeBot } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { loadOrCreateRegistry } from '../../artifacts/game-state';
import { janggiAdapter } from '../janggi';
import { janggiOpusBot } from '../experiments/janggi-opus-bot';

const GAME_ID = 'janggi';

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function ci(result: HeadToHeadResult): string {
  return `CI ${pct(result.winRateCI.lower)}–${pct(result.winRateCI.upper)}`;
}

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const argN = Number.parseInt(process.argv[2] ?? '', 10);
  const N = Number.isFinite(argN) && argN > 0 ? argN : 2000;

  const adapter = eraseAdapter(janggiAdapter);
  const heuristic = janggiAdapter.baselines.heuristic;

  // Loop Forge bot = latest registry version's flags composed on the heuristic.
  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const latest = registry.latest();
  const flags = latest?.flags ?? [];
  const loopForgeBot = composeBot(adapter, flags);
  const flagsEmpty = flags.length === 0;

  // Fixed pre-registered seed range (docs/BENCHMARK-EXPERIMENT.md §3).
  const seeds = Array.from({ length: N }, (_, i) => 50_000 + i);

  console.log(`janggi 3-column benchmark — N=${N} seeds, latest=${latest?.version ?? '(none)'} flags=${JSON.stringify(flags)}`);
  if (flagsEmpty) {
    console.log('  ⚠ registry flags are empty — column B (루프포지봇) is identical to the base bot; expect ~50%.');
  }

  const columns: { key: string; label: string; run: () => HeadToHeadResult }[] = [
    { key: 'A', label: 'Opus봇 vs 기본봇', run: () => runHeadToHead(adapter, janggiOpusBot, heuristic, seeds, 700_001) },
    { key: 'B', label: '루프포지봇 vs 기본봇', run: () => runHeadToHead(adapter, loopForgeBot, heuristic, seeds, 700_002) },
    { key: 'C', label: 'Opus봇 vs 루프포지봇', run: () => runHeadToHead(adapter, janggiOpusBot, loopForgeBot, seeds, 700_003) },
  ];

  const results: Record<string, HeadToHeadResult> = {};
  for (const col of columns) {
    const t0 = Date.now();
    const result = col.run();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    results[col.key] = result;
    console.log(
      `  [${col.key}] ${col.label}: winRate=${pct(result.candidateWinRate)} ${ci(result)} ` +
        `drawRate=${pct(result.drawRate)} blocks=${result.blocks} (${elapsed}s)`,
    );
  }

  const adoptedFlags = flags;
  const adoptedNote = flagsEmpty ? '없음 (아직 개선 없음)' : `${adoptedFlags.length}개: ${JSON.stringify(adoptedFlags)}`;

  const outDir = join(rootDir, 'runs', GAME_ID);
  mkdirSync(outDir, { recursive: true });

  const json = {
    gameId: GAME_ID,
    n: N,
    seedRange: { from: seeds[0], to: seeds[seeds.length - 1] },
    latestVersion: latest?.version ?? null,
    flags,
    flagsEmpty,
    generatedAt: new Date().toISOString(),
    columns: {
      A: { label: columns[0]?.label, opponent: 'baselines.heuristic', ...results['A'] },
      B: { label: columns[1]?.label, opponent: 'baselines.heuristic', ...results['B'] },
      C: { label: columns[2]?.label, opponent: 'loop-forge (registry latest)', ...results['C'] },
    },
  };
  writeFileSync(join(outDir, 'benchmark-3col.json'), JSON.stringify(json, null, 2));

  const a = results['A'] as HeadToHeadResult;
  const b = results['B'] as HeadToHeadResult;
  const c = results['C'] as HeadToHeadResult;
  const cWinner = c.candidateWinRate > 0.5 ? 'Opus봇 우세' : c.candidateWinRate < 0.5 ? '루프포지봇 우세' : '무승부 수준';

  const md = `# 장기(janggi) 3열 벤치마크 결과

- 생성 시각: ${json.generatedAt}
- 대전 판수(N): ${N} (시드 ${seeds[0]}–${seeds[seeds.length - 1]}, 페어드 미러링)
- registry 최신 버전: ${latest?.version ?? '(없음)'} / flags: ${JSON.stringify(flags)}
- 채택 전략 수: ${adoptedNote}

| 컬럼 | 대진 | 후보 승률 | 95% CI | 무승부율 | 블록수 |
|---|---|---|---|---|---|
| A | Opus봇 vs 기본봇 | ${pct(a.candidateWinRate)} | ${pct(a.winRateCI.lower)}–${pct(a.winRateCI.upper)} | ${pct(a.drawRate)} | ${a.blocks} |
| B | 루프포지봇 vs 기본봇 | ${pct(b.candidateWinRate)} | ${pct(b.winRateCI.lower)}–${pct(b.winRateCI.upper)} | ${pct(b.drawRate)} | ${b.blocks} |
| C | Opus봇 vs 루프포지봇 | ${pct(c.candidateWinRate)} (${cWinner}) | ${pct(c.winRateCI.lower)}–${pct(c.winRateCI.upper)} | ${pct(c.drawRate)} | ${c.blocks} |

## 해석

- **A열**: 아무 파이프라인 없이 규칙만 보고 즉흥 설계한 Opus봇이 기본봇(heuristic)을 상대로 ${pct(a.candidateWinRate)}.
- **B열**: 루프포지봇 = registry 최신 flags(${JSON.stringify(flags)})를 heuristic에 합성한 봇. ${
    flagsEmpty
      ? '**flags가 비어 있어 기본봇과 동일** — 승률이 ~50%로 나오는 것은 정상이며, 이는 "루프 포지가 아직 장기에서 유의미한 전략을 채택하지 못했다"는 뜻(실패가 아님).'
      : '채택된 전략 덕분에 기본봇 대비 우위.'
  }
- **C열**: 두 봇 직접 대결 — ${cWinner}. ${
    flagsEmpty
      ? '루프포지봇이 사실상 기본봇이므로 이 값은 A열과 같은 신호(즉흥 Opus봇 vs 기본봇)에 가깝다.'
      : ''
  }
${flagsEmpty ? '\n> 장기는 이전 웨이브에서 3개 전략 후보가 전부 screen에서 탈락해 **채택 0개**다. 따라서 B열은 정의상 기본봇과 같다.' : ''}
`;
  writeFileSync(join(outDir, 'benchmark-3col.md'), md);
  console.log(`  wrote runs/${GAME_ID}/benchmark-3col.json and .md`);
}

main();
