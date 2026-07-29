/**
 * dominion-portfolio-round2 — GAP-11 Phase 4-C second half (team-lead
 * instruction, main-loop design spec: scratchpad/dominion-round2-design-
 * spec.md, implemented verbatim): the second live run of the portfolio
 * protocol for dominion, following dominion-portfolio-round1.ts's precedent
 * (see that file's own doc comment for the 6-step shape reused here:
 * candidate batch -> probe filter -> wave -> challenge -> bookkeeping ->
 * transcendence check).
 *
 * Candidate batch (5 — the design spec's own text names exactly 5 flags
 * despite its header saying "후보 6개"; this runner implements the 5 the spec
 * body actually specifies, all already registered on dominionAdapter.
 * strategySurface in ../dominion.ts under "GAP-11 Phase 4-C round-2 candidate
 * batch" — see that doc comment for full per-candidate design rationale and
 * the loss-mining-per-decision-anchor-freshness caveat these designs
 * deliberately avoid naively imitating):
 *   - B3-deep (1): `chapelEconomyV2` — keeps chapelEconomy's chapelTrash
 *     policy verbatim (already near-converged with L2, 67.4%->3.2%), rebuilds
 *     buy (Duchy-contest reorder, Witch/Laboratory) and action (Witch attack
 *     priority, junk-gated Chapel in every phase) from dominion-opus-bot.ts's
 *     source.
 *   - B1-exploit (2): `chapelEconomyV2-noGreen` (element isolation: drops the
 *     endgame-greening reorder) and `chapelEconomyV2-clonebuy` (element
 *     isolation: keeps V2's buy, reverts action to v1's blanket Chapel ban).
 *   - B2-opponent (1): `witchRushNoTrash` — never trashes (round1 B2's own
 *     bet, kept), adds a Witch/Laboratory tempo axis the chapelEconomy family
 *     never touches.
 *   - B4-explore (1): `opusCloneDominion` — full imitation (A10), wraps
 *     dominion-opus-bot.ts itself with zero drift risk (team lead's own
 *     bucket label — this is a literal-clone bet, not a search-prior one,
 *     since dominion has no search-based candidates in this round).
 * B5-imitate is not used this round (0 candidates, recorded as a
 * BucketOutcome with candidates: 0 — same convention as round1's own
 * B5-imitate exclusion).
 *
 * Probe filter: round1 (runs/dominion/probe-bank.json) + round2
 * (runs/dominion/probe-bank-round2.json) probe banks loaded and scored
 * together (team lead's instruction, gomoku-portfolio-round2.ts's own
 * precedent for merging+deduping by probeId). PROBE_SCORE_BOT_SEED_BASE
 * caveat: round1's probes were minted with anchorSeedBase=986_201
 * (dominion-loss-mining.ts) and round2's with anchorSeedBase=988_201
 * (dominion-loss-mining-round2.ts) — two *different* bases, unlike gomoku's
 * round1/round2 banks which shared one base by convention. This does NOT
 * break self-consistency here: dominion-opus-bot.ts's `decide()` never reads
 * its `seed` parameter for any of the five decisionPoints this game actually
 * exercises (buy/action/chapelTrash/workshopGain/militiaDiscard) — `rng` is
 * constructed but only consumed in an unreachable `default:` branch — so the
 * anchor's choice at a given (gameSeed, decisionIndex, observation) is
 * independent of which seed base derived its instantiation seed. This
 * script's own L2-self-agreement check (step 2 below) verifies this
 * empirically (expected 1.0 despite the base mismatch) rather than asserting
 * it from code-reading alone.
 *
 * Baseline comparison point (team lead's instruction): v3's actual composed
 * bot is plain `chapelEconomy` (composeBot's override semantics — see
 * dominion-loss-mining-round2.ts's own doc comment), scored in round 2 at
 * L2=16.8% (not the round1 challenge table's `chapelEconomy-d08` figure,
 * 22.5%, which is a different flag). Every "improvement over baseline"
 * comparison in this file's summary uses the round2 16.8% figure.
 *
 * Regression opponent = v3 champion (design spec's own instruction): achieved
 * by setting `baselineFlags: latest.flags` (registry v3's flag list) exactly
 * as dominion-portfolio-round1.ts did for v2 — `composeBot(adapter,
 * wave.baselineFlags)` inside wave-runner.ts's regression tier resolves this
 * to the same plain-chapelEconomy bot the challenge/loss-mining scripts use,
 * no special-casing needed. Smoke/prune/holdout tiers still use the
 * `opponent: 'heuristic'` raw baseline (round1's own convention — "티어는
 * 도미니언 관행" per the design spec).
 *
 * Fresh seed ranges (verified non-overlapping with every prior dominion
 * runner's own documented range: dominion-runner-{smoke,prune,holdout}
 * (1-90, 1000-1029, 2000-2029), the four ismcts waves (30000-33019,
 * 40000-43019, 50000-53019, 60000-63019), dominion-benchmark.ts
 * (50,000-51,999), dominion-anchor-ladder.ts (982_1xx/985_1xx/992,000+/
 * 993,000+/998,000+/999,000+), dominion-loss-mining.ts (400,000-400,099/
 * 401,000-401,099/986_1xx-986_3xx), dominion-loss-mining-round2.ts
 * (420,000-420,099/421,000-421,099/988_1xx-988_3xx), dominion-portfolio-
 * round1.ts (700,000-700,004/711,000+/712,000+/713,000+/714,000+/
 * 715,000-715,039/987_1xx/987_3xx)):
 *   - probe-filter cost check: 720,000-720,004 (N=5, shared block).
 *   - wave smoke/prune/holdout/regression: 721,000+/722,000+/723,000+/724,000+.
 *   - challenge (L1/L2): 725,000-725,039 (N=40).
 *   - confirm (only if triggered): 726,000-726,199 (N=200).
 *   - transcendence L3 holdout (only if confirm also triggers): 727,000-727,099 (N=100).
 * Bot seed bases (fresh 989_1xx/989_3xx/989_5xx/989_7xx block, distinct from
 * every dominion base used above): 989_101 (cost check/probe filter),
 * 989_301 (challenge), 989_501 (confirm), 989_701 (L3 holdout).
 * PROBE_SCORE_BOT_SEED_BASE stays 986_201 (round1's base — see the probe
 * filter doc note above for why the base choice does not affect
 * self-consistency for this deterministic anchor).
 *
 * Resource rule (team lead + this round's own instruction): heuristic-class
 * candidates only (no search/MCTS), low cost expected — still times a
 * COST_CHECK_N=5-game trial per candidate before the full wave, same as
 * round1's own probe-filter cost check.
 *
 * Transcendence check (team lead's instruction): if the N=40 challenge vs L2
 * already shows winRateCI.lower > 0.5, re-measure that same candidate at
 * N=200 (confirmatory, gomoku-portfolio-round2-confirm.ts's own precedent for
 * why a second measurement matters near a threshold) — only if THAT
 * confirmatory measurement also clears winRateCI.lower > 0.5 does this
 * script run the L3 holdout head-to-head (external-style2-l3,
 * dominion-anchor-ladder.ts's holdout anchor) at N=100, gate-free (no
 * LossReport/probe-bank generation from the holdout result — holdout guard).
 * Recorded under `transcendence` in the summary JSON either way.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import type { AnyBotFactory, AnyGameAdapter } from '../../contract/types';
import { eraseAdapter } from '../../loop/erase';
import { composeBot } from '../../loop/compose';
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
import { dominionAdapter } from '../dominion';
import { dominionOpusBot } from '../experiments/dominion-opus-bot';
import { dominionMidBot } from '../experiments/dominion-mid-bot';
import { dominionEngineBot } from '../experiments/dominion-engine-bot';

const GAME_ID = 'dominion';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const PROBE_SCORE_BOT_SEED_BASE = 986_201; // round1's base — see file doc comment for why the mismatch with round2's 988_201 doesn't break self-consistency here.
const COST_CHECK_SEED_BASE = 720_000;
const COST_CHECK_N = 5;
const COST_CHECK_BOT_SEED_BASE = 989_101;

const L2_ANCHOR_ID = 'external-opus-l2';
const L1_ANCHOR_ID = 'external-mid-l1';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_TRIGGER_THRESHOLD = 0.5;

const CONFIRM_N = 200;
const CONFIRM_SEED_BASE = 726_000;
const CONFIRM_BOT_SEED_BASE = 989_501;

const L3_N = 100;
const L3_SEED_BASE = 727_000;
const L3_BOT_SEED_BASE = 989_701;

/** v3's actual composed bot (composeBot override semantics collapse the
 * flags list to plain `chapelEconomy`) scored L2=16.8% in round 2's own
 * measurement (dominion-loss-mining-round2.ts) — the baseline every
 * "improvement" comparison in this file's summary uses, distinct from round1
 * challenge table's `chapelEconomy-d08` figure (22.5%, a different flag). */
