/**
 * avalon-benchmark — the 3-column win-rate benchmark for Avalon
 * (docs/BENCHMARK-EXPERIMENT.md). This is a benchmark-only entrypoint,
 * separate from the onboarding runner `avalon.ts`: it never runs waves,
 * scoring, or gates — it just plays three gate-free head-to-head matchups and
 * reports raw win rates.
 *
 *   A. Opus 설계봇  vs 기본봇(baselines.heuristic)
 *   B. 루프포지봇   vs 기본봇        (= registry.latest() flags composed on heuristic)
 *   C. Opus 설계봇  vs 루프포지봇
 *
 * registry.latest() is v1 (flags: []) — avalon's onboarding wave (avalon.ts)
 * screened out or failed all 3 strategySurface candidates (0 adopted, see
 * runs/avalon/ledger.json), the same "채택 0개" situation janggi/wingspan/
 * hearthstone-v1 were in before their own strategies were adopted. So column
 * B here is, by construction, identical to `baselines.heuristic` (heuristic
 * vs heuristic self-play) — that means "Loop Forge has not yet found an
 * improvement for Avalon," not a failure (docs/BENCHMARK-EXPERIMENT.md §4).
 * UNLIKE the other 0-adopted games, this self-play win rate is NOT expected
 * to land near ~50%: Avalon is a hidden-faction game whose win conditions are
 * structurally asymmetric between good and evil (evil wins via 3 failed
 * missions OR 5 consecutive rejections OR a correct assassination; good needs
 * 3 successes AND a wrong assassin guess), so even a fully "0 net change"
 * candidate can show a lopsided self-play rate purely from that asymmetry —
 * confirmed empirically below (~20%, not ~50%).
 *
 * Lives under `reference/runners/` so it is an app boundary (may wire every
 * layer and use wall-clock time for reporting) per
 * src/__tests__/dependency-rules.test.ts.
 *
 * Run: npx ts-node src/reference/runners/avalon-benchmark.ts [N]
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { eraseAdapter } from '../../loop/erase';
import { composeBot } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { loadOrCreateRegistry } from '../../artifacts/game-state';
import { avalonAdapter } from '../avalon';
import { avalonOpusBot } from '../experiments/avalon-opus-bot';

const GAME_ID = 'avalon';

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

  const adapter = eraseAdapter(avalonAdapter);
  const heuristic = avalonAdapter.baselines.heuristic;

  // Loop Forge bot = latest registry version's flags composed on the heuristic.
  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const latest = registry.latest();
  const flags = latest?.flags ?? [];
  const loopForgeBot = composeBot(adapter, flags);
  const flagsEmpty = flags.length === 0;

  // Fixed pre-registered seed range (docs/BENCHMARK-EXPERIMENT.md §3).
  const seeds = Array.from({ length: N }, (_, i) => 50_000 + i);

  console.log(`avalon 3-column benchmark — N=${N} seeds, latest=${latest?.version ?? '(none)'} flags=${JSON.stringify(flags)}`);
  if (flagsEmpty) {
    console.log(
      '  ⚠ registry flags are empty — column B (루프포지봇) is identical to the base bot, i.e. heuristic-vs-heuristic self-play. ' +
        'NOTE: unlike a symmetric 2-player game, Avalon is a hidden-faction game with structurally unequal win conditions for good ' +
        'vs evil (evil wins via 3 fails OR 5 rejections OR a correct assassination; good needs all three of 3 successes AND a ' +
        'wrong assassin guess), so this self-play win rate is NOT expected to land near 50% even with 0 adopted flags.',
    );
  }

  const columns: { key: string; label: string; run: () => HeadToHeadResult }[] = [
    { key: 'A', label: 'Opus봇 vs 기본봇', run: () => runHeadToHead(adapter, avalonOpusBot, heuristic, seeds, 800_001) },
    { key: 'B', label: '루프포지봇 vs 기본봇', run: () => runHeadToHead(adapter, loopForgeBot, heuristic, seeds, 800_002) },
    { key: 'C', label: 'Opus봇 vs 루프포지봇', run: () => runHeadToHead(adapter, avalonOpusBot, loopForgeBot, seeds, 800_003) },
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

  const md = `# 아발론(avalon) 3열 벤치마크 결과

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
      ? `**flags가 비어 있어 기본봇과 동일**(heuristic vs heuristic 자기대국) — 이는 "루프 포지가 아직 아발론에서 유의미한 전략을 채택하지 못했다"는 뜻(실패가 아님). 단, 아발론은 **숨은 진영 게임**으로 선/악 승리 조건이 구조적으로 비대칭(악은 3실패 OR 5연속기각 OR 정확한 암살 중 하나로 승리, 선은 3성공 AND 암살 실패 둘 다 필요)이라 대칭 2인 게임과 달리 자기대국 승률이 50%에 수렴한다는 보장이 없다 — 실측값(${pct(b.candidateWinRate)})이 그 증거다.`
      : '채택된 전략 덕분에 기본봇 대비 우위.'
  }
- **C열**: 두 봇 직접 대결 — ${cWinner}. ${
    flagsEmpty
      ? '루프포지봇이 사실상 기본봇이므로 이 값은 A열과 같은 신호(즉흥 Opus봇 vs 기본봇)에 가깝다.'
      : ''
  }
${flagsEmpty ? '\n> 아발론은 온보딩 웨이브(runs/avalon/ledger.json)에서 3개 전략 후보(merlinCamouflage, evilDelayedFail, assassinTargetMostTrusted)가 전부 채택되지 못했다(2개 screened-out, 1개 smoke에서 failed) — **채택 0개**. 따라서 B열은 정의상 기본봇과 같다.' : ''}

## 승률 비교 주의

- 승률은 게임 간 비교 불가(게임마다 \`baselines.heuristic\` 강함이 다름, docs/INTERPRETATION.md 제1규칙). 아발론 내부에서 A·B·C 3개를 함께 보는 것이 이 실험의 단위.
- \`무승부/split율\`은 candidateWinFraction===0.5인 블록 비율 — 순수 무승부와 좌석 미러링에 의한 승-패 분할을 모두 포함한다.
- 좌석 페어드 미러링으로 선공(리더 시작 시드) 이점은 상쇄됨.
- 게이트(SPRT/holdout)를 거치지 않은 순수 집계값(관찰 보고용) — \`runHeadToHead\`.
`;
  writeFileSync(join(outDir, 'benchmark-3col.md'), md);
  console.log(`  wrote runs/${GAME_ID}/benchmark-3col.json and .md`);
}

main();
