/**
 * gomoku-portfolio-round2 — GAP-11 Phase 4-B: the second live run of the
 * portfolio protocol (docs/GAP-ANALYSIS-11.md D5.5) for gomoku, following
 * gomoku-portfolio-round1.ts's precedent (see that file's own doc comment
 * for the 6-step shape this reuses verbatim: brief already written to
 * runs/gomoku/design-brief-round2.md by gomoku-design-brief-round2.ts before
 * this runner; here: candidate batch -> probe filter -> wave -> challenge ->
 * bookkeeping -> transcendence check).
 *
 * Candidate batch (6, ./shared/gomoku-round2-candidates.ts's own doc comment
 * has the full per-candidate design rationale — B3's 2 candidates implement
 * the main loop's own scratchpad b3-round2-design-spec.md verbatim, B1's 2
 * are mechanical derivations of B3, B2/B4 are this executing agent's own
 * designs per the team lead's placement instructions). **필수 제약**: every
 * candidate is a single self-contained MCTS-family flag (no flag lists) —
 * composeBot's "later MCTS flag ignores base entirely" rule means a
 * multi-flag registry entry silently collapses to its last flag (Phase 4-A's
 * central finding, reproduced in gomoku-round2-candidates.ts's own doc
 * comment), so this round never registers more than one flag per adopted
 * candidate.
 *
 * Probe filter: **round1 (runs/gomoku/probe-bank.json) + round2
 * (runs/gomoku/probe-bank-round2.json) probe banks loaded and scored
 * together** (team lead's instruction) — both files are left on disk
 * untouched, this runner only merges their in-memory `ProbePosition[]`
 * arrays (deduped by `probeId`, first occurrence wins) before calling
 * `scoreAgainstProbes` once per candidate over the combined set. Cost
 * check stays 5 games/candidate (round1's own convention) — this round's
 * batch skews toward defensive-family evaluators (all of B3x2/B1x2 wrap
 * `gomokuCombinedEvaluator`, which itself wraps `gomokuDefensiveEvaluator`),
 * and Phase 4-A's profiling (design-brief-round2.md "추가 증거" section)
 * found defensive-tier priors visit ~5.7x more distinct tree nodes per fixed
 * simulation budget than chain-tier priors (tied scores under a wide tier
 * band widen the search instead of narrowing it) — not a code defect, a
 * property of the tier design. This runner accounts for that by budgeting
 * wave-tier sizes below round1's own convention (see WAVE TIER SIZING below)
 * rather than by changing the probe-filter cost-check itself.
 *
 * WAVE TIER SIZING (team lead's resource rule: "웨이브 총예상 30분 초과 시
 * 티어 관행 하한 축소 후 기록"): round1's convention was smoke<=30/prune=15/
 * holdout=15/regression=40 (gomoku-portfolio-round1.ts). With 4 of this
 * round's 6 candidates being combined-evaluator variants (defensive-cost
 * family) and only the top 4 (of 6) advancing past the probe filter, a
 * worst-case all-defensive-family wave at round1's tier sizes could exceed
 * the 30-minute ceiling (30+15+15+40=100 tier games/candidate x ~2-3s/game
 * defensive-family cost x up to 4 candidates, before even reaching the N=40
 * x2-anchor challenge). This runner reduces every tier below round1's floor
 * — smoke<=20/prune=10/holdout=10/regression=25 (35% fewer tier games per
 * candidate) — while leaving `screenProbe`, the SPRT shape, and the N=40
 * challenge size (team lead's explicit instruction: "challenge L1·L2(N=40,
 * 신규 시드)") untouched. Recorded here per the resource rule's own
 * "축소 후 기록" requirement, not silently.
 *
 * Fresh seed ranges (verified non-overlapping with every prior gomoku
 * runner's own documented range — grepped across every `N{2,3}_NNN` literal
 * in reference/runners/gomoku*.ts before picking these; round1 occupies
 * 520_000-525_039/988_101/988_301, loss-mining-round2 occupies
 * 400_000-401_099/976_101-976_302, anchor-ladder occupies
 * 981_101-981_102/984_101-984_102/990_000-991_099/996_000-997_019):
 *   - probe-filter cost check: 530_000-530_004 (N=5, shared block, same
 *     pattern as round1).
 *   - wave smoke/prune/holdout/regression: 531_000+/532_000+/533_000+/534_000+.
 *   - challenge (L1/L2): 535_000-535_039 (N=40).
 *   - transcendence L3 holdout (only if triggered): 536_000-536_099 (N=100).
 * Bot seed bases (independent space, also fresh): 989_101 (cost check),
 * 989_301 (challenge), 989_501 (transcendence L3). `PROBE_SCORE_BOT_SEED_BASE`
 * is the one exception — it must stay 975_201 (the same base
 * gomoku-loss-mining.ts/-prior-diagnostic.ts/-portfolio-round1.ts all use),
 * not a fresh value: probe-bank.ts's own self-consistency contract requires
 * scoring against the *same* anchor-seed derivation that produced each
 * probe's `anchorChoiceKey`, and both probe banks here were built from that
 * shared base.
 *
 * Transcendence check (team lead's instruction, GAP-11 Phase 4 "초월 판정"):
 * if any candidate's challenge winRateCI.lower > 0.5 against L2, that
 * candidate (its post-adoption composed bot, if adopted — functionally
 * identical to the candidate's own single flag either way, since a v7
 * registry entry that only appends one new MCTS flag still resolves to that
 * flag alone under composeBot's override rule) is measured head-to-head
 * against the L3 holdout anchor (`gomoku-positional-bot.ts`,
 * 'external-style2-l3') over N=100 fresh seeds via `runHeadToHead` — gate-
 * free, no LossReport/probe-bank generation from the result (holdout
 * guard). Recorded under `transcendence` in the summary JSON either way
 * (triggered-with-result, or not-triggered-and-why).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import type { AnyBotFactory, AnyGameAdapter } from '../../contract/types';
import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { scoreAgainstProbes, type ProbePosition, type ProbeScore } from '../../loop/probe-bank';
import { loadProbeBank } from '../../artifacts/trajectory-archive';
import { assembleWaveConfig } from '../../loop/assemble-wave-config';
import { runWave, type WaveChallengeEntry, type WaveReport } from '../../loop/wave-runner';
import { SeedLedger } from '../../kernel/seed-ledger';
import {
  loadOrCreateLedger,
  loadOrCreateRegistry,
  saveLedger,
  saveRegistry,
} from '../../artifacts/game-state';
import { extractNearMissCandidates, type AdoptionEntry } from '../../artifacts/adoption-ledger';
import {
  BUCKET_ORDER,
  INITIAL_ALLOCATION,
  loadPortfolioState,
  reallocate,
  savePortfolioState,
  type BucketId,
  type BucketOutcome,
} from '../../artifacts/portfolio';
import { gomokuAdapter } from '../gomoku';
import { gomokuOpusBot } from '../experiments/gomoku-opus-bot';
import { gomokuMidBot } from '../experiments/gomoku-mid-bot';
import { gomokuPositionalBot } from '../experiments/gomoku-positional-bot';
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
} from './shared/gomoku-mcts-flag';
import { buildCandidates as buildRound1Candidates } from './shared/gomoku-round1-candidates';
import { buildRound2Candidates, type RoundCandidate } from './shared/gomoku-round2-candidates';

const GAME_ID = 'gomoku';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const PROBE_SCORE_BOT_SEED_BASE = 975_201; // must match the base every gomoku probe bank was built with (file doc comment).
const COST_CHECK_SEED_BASE = 530_000;
const COST_CHECK_N = 5;
const COST_CHECK_BOT_SEED_BASE = 989_101;

const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_TRIGGER_THRESHOLD = 0.5;
const TRANSCENDENCE_N = 100;
const TRANSCENDENCE_SEED_BASE = 536_000;
const TRANSCENDENCE_BOT_SEED_BASE = 989_501;

function now(): string {
  return new Date().toISOString();
}

function seeds(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------
// Probe bank merge (round1 + round2, deduped by probeId — file doc comment)
// ---------------------------------------------------------------------

function mergeProbeBanks(
  banks: readonly (readonly ProbePosition[])[],
): readonly ProbePosition[] {
  const seen = new Map<string, ProbePosition>();
  for (const bank of banks) {
    for (const probe of bank) {
      if (!seen.has(probe.probeId)) {
        seen.set(probe.probeId, probe);
      }
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------
// Probe filter
// ---------------------------------------------------------------------

interface ProbeFilterRow {
  readonly flag: string;
  readonly bucket: BucketId;
  readonly probeScore: ProbeScore;
  readonly msPerGame: number;
  readonly advanced: boolean;
}

function runProbeFilter(
  adapter: AnyGameAdapter,
  candidates: readonly RoundCandidate[],
  probes: readonly ProbePosition[],
): readonly ProbeFilterRow[] {
  const costSeeds = seeds(COST_CHECK_SEED_BASE, COST_CHECK_N);
  const rows: Array<Omit<ProbeFilterRow, 'advanced'>> = [];

  for (const candidate of candidates) {
    const bot = composeBot(adapter, [candidate.flag]);
    const probeScore = scoreAgainstProbes(adapter, bot, probes, PROBE_SCORE_BOT_SEED_BASE);

    const t0 = Date.now();
    const costResult = runHeadToHead(adapter, bot, gomokuOpusBot, costSeeds, COST_CHECK_BOT_SEED_BASE);
    const elapsedMs = Date.now() - t0;
    const msPerGame = costResult.blocks > 0 ? elapsedMs / costResult.blocks : Infinity;

    console.log(
      `  [probe-filter] ${candidate.flag} (${candidate.bucket}): agreement=${pct(probeScore.agreementRate)} ` +
        `(${probeScore.agreements}/${probeScore.probes - probeScore.skipped}, skipped=${probeScore.skipped}) ms/game=${msPerGame.toFixed(0)}`,
    );
    rows.push({ flag: candidate.flag, bucket: candidate.bucket, probeScore, msPerGame });
  }

  const ranked = [...rows].sort((a, b) => {
    if (b.probeScore.agreementRate !== a.probeScore.agreementRate) {
      return b.probeScore.agreementRate - a.probeScore.agreementRate;
    }
    return a.msPerGame - b.msPerGame; // tie-break: cheaper wins
  });
  const advancingFlags = new Set(ranked.slice(0, 4).map((row) => row.flag));

  return rows.map((row) => ({ ...row, advanced: advancingFlags.has(row.flag) }));
}

// ---------------------------------------------------------------------
// Transcendence check (file doc comment)
// ---------------------------------------------------------------------

interface TranscendenceEntry {
  readonly flag: string;
  readonly triggeredBy: { readonly l2WinRate: number; readonly l2WinRateCILower: number };
  readonly wasAdopted: boolean;
  readonly l3: HeadToHeadResult;
}

function main(): void {
  console.log(`=== gomoku portfolio round 2 (GAP-11 Phase 4-B) — rootDir=${ROOT_DIR} ===`);

  const bareAdapter = eraseAdapter(gomokuAdapter);

  console.log('1) 후보 배치 생성 (B3x2, B1x2, B2x1, B4x1 = 6)');
  const candidates = buildRound2Candidates(bareAdapter);
  for (const candidate of candidates) {
    console.log(`   ${candidate.bucket}: ${candidate.flag}`);
  }

  // The adapter must resolve every flag registry v6 (this round's baseline)
  // names, not just this round's own 6 candidates — composeBot(adapter,
  // latest.flags) is called deep inside runWave for the regression tier, and
  // v6 = [...static flags already in bareAdapter's own strategySurface,
  // 6 pre-existing dynamic MCTS flags, 4 round1-promoted dynamic flags]. Same
  // reconstruction gomoku-loss-mining-round2.ts's own doc comment documents
  // (its "extend the bare adapter with every dynamic flag registry v6 can
  // name" note) — reused verbatim here rather than re-derived by hand.
  const round1Candidates = buildRound1Candidates(bareAdapter);
  const adapter = withStrategyFlags(bareAdapter, [
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_CONFIG, GOMOKU_MCTS_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_HR_CONFIG, GOMOKU_MCTS_HR_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_CONFIG, GOMOKU_MCTS2_S256_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_HR_CONFIG, GOMOKU_MCTS2_S256_HR_FLAG),
    gomokuMcts2S256CrFlagSpec(bareAdapter),
    gomokuMcts2S512CrFlagSpec(bareAdapter),
    ...round1Candidates.map((candidate) => candidate.spec),
    ...candidates.map((candidate) => candidate.spec),
  ]);

  console.log('2) 프로브 필터 (round1+round2 프로브 은행 합산 채점, 판당 비용 실측 각 5판, 상위 4개 진출)');
  const probeBankRound1Path = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank.json');
  const probeBankRound2Path = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round2.json');
  const probesRound1 = loadProbeBank(probeBankRound1Path);
  const probesRound2 = loadProbeBank(probeBankRound2Path);
  const mergedProbes = mergeProbeBanks([probesRound1, probesRound2]);
  console.log(
    `   프로브 은행: round1=${probesRound1.length}, round2=${probesRound2.length}, 합산(중복 제거 후)=${mergedProbes.length}`,
  );
  const probeFilterRows = runProbeFilter(adapter, candidates, mergedProbes);
  const advancing = probeFilterRows.filter((row) => row.advanced);
  console.log(`   진출: ${advancing.map((row) => row.flag).join(', ')}`);

  console.log('3) 정규 웨이브 (신규 시드 뱅크, 티어 크기 축소 — 파일 doc comment 참고)');
  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const ledgerStore = loadOrCreateLedger(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined) {
    throw new Error('gomoku-portfolio-round2: registry has no latest baseline — run reference/runners/gomoku.ts first');
  }
  console.log(`   baseline=${latest.version} (regression 상대), flags=[${latest.flags.join(', ')}]`);

  const waveLedger = new SeedLedger();
  const reservedAt = now();
  const SMOKE_MAX = 20; // round1: 30 (축소 근거: 파일 doc comment 'WAVE TIER SIZING')
  const PRUNE_BLOCKS = 10; // round1: 15
  const HOLDOUT_BLOCKS = 10; // round1: 15
  const REGRESSION_BLOCKS = 25; // round1: 40
  waveLedger.reserve({ bankId: 'gomoku-portfolio2-smoke', range: { start: 531_000, end: 531_000 + SMOKE_MAX - 1 }, purpose: 'smoke', reservedAt });
  waveLedger.reserve({ bankId: 'gomoku-portfolio2-prune', range: { start: 532_000, end: 532_000 + PRUNE_BLOCKS - 1 }, purpose: 'prune', reservedAt });
  waveLedger.reserve({ bankId: 'gomoku-portfolio2-holdout', range: { start: 533_000, end: 533_000 + HOLDOUT_BLOCKS - 1 }, purpose: 'holdout', reservedAt });
  waveLedger.reserve({ bankId: 'gomoku-portfolio2-regression', range: { start: 534_000, end: 534_000 + REGRESSION_BLOCKS - 1 }, purpose: 'regression', reservedAt });

  const CHALLENGE_N = 40;
  const CHALLENGE_SEED_BASE = 535_000;
  const CHALLENGE_BOT_SEED_BASE = 989_301;
  const challengeEntries: readonly WaveChallengeEntry[] = [
    { anchorId: 'external-mid-l1', factory: gomokuMidBot as AnyBotFactory, role: 'feedback' },
    { anchorId: L2_ANCHOR_ID, factory: gomokuOpusBot as AnyBotFactory, role: 'feedback' },
  ];

  const waveConfig = {
    ...assembleWaveConfig(adapter, {
      waveId: 'portfolio-round2',
      candidates: advancing.map((row) => ({ flag: row.flag })),
      opponent: 'heuristic',
      ledger: waveLedger,
      recordedAt: now(),
      baselineFlags: latest.flags,
      baselineVersion: latest.version,
      tiers: {
        smoke: { bankId: 'gomoku-portfolio2-smoke', sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 }, maxBlocks: SMOKE_MAX, minBlocks: 5 },
        prune: { bankId: 'gomoku-portfolio2-prune', blocks: PRUNE_BLOCKS },
        holdout: { bankId: 'gomoku-portfolio2-holdout', blocks: HOLDOUT_BLOCKS },
        regression: { bankId: 'gomoku-portfolio2-regression', blocks: REGRESSION_BLOCKS },
      },
      screenProbe: { seeds: [1, 2, 3], botSeedBase: 100 },
    }),
    challenge: {
      entries: challengeEntries,
      seeds: seeds(CHALLENGE_SEED_BASE, CHALLENGE_N),
      botSeedBase: CHALLENGE_BOT_SEED_BASE,
    },
  };

  const report: WaveReport = runWave(adapter, waveConfig);
  for (const result of report.results) {
    console.log(`   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`);
  }

  console.log('4) challenge 결과');
  const challengeTable: Record<string, Record<string, { winRate: number; blocks: number; winRateCI: { lower: number; upper: number } }>> = {};
  for (const entry of report.challengeResult ?? []) {
    challengeTable[entry.anchorId] ??= {};
    (challengeTable[entry.anchorId] as Record<string, { winRate: number; blocks: number; winRateCI: { lower: number; upper: number } }>)[
      entry.subject
    ] = { winRate: entry.winRate, blocks: entry.blocks, winRateCI: entry.winRateCI };
    console.log(
      `   ${entry.anchorId} vs ${entry.subject}: winRate=${pct(entry.winRate)} CI=[${pct(entry.winRateCI.lower)}, ${pct(entry.winRateCI.upper)}] blocks=${entry.blocks}`,
    );
  }

  console.log('5) adoption ledger 기록');
  const entries: AdoptionEntry[] = report.results.map((result) => {
    const tierStats: AdoptionEntry['tierStats'] = {};
    for (const tier of ['screen', 'smoke', 'prune', 'holdout', 'regression'] as const) {
      const stats = result.stats[tier];
      if (stats) {
        tierStats[tier] = {
          pointWinRate: stats.pointWinRate,
          pointScoreDiff: stats.pointScoreDiff,
          blocks: stats.blocks,
          ...(stats.drawRate !== undefined ? { drawRate: stats.drawRate } : {}),
          ...(stats.winRateCI !== undefined ? { winRateCI: stats.winRateCI } : {}),
        };
      }
    }
    const isNoOp = result.tiersPassed.length === 0 && result.stats.smoke === undefined;
    return {
      flags: result.flags,
      verdict: isNoOp ? 'screened-out' : result.verdict,
      tierStats,
      ...(isNoOp ? { failureReason: 'behavioral no-op (screened out before any games)' } : {}),
    };
  });
  const adoptionRecord = ledgerStore.add({
    waveId: report.waveId,
    recordedAt: now(),
    comparabilityKey: report.comparabilityKey,
    baselineVersion: latest.version,
    opponentId: waveConfig.opponent,
    entries,
    nextLoopNotes: [],
  });

  const nearMiss = extractNearMissCandidates(adoptionRecord, waveConfig.criteria);
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'near-miss-round2.json'), JSON.stringify(nearMiss, null, 2));

  console.log('6) registry 승격 (채택 있으면)');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  let promotedVersion: string | null = null;
  let promotedFlags: readonly string[] = latest.flags;
  if (adoptedFlags.length > 0) {
    const lineage = registry.lineage(latest.version);
    const nextVersion = registry.register({
      version: `v${lineage.length + 1}`,
      flags: [...latest.flags, ...adoptedFlags],
      parent: latest.version,
      createdAt: now(),
      sourceWaveId: report.waveId,
      notes: `portfolio-round2에서 채택된 플래그 승격: ${adoptedFlags.join(', ')}`,
    });
    promotedVersion = nextVersion.version;
    promotedFlags = nextVersion.flags;
    console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
  } else {
    console.log('   채택된 후보 없음 — 승격 없음');
  }
  saveRegistry(ROOT_DIR, GAME_ID, registry);
  saveLedger(ROOT_DIR, GAME_ID, ledgerStore);

  console.log('7) 버킷 수율 계산 + 재배분 (round1 portfolio-state.json 로드 후 갱신)');
  const baselineL2WinRate = challengeTable[L2_ANCHOR_ID]?.['baseline']?.winRate ?? 0;
  const verdictByFlag = new Map(report.results.map((result) => [result.flag, result.verdict]));

  const bucketOutcomes: BucketOutcome[] = BUCKET_ORDER.map((bucket) => {
    const bucketCandidates = candidates.filter((candidate) => candidate.bucket === bucket);
    const bucketAdvancing = bucketCandidates.filter((candidate) =>
      advancing.some((row) => row.flag === candidate.flag),
    );
    const adopted = bucketAdvancing.filter((candidate) => verdictByFlag.get(candidate.flag) === 'adopted').length;

    const deltas = bucketAdvancing
      .map((candidate) => challengeTable[L2_ANCHOR_ID]?.[candidate.flag]?.winRate)
      .filter((winRate): winRate is number => winRate !== undefined)
      .map((winRate) => winRate - baselineL2WinRate);
    const challengeDelta = deltas.length > 0 ? deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length : 0;

    return { bucket, candidates: bucketCandidates.length, adopted, challengeDelta };
  });
  for (const outcome of bucketOutcomes) {
    console.log(
      `   ${outcome.bucket}: candidates=${outcome.candidates} adopted=${outcome.adopted} challengeDelta=${outcome.challengeDelta.toFixed(4)}`,
    );
  }

  const currentAllocation = loadPortfolioState(ROOT_DIR, GAME_ID) ?? INITIAL_ALLOCATION;
  const nextAllocation = reallocate(currentAllocation, bucketOutcomes);
  savePortfolioState(ROOT_DIR, GAME_ID, nextAllocation);
  console.log('   재배분 결과:');
  for (const entry of nextAllocation) {
    console.log(`     ${entry.bucket}: ${(entry.share * 100).toFixed(1)}%`);
  }

  console.log('8) 초월 판정 트리거 검사 (vs L2 winRateCI.lower > 0.5)');
  const transcendenceEntries: TranscendenceEntry[] = [];
  for (const entry of report.challengeResult ?? []) {
    if (entry.anchorId !== L2_ANCHOR_ID || entry.subject === 'baseline') {
      continue;
    }
    if (entry.winRateCI.lower > TRANSCENDENCE_TRIGGER_THRESHOLD) {
      const flag = entry.subject;
      const wasAdopted = adoptedFlags.includes(flag);
      console.log(`   트리거됨: ${flag} (winRateCI.lower=${pct(entry.winRateCI.lower)}) — L3 홀드아웃 판정 실행`);
      const l3Bot = wasAdopted ? composeBot(adapter, promotedFlags) : composeBot(adapter, [flag]);
      const l3Result = runHeadToHead(
        adapter,
        l3Bot,
        gomokuPositionalBot,
        seeds(TRANSCENDENCE_SEED_BASE, TRANSCENDENCE_N),
        TRANSCENDENCE_BOT_SEED_BASE,
      );
      console.log(
        `   L3(${L3_ANCHOR_ID}) vs ${flag}: winRate=${pct(l3Result.candidateWinRate)} CI=[${pct(l3Result.winRateCI.lower)}, ${pct(l3Result.winRateCI.upper)}] blocks=${l3Result.blocks}`,
      );
      // 홀드아웃 가드: L3 결과에서 LossReport/probe-bank를 만들지 않는다 —
      // runHeadToHead는 trajectoryCollector 없이 호출했으므로 애초에 궤적이
      // 수집되지 않는다(mineLosses/buildProbeBank를 호출할 재료 자체가 없음).
      transcendenceEntries.push({
        flag,
        triggeredBy: { l2WinRate: entry.winRate, l2WinRateCILower: entry.winRateCI.lower },
        wasAdopted,
        l3: l3Result,
      });
    }
  }
  if (transcendenceEntries.length === 0) {
    console.log('   트리거 미달 — L3 홀드아웃 판정 미실행');
  }

  console.log('9) runs/gomoku/portfolio-round2.json 저장');
  const summary = {
    gameId: GAME_ID,
    generatedAt: now(),
    probeBankSources: {
      round1: { path: `runs/${GAME_ID}/probe-bank.json`, probes: probesRound1.length },
      round2: { path: `runs/${GAME_ID}/probe-bank-round2.json`, probes: probesRound2.length },
      merged: mergedProbes.length,
    },
    probeFilter: probeFilterRows.map((row) => ({
      flag: row.flag,
      bucket: row.bucket,
      agreementRate: row.probeScore.agreementRate,
      probesScored: row.probeScore.probes - row.probeScore.skipped,
      probesSkipped: row.probeScore.skipped,
      msPerGame: row.msPerGame,
      advanced: row.advanced,
    })),
    waveTierSizing: {
      convention: { smoke: 30, prune: 15, holdout: 15, regression: 40 },
      usedThisRound: { smoke: SMOKE_MAX, prune: PRUNE_BLOCKS, holdout: HOLDOUT_BLOCKS, regression: REGRESSION_BLOCKS },
      reason:
        '이 라운드 후보 6개 중 4개(B3x2, B1x2)가 defensive-family(combined evaluator) — Phase 4-A 프로파일링상 ' +
        '동일 예산에서 노드 방문 수 약 5.7배로 관행 크기 그대로면 30분 예상치를 넘길 위험이 있어 사전 축소(파일 doc comment 참고).',
    },
    wave: {
      waveId: report.waveId,
      comparabilityKey: report.comparabilityKey,
      results: report.results.map((result) => ({
        flag: result.flag,
        verdict: result.verdict,
        tiersPassed: result.tiersPassed,
      })),
    },
    challenge: challengeTable,
    adoption: { promotedVersion, adoptedFlags },
    bucketOutcomes,
    portfolioAllocation: { previous: currentAllocation, next: nextAllocation },
    transcendence:
      transcendenceEntries.length > 0
        ? {
            triggered: true,
            threshold: TRANSCENDENCE_TRIGGER_THRESHOLD,
            entries: transcendenceEntries.map((entry) => ({
              flag: entry.flag,
              wasAdopted: entry.wasAdopted,
              triggeredBy: entry.triggeredBy,
              l3AnchorId: L3_ANCHOR_ID,
              l3WinRate: entry.l3.candidateWinRate,
              l3WinRateCI: entry.l3.winRateCI,
              l3Blocks: entry.l3.blocks,
              n: TRANSCENDENCE_N,
              note: '홀드아웃 가드: LossReport/probe-bank 생성 없음 — 승률 숫자만 기록.',
            })),
          }
        : {
            triggered: false,
            threshold: TRANSCENDENCE_TRIGGER_THRESHOLD,
            reason: '어떤 후보도 challenge vs L2 winRateCI.lower > 0.5에 도달하지 못함 — L3 홀드아웃 미실행.',
          },
  };
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round2.json'), JSON.stringify(summary, null, 2));
  console.log(`   저장: runs/${GAME_ID}/portfolio-round2.json`);
}

main();