const ROUND2_BASELINE_L2_WIN_RATE = 0.168;

interface RoundCandidate {
  readonly flag: string;
  readonly bucket: BucketId;
}

function now(): string {
  return new Date().toISOString();
}

function seeds(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function ciStr(result: { readonly winRateCI: { readonly lower: number; readonly upper: number } }): string {
  return `[${pct(result.winRateCI.lower)}, ${pct(result.winRateCI.upper)}]`;
}

function buildCandidates(): readonly RoundCandidate[] {
  return [
    { flag: 'chapelEconomyV2', bucket: 'B3-deep' },
    { flag: 'chapelEconomyV2-noGreen', bucket: 'B1-exploit' },
    { flag: 'chapelEconomyV2-clonebuy', bucket: 'B1-exploit' },
    { flag: 'witchRushNoTrash', bucket: 'B2-opponent' },
    { flag: 'opusCloneDominion', bucket: 'B4-explore' },
  ];
}

// ---------------------------------------------------------------------
// Probe bank merge (round1 + round2, deduped by probeId)
// ---------------------------------------------------------------------

function mergeProbeBanks(banks: readonly (readonly ProbePosition[])[]): readonly ProbePosition[] {
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
// Probe filter (+ per-candidate cost check, resource rule)
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
    const costResult = runHeadToHead(adapter, bot, dominionOpusBot, costSeeds, COST_CHECK_BOT_SEED_BASE);
    const elapsedMs = Date.now() - t0;
    const msPerGame = costResult.blocks > 0 ? elapsedMs / (costResult.blocks * 2) : Infinity;

    console.log(
      `  [probe-filter] ${candidate.flag} (${candidate.bucket}): agreement=${pct(probeScore.agreementRate)} ` +
        `(${probeScore.agreements}/${probeScore.probes - probeScore.skipped}, skipped=${probeScore.skipped}) ms/game=${msPerGame.toFixed(0)}`,
    );
    rows.push({ flag: candidate.flag, bucket: candidate.bucket, probeScore, msPerGame });
  }

  // All 5 candidates are cheap pure heuristics (no search) — every candidate
  // advances to the wave this round (design spec doesn't specify a top-N cut
  // for this round's small heuristic-only batch; round1's top-4-of-5 cut
  // existed specifically to gate the expensive B4 ismcts candidate, which
  // has no analogue here).
  return rows.map((row) => ({ ...row, advanced: true }));
}

