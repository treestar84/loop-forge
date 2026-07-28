/**
 * catan-benchmark — the 3-column win-rate benchmark for Catan
 * (docs/BENCHMARK-EXPERIMENT.md). This is a benchmark-only entrypoint,
 * separate from the onboarding runner `catan.ts`: it never runs waves,
 * scoring, or gates — it just plays three gate-free head-to-head matchups and
 * reports raw win rates.
 *
 *   A. Opus 설계봇  vs 기본봇(baselines.heuristic)
 *   B. 루프포지봇   vs 기본봇        (= registry.latest() flags composed on heuristic)
 *   C. Opus 설계봇  vs 루프포지봇
 *
 * registry.latest() is v1 (flags: []) — catan's onboarding wave (catan.ts,
 * wave A "single-opponent field") screened out or failed all 3 strategySurface
 * candidates (cityUpgradePriority, roadExpansionPriority, eagerBankTrade) —
 * 채택 0개, confirmed via runs/catan/ledger.json before this benchmark was
 * written. Unlike avalon's ledger-only adoption (registry never promoted),
 * catan's own runner (reference/runners/catan.ts step 5.6) DOES promote
 * adopted flags into the registry when a wave finds any — so `registry.latest()`
 * is a safe, direct source of truth for column B here (no ledger workaround
 * needed). Column B is, by construction, identical to `baselines.heuristic`
 * (heuristic vs heuristic self-play) — that means "Loop Forge has not yet
 * found an improvement for Catan," not a failure (docs/BENCHMARK-EXPERIMENT.md §4).
 *
 * Avalon-backfill lesson (docs/BENCHMARK-LEADERBOARD.md 결과 5): do NOT assume
 * a 0-adopted game's self-play win rate lands near 50% just because it's a
 * "no strategic difference" matchup — check the actual math for the game's
 * player count and win condition instead of pattern-matching to the 2-player
 * case. For Catan (4-player, single winner, column B = heuristic vs itself)
 * the measured value is EXACTLY 25.0% with a zero-width CI (confirmed at
 * N=2000, docs/BENCHMARK-LEADERBOARD.md 결과 6) — and this is not a
 * coincidence needing investigation, it is mathematically forced:
 * `runPairedBlock` averages over every permutation in `seatingPlan`, which
 * rotates the candidate through each of the 4 physical seats exactly once
 * per game seed. When candidate and "opponent" are functionally identical
 * bots (0 adopted flags), the seed's board/dice determine a single physical
 * seat that wins regardless of which bot factory is plugged into it — so the
 * candidate is that winning seat in exactly 1 of the 4 rotations, every
 * single seed, with no sampling variance at all. This is the opposite lesson
 * from Avalon (there, asymmetric win conditions push self-play AWAY from the
 * naive 1/playerCount value; here, symmetric self-play with a unique winner
 * PROVES it lands exactly on 1/playerCount by construction of the paired-seat
 * averaging itself, independent of how strong or weak the heuristic is).
 *
 * Lives under `reference/runners/` so it is an app boundary (may wire every
 * layer and use wall-clock time for reporting) per
 * src/__tests__/dependency-rules.test.ts.
 *
 * Run: npx ts-node src/reference/runners/catan-benchmark.ts [N]
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { eraseAdapter } from '../../loop/erase';
import { composeBot } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { loadOrCreateRegistry } from '../../artifacts/game-state';
import { catanAdapter } from '../catan';
import { catanOpusBot } from '../experiments/catan-opus-bot';

const GAME_ID = 'catan';

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

  const adapter = eraseAdapter(catanAdapter);
  const heuristic = catanAdapter.baselines.heuristic;

  // Loop Forge bot = latest registry version's flags composed on the heuristic.
  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const latest = registry.latest();
  const flags = latest?.flags ?? [];
  const loopForgeBot = composeBot(adapter, flags);
  const flagsEmpty = flags.length === 0;

  // Fixed pre-registered seed range (docs/BENCHMARK-EXPERIMENT.md §3).
  const seeds = Array.from({ length: N }, (_, i) => 50_000 + i);

  console.log(`catan 3-column benchmark — N=${N} seeds, latest=${latest?.version ?? '(none)'} flags=${JSON.stringify(flags)}`);
  if (flagsEmpty) {
    console.log(
      '  ⚠ registry flags are empty — column B (루프포지봇) is identical to the base bot, i.e. heuristic-vs-heuristic self-play. ' +
        'For a 4-player, single-winner game this is expected to land EXACTLY on 1/playerCount (25.0%) with zero sampling ' +
        'variance — runPairedBlock rotates the candidate through every physical seat once per seed, and with identical bots ' +
        'the seed-determined winning seat is occupied by the candidate in exactly 1 of 4 rotations, always.',
    );
  }

  const columns: { key: string; label: string; run: () => HeadToHeadResult }[] = [
    { key: 'A', label: 'Opus봇 vs 기본봇', run: () => runHeadToHead(adapter, catanOpusBot, heuristic, seeds, 800_001) },
    { key: 'B', label: '루프포지봇 vs 기본봇', run: () => runHeadToHead(adapter, loopForgeBot, heuristic, seeds, 800_002) },
    { key: 'C', label: 'Opus봇 vs 루프포지봇', run: () => runHeadToHead(adapter, catanOpusBot, loopForgeBot, seeds, 800_003) },
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

  const adoptedNote = flagsEmpty ? '없음 (아직 개선 없음)' : `${flags.length}개: ${JSON.stringify(flags)}`;

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

  const md = `# 카탄(catan) 3열 벤치마크 결과

- 생성 시각: ${json.generatedAt}
- 대전 판수(N): ${N} (시드 ${seeds[0]}–${seeds[seeds.length - 1]}, 페어드 미러링)
- registry 최신 버전: ${latest?.version ?? '(없음)'} / flags: ${JSON.stringify(flags)}
- 채택 전략 수: ${adoptedNote}

| 컬럼 | 대진 | 후보 승률 | 95% CI | 무승부/split율 | 블록수 |
|---|---|---|---|---|---|
| A | Opus봇 vs 기본봇 | ${pct(a.candidateWinRate)} | ${pct(a.winRateCI.lower)}–${pct(a.winRateCI.upper)} | ${pct(a.drawRate)} | ${a.blocks} |
| B | 루프포지봇 vs 기본봇 | ${pct(b.candidateWinRate)} | ${pct(b.winRateCI.lower)}–${pct(b.winRateCI.upper)} | ${pct(b.drawRate)} | ${b.blocks} |
| C | Opus봇 vs 루프포지봇 | ${pct(c.candidateWinRate)} (${cWinner}) | ${pct(c.winRateCI.lower)}–${pct(c.winRateCI.upper)} | ${pct(c.drawRate)} | ${c.blocks} |

## 해석

- **A열**: 아무 파이프라인 없이 규칙·관찰 타입·합법수만 보고 즉흥 설계한 Opus봇이 기본봇(heuristic)을 상대로 ${pct(a.candidateWinRate)}.
- **B열**: 루프포지봇 = registry 최신 flags(${JSON.stringify(flags)})를 heuristic에 합성한 봇. ${
    flagsEmpty
      ? `**flags가 비어 있어 기본봇과 동일**(heuristic vs heuristic 자기대국) — 이는 "루프 포지가 아직 카탄에서 유의미한 전략을 채택하지 못했다"는 뜻(실패가 아님). 실측값 ${pct(b.candidateWinRate)}(CI ${pct(b.winRateCI.lower)}–${pct(b.winRateCI.upper)}, 폭 0)는 우연이 아니라 **수학적으로 강제된 값**이다 — \`runPairedBlock\`이 시드 하나당 좌석 순열 4개 전부를 평균내면서 후보를 4개 물리 좌석에 정확히 한 번씩 배치하는데, 후보와 "상대"가 동일한 봇이면 그 시드의 보드/주사위가 결정하는 "이기는 물리 좌석"을 후보가 4번의 순열 중 정확히 1번 차지하게 되어, 매 시드마다 예외 없이 1/4이 나온다(플레이어 수가 N이면 항상 정확히 1/N). 아발론 백필(docs/BENCHMARK-LEADERBOARD.md 결과 5)의 교훈과는 반대 방향 신호다 — 거긴 승리조건 비대칭이 자기대국 승률을 1/N에서 멀어지게 만들었지만, 여긴 단일 승자·대칭 자기대국이라는 조건 자체가 1/N에 정확히 고정시킨다.`
      : '채택된 전략 덕분에 기본봇 대비 우위.'
  }
- **C열**: 두 봇 직접 대결 — ${cWinner}. ${
    flagsEmpty
      ? '루프포지봇이 사실상 기본봇이므로 이 값은 A열과 같은 신호(즉흥 Opus봇 vs 기본봇)에 가깝다.'
      : ''
  }
${flagsEmpty ? '\n> 카탄은 온보딩 웨이브(runs/catan/ledger.json, wave A 단일상대 필드)에서 3개 전략 후보(cityUpgradePriority, roadExpansionPriority, eagerBankTrade)가 전부 채택되지 못했다 — **채택 0개**. 따라서 B열은 정의상 기본봇과 같다.' : ''}

## 승률 비교 주의

- 승률은 게임 간 비교 불가(게임마다 \`baselines.heuristic\` 강함이 다름, docs/INTERPRETATION.md 제1규칙). 카탄 내부에서 A·B·C 3개를 함께 보는 것이 이 실험의 단위.
- \`무승부/split율\`은 candidateWinFraction===0.5인 블록 비율 — 순수 무승부와 좌석 미러링에 의한 승-패 분할을 모두 포함한다.
- 좌석 페어드 미러링으로 선공(초기 배치 순서) 이점은 상쇄됨.
- 게이트(SPRT/holdout)를 거치지 않은 순수 집계값(관찰 보고용) — \`runHeadToHead\`.
- 카탄은 4인 게임이지만 이 벤치마크는 avalon-benchmark.ts와 동일하게 2봇 head-to-head 유틸(\`runHeadToHead\`)을 그대로 재사용한다 — 나머지 좌석은 \`runHeadToHead\`의 기본 필드 채움 규칙을 따른다(온보딩 러너의 M4 fieldMix 실험과는 별개의, 순수 2봇 비교 지표).
`;
  writeFileSync(join(outDir, 'benchmark-3col.md'), md);
  console.log(`  wrote runs/${GAME_ID}/benchmark-3col.json and .md`);
}

main();