function main(): void {
  console.log(`=== dominion portfolio round 2 (GAP-11 Phase 4-C) — rootDir=${ROOT_DIR} ===`);

  const adapter = eraseAdapter(dominionAdapter);

  console.log('1) 후보 배치 생성 (B3x1, B1x2, B2x1, B4x1 = 5 — 설계 명세 본문 기준, 헤더의 "6개"는 명세 본문과 불일치, 보고에 명시)');
  const candidates = buildCandidates();
  for (const candidate of candidates) {
    console.log(`   ${candidate.bucket}: ${candidate.flag}`);
  }

  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const ledgerStore = loadOrCreateLedger(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== 'v3') {
    throw new Error(
      `dominion-portfolio-round2: registry latest=${latest?.version ?? '(none)'} — expected v3 (run dominion-portfolio-round1.ts's promotion first)`,
    );
  }
  console.log(`   baseline=${latest.version} flags=[${latest.flags.join(', ')}] (composeBot 덮어쓰기로 실제 = chapelEconomy 단독, round2 L2=16.8%)`);

  console.log('2) 프로브 필터 (round1+round2 프로브 은행 합산 채점, 판당 비용 실측 각 5판)');
  const probeBankRound1Path = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank.json');
  const probeBankRound2Path = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round2.json');
  const probesRound1 = loadProbeBank(probeBankRound1Path);
  const probesRound2 = loadProbeBank(probeBankRound2Path);
  const mergedProbes = mergeProbeBanks([probesRound1, probesRound2]);
  console.log(`   프로브 은행: round1=${probesRound1.length}, round2=${probesRound2.length}, 합산(중복 제거 후)=${mergedProbes.length}`);

  const l2SelfScore = scoreAgainstProbes(adapter, dominionOpusBot, mergedProbes, PROBE_SCORE_BOT_SEED_BASE);
  console.log(
    `   L2 자기일치율(합산 프로브, base=986_201 고정)=${pct(l2SelfScore.agreementRate)} (probes=${l2SelfScore.probes}, skipped=${l2SelfScore.skipped}) ` +
      `— 1.0 기대(round1/round2 서로 다른 anchorSeedBase로 채굴됐지만 dominionOpusBot.decide()가 seed를 읽지 않아 무관해야 함, 파일 doc comment 참고)`,
  );

  const probeFilterRows = runProbeFilter(adapter, candidates, mergedProbes);
  console.log(`   진출(전원): ${probeFilterRows.map((row) => row.flag).join(', ')}`);

  console.log('3) 정규 웨이브 (신규 시드 뱅크, 티어는 도미니언 관행 — round1과 동일 크기)');
  const waveLedger = new SeedLedger();
  const reservedAt = now();
  const SMOKE_MAX = 30;
  const PRUNE_BLOCKS = 15;
  const HOLDOUT_BLOCKS = 15;
  const REGRESSION_BLOCKS = 20;
  waveLedger.reserve({ bankId: 'dominion-portfolio2-smoke', range: { start: 721_000, end: 721_000 + SMOKE_MAX - 1 }, purpose: 'smoke', reservedAt });
  waveLedger.reserve({ bankId: 'dominion-portfolio2-prune', range: { start: 722_000, end: 722_000 + PRUNE_BLOCKS - 1 }, purpose: 'prune', reservedAt });
  waveLedger.reserve({ bankId: 'dominion-portfolio2-holdout', range: { start: 723_000, end: 723_000 + HOLDOUT_BLOCKS - 1 }, purpose: 'holdout', reservedAt });
  waveLedger.reserve({ bankId: 'dominion-portfolio2-regression', range: { start: 724_000, end: 724_000 + REGRESSION_BLOCKS - 1 }, purpose: 'regression', reservedAt });

  const CHALLENGE_N = 40;
  const CHALLENGE_SEED_BASE = 725_000;
  const CHALLENGE_BOT_SEED_BASE = 989_301;
  const challengeEntries: readonly WaveChallengeEntry[] = [
    { anchorId: L1_ANCHOR_ID, factory: dominionMidBot as AnyBotFactory, role: 'feedback' },
    { anchorId: L2_ANCHOR_ID, factory: dominionOpusBot as AnyBotFactory, role: 'feedback' },
  ];

  const waveConfig = {
    ...assembleWaveConfig(adapter, {
      waveId: 'portfolio-round2',
      candidates: candidates.map((row) => ({ flag: row.flag })),
      opponent: 'heuristic',
      ledger: waveLedger,
      recordedAt: now(),
      baselineFlags: latest.flags, // v3 champion — regression opponent (design spec's own instruction).
      baselineVersion: latest.version,
      tiers: {
        smoke: { bankId: 'dominion-portfolio2-smoke', sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 }, maxBlocks: SMOKE_MAX, minBlocks: 5 },
        prune: { bankId: 'dominion-portfolio2-prune', blocks: PRUNE_BLOCKS },
        holdout: { bankId: 'dominion-portfolio2-holdout', blocks: HOLDOUT_BLOCKS },
        regression: { bankId: 'dominion-portfolio2-regression', blocks: REGRESSION_BLOCKS },
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
      `   ${entry.anchorId} vs ${entry.subject}: winRate=${pct(entry.winRate)} CI=${ciStr(entry)} blocks=${entry.blocks}`,
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
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round2-near-miss.json'), JSON.stringify(nearMiss, null, 2));

  console.log('6) registry 승격 (채택 있으면, 중복 승격 가드)');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  let promotedVersion: string | null = null;
  let promotedFlags: readonly string[] = latest.flags;
  if (adoptedFlags.length > 0) {
    const lineage = registry.lineage(latest.version);
    const alreadyPromoted = lineage.some((version) => version.sourceWaveId === report.waveId);
    if (alreadyPromoted) {
      console.log('   이 웨이브는 이미 승격됨 — 스킵');
      const promoted = lineage.find((version) => version.sourceWaveId === report.waveId);
      promotedVersion = promoted?.version ?? null;
      promotedFlags = promoted?.flags ?? latest.flags;
    } else {
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
    }
  } else {
    console.log('   채택된 후보 없음 — 승격 없음');
  }
  saveRegistry(ROOT_DIR, GAME_ID, registry);
  saveLedger(ROOT_DIR, GAME_ID, ledgerStore);

  console.log('7) 버킷 수율 계산 + 재배분 (round1 portfolio-state.json 로드 후 갱신)');
  const verdictByFlag = new Map(report.results.map((result) => [result.flag, result.verdict]));

  const bucketOutcomes: BucketOutcome[] = BUCKET_ORDER.map((bucket) => {
    const bucketCandidates = candidates.filter((candidate) => candidate.bucket === bucket);
    const adopted = bucketCandidates.filter((candidate) => verdictByFlag.get(candidate.flag) === 'adopted').length;

    const deltas = bucketCandidates
      .map((candidate) => challengeTable[L2_ANCHOR_ID]?.[candidate.flag]?.winRate)
      .filter((winRate): winRate is number => winRate !== undefined)
      .map((winRate) => winRate - ROUND2_BASELINE_L2_WIN_RATE);
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

  console.log('8) 초월 판정 트리거 검사 (vs L2 winRateCI.lower > 0.5, N=40)');
  interface TranscendenceEntry {
    readonly flag: string;
    readonly wasAdopted: boolean;
    readonly n40: { readonly winRate: number; readonly winRateCILower: number };
    readonly confirm: HeadToHeadResult;
    readonly confirmTriggered: boolean;
    readonly l3: HeadToHeadResult | null;
  }
  const transcendenceEntries: TranscendenceEntry[] = [];
  for (const entry of report.challengeResult ?? []) {
    if (entry.anchorId !== L2_ANCHOR_ID || entry.subject === 'baseline') {
      continue;
    }
    if (entry.winRateCI.lower <= TRANSCENDENCE_TRIGGER_THRESHOLD) {
      continue;
    }
    const flag = entry.subject;
    const wasAdopted = adoptedFlags.includes(flag);
    console.log(`   N=40 트리거됨: ${flag} (winRateCI.lower=${pct(entry.winRateCI.lower)}) — N=${CONFIRM_N} 확증 측정 실행`);
    const candidateBot = wasAdopted ? composeBot(adapter, promotedFlags) : composeBot(adapter, [flag]);
    const confirmResult = runHeadToHead(adapter, candidateBot, dominionOpusBot, seeds(CONFIRM_SEED_BASE, CONFIRM_N), CONFIRM_BOT_SEED_BASE);
    console.log(`   확증(N=${CONFIRM_N}) ${flag} vs L2: winRate=${pct(confirmResult.candidateWinRate)} CI=${ciStr(confirmResult)}`);

    const confirmTriggered = confirmResult.winRateCI.lower > TRANSCENDENCE_TRIGGER_THRESHOLD;
    let l3Result: HeadToHeadResult | null = null;
    if (confirmTriggered) {
      console.log(`   확증도 트리거 통과 — L3(${L3_ANCHOR_ID}) 홀드아웃 판정 실행 (N=${L3_N}, 게이트 없음)`);
      l3Result = runHeadToHead(adapter, candidateBot, dominionEngineBot, seeds(L3_SEED_BASE, L3_N), L3_BOT_SEED_BASE);
      console.log(`   L3 vs ${flag}: winRate=${pct(l3Result.candidateWinRate)} CI=${ciStr(l3Result)} blocks=${l3Result.blocks}`);
      // 홀드아웃 가드: trajectoryCollector 없이 호출했으므로 궤적이 수집되지
      // 않는다 — LossReport/probe-bank 생성 재료 자체가 없음(승률 숫자만 기록).
    } else {
      console.log(`   확증(N=${CONFIRM_N})에서는 트리거 미달 — L3 홀드아웃 미실행`);
    }
    transcendenceEntries.push({
      flag,
      wasAdopted,
      n40: { winRate: entry.winRate, winRateCILower: entry.winRateCI.lower },
      confirm: confirmResult,
      confirmTriggered,
      l3: l3Result,
    });
  }
  if (transcendenceEntries.length === 0) {
    console.log('   N=40에서 어떤 후보도 트리거 미달 — 확증/L3 홀드아웃 미실행');
  }

  console.log('9) runs/dominion/portfolio-round2.json 저장');
  const summary = {
    gameId: GAME_ID,
    generatedAt: now(),
    designSpecPath: 'scratchpad/dominion-round2-design-spec.md (main-loop, 그대로 구현)',
    candidateCountNote:
      '설계 명세 헤더는 "후보 6개"라고 적었지만 본문이 실제로 명명한 플래그는 5개(B3x1, B1x2, B2x1, B4x1) — 이 러너는 본문 기준 5개를 구현. 불일치를 지어내지 않고 그대로 보고.',
    v3Baseline: {
      flagsList: latest.flags,
      actualDominantFlag: 'chapelEconomy',
      round2L2WinRate: ROUND2_BASELINE_L2_WIN_RATE,
      note: 'round1 challenge table의 chapelEconomy-d08(L2=22.5%)과는 다른 후보 — v3의 실체는 plain chapelEconomy(round2 재측정 L2=16.8%).',
    },
    probeBankSources: {
      round1: { path: `runs/${GAME_ID}/probe-bank.json`, probes: probesRound1.length, anchorSeedBase: 986_201 },
      round2: { path: `runs/${GAME_ID}/probe-bank-round2.json`, probes: probesRound2.length, anchorSeedBase: 988_201 },
      merged: mergedProbes.length,
      l2SelfAgreementRate: l2SelfScore.agreementRate,
      l2SelfAgreementNote: '두 라운드가 다른 anchorSeedBase로 채굴됐지만 dominionOpusBot.decide()는 seed를 읽지 않으므로 무관 — 실측으로 1.0 기대치 검증.',
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
    excludedBuckets: {
      'B5-imitate': '이번 라운드 0 후보 — B4(opusCloneDominion)가 A10 전이 축을 담당(팀리드 버킷 지정).',
    },
    transcendence:
      transcendenceEntries.length > 0
        ? {
            triggered: true,
            threshold: TRANSCENDENCE_TRIGGER_THRESHOLD,
            entries: transcendenceEntries.map((entry) => ({
              flag: entry.flag,
              wasAdopted: entry.wasAdopted,
              n40: entry.n40,
              confirmN: CONFIRM_N,
              confirmWinRate: entry.confirm.candidateWinRate,
              confirmWinRateCI: entry.confirm.winRateCI,
              confirmTriggered: entry.confirmTriggered,
              l3AnchorId: entry.l3 ? L3_ANCHOR_ID : null,
              l3N: entry.l3 ? L3_N : null,
              l3WinRate: entry.l3?.candidateWinRate ?? null,
              l3WinRateCI: entry.l3?.winRateCI ?? null,
              note: entry.l3 ? '홀드아웃 가드: LossReport/probe-bank 생성 없음 — 승률 숫자만 기록.' : undefined,
            })),
          }
        : {
            triggered: false,
            threshold: TRANSCENDENCE_TRIGGER_THRESHOLD,
            reason: '어떤 후보도 N=40 challenge vs L2 winRateCI.lower > 0.5에 도달하지 못함 — 확증/L3 홀드아웃 미실행.',
          },
  };
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round2.json'), JSON.stringify(summary, null, 2));
  console.log(`   저장: runs/${GAME_ID}/portfolio-round2.json`);
}

main();
