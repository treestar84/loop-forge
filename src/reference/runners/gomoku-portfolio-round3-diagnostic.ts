/**
 * gomoku-portfolio-round3-diagnostic — GAP-11 Phase 4-B2 미니 진단(팀리드
 * 지시): v7(=registry v7 composed bot, 실질 mcts12-s256-opusclone-w16 단독 —
 * composeBot의 "마지막 MCTS 플래그만 생존" 규칙)과 L2(external-opus-l2)는
 * 같은 위협 함수(opus-clone evaluator가 L2 자신의 채점 로직을 이식한 것) 위의
 * 거울 대국이다(portfolio-round2.json의 challenge 결과: vs L2 51.0%
 * CI=[47.5%, 54.5%], 무승부 57.5%). 이 스크립트는 같은 evaluator 위에서
 * **탐색 예산 우위**(s256→s512, 미달 시 s768)만 단독으로 검증한다 — 후보
 * 정의는 ./shared/gomoku-round3-candidates.ts.
 *
 * 절차(팀리드 지시 원문 그대로):
 *   1. 후보(mcts12-s512-opusclone-w16) vs L2 판당 비용 실측 N=5.
 *   2. 진단 head-to-head N=100(신규 시드, 비겹침).
 *   3. 분기:
 *      - winRateCI.lower > 0.5 → 확증 N=200(신규 시드) → 재확인되면 정규
 *        웨이브(regression 상대=v7, 신규 뱅크, 티어는 round2 축소 관행:
 *        smoke<=20/prune=10/holdout=10/regression=25)로 채택 절차 → 채택 시
 *        registry 승격(v8) → L3 홀드아웃 초월 판정(N=100, 승률 숫자만 기록,
 *        LossReport/프로브 금지) → 전 과정 기록.
 *      - 미달 → s768 1점만 추가 진단(N=100, 비용 확인 후) → 그래도 미달이면
 *        정직 기록 후 종료(예산 축 소진 선언, 억지 반복 금지).
 *
 * 시드 범위(모든 기존 gomoku 러너의 자기 문서화 범위와 비겹침 확인 —
 * gomoku-portfolio-round2.ts는 530_000-536_099/989_101-989_701, -confirm.ts는
 * 537_000-538_099/989_601-989_701 사용; 이 스크립트는 그 위 540_000+/
 * 990_300+에서 시작):
 *   - 비용 체크(s512): 540_000-540_004 (N=5). 비용 체크(s768, 조건부):
 *     540_100-540_104 (N=5).
 *   - 1차 진단(s512): 541_000-541_099 (N=100). 1차 진단(s768, 조건부):
 *     541_500-541_599 (N=100).
 *   - 확증(트리거된 후보, N=200): 542_000-542_199.
 *   - 웨이브 스모크/프룬/홀드아웃/리그레션(채택 절차 진행 시):
 *     543_000+/543_100+/543_200+/543_300+.
 *   - L3 홀드아웃 초월 판정(N=100): 544_000-544_099.
 *   봇 시드 베이스(독립 공간, 신규): 990_301(비용/s512), 990_311(비용/s768),
 *   990_401(진단/s512), 990_411(진단/s768), 990_501(확증), 990_601(L3).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import type { AnyBotFactory } from '../../contract/types';
import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { assembleWaveConfig } from '../../loop/assemble-wave-config';
import { runWave, type WaveChallengeEntry, type WaveReport } from '../../loop/wave-runner';
import { SeedLedger } from '../../kernel/seed-ledger';
import { loadOrCreateLedger, loadOrCreateRegistry, saveLedger, saveRegistry } from '../../artifacts/game-state';
import { extractNearMissCandidates, type AdoptionEntry } from '../../artifacts/adoption-ledger';
import { gomokuAdapter } from '../gomoku';
import { gomokuOpusBot } from '../experiments/gomoku-opus-bot';
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
import { buildRound2Candidates } from './shared/gomoku-round2-candidates';
import {
  GOMOKU_ROUND3_S512_FLAG,
  GOMOKU_ROUND3_S768_FLAG,
  buildRound3S512Candidate,
  buildRound3S768Candidate,
} from './shared/gomoku-round3-candidates';

const GAME_ID = 'gomoku';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRIGGER_THRESHOLD = 0.5;

const COST_N = 5;
const DIAG_N = 100;
const CONFIRM_N = 200;
const L3_N = 100;

function now(): string {
  return new Date().toISOString();
}

function seeds(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function ciStr(result: HeadToHeadResult): string {
  return `[${pct(result.winRateCI.lower)}, ${pct(result.winRateCI.upper)}]`;
}

interface DiagnosticStage {
  readonly flag: string;
  readonly costCheck: { n: number; msPerGame: number; blocks: number };
  readonly diagnostic: { n: number; result: HeadToHeadResult };
  readonly triggered: boolean;
}

interface ConfirmStage {
  readonly flag: string;
  readonly n: number;
  readonly result: HeadToHeadResult;
  readonly triggered: boolean;
}

interface WaveStage {
  readonly waveId: string;
  readonly comparabilityKey: string;
  readonly verdict: string;
  readonly tiersPassed: readonly string[];
  readonly adopted: boolean;
  readonly promotedVersion: string | null;
}

interface TranscendenceStage {
  readonly flag: string;
  readonly n: number;
  readonly result: HeadToHeadResult;
  readonly note: string;
}

function main(): void {
  console.log(`=== gomoku 3회전 예산 우위 미니 진단 (GAP-11 Phase 4-B2) — rootDir=${ROOT_DIR} ===`);

  const bareAdapter = eraseAdapter(gomokuAdapter);
  const round1Candidates = buildRound1Candidates(bareAdapter);
  const round2Candidates = buildRound2Candidates(bareAdapter);
  const round3S512 = buildRound3S512Candidate(bareAdapter);
  const round3S768 = buildRound3S768Candidate(bareAdapter);

  // v7을 재구성하려면(regression 상대) registry가 이름댈 수 있는 모든 동적
  // 플래그를 어댑터에 와이어링해야 한다 — round2-confirm.ts와 동일한 관행.
  const adapter = withStrategyFlags(bareAdapter, [
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_CONFIG, GOMOKU_MCTS_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_HR_CONFIG, GOMOKU_MCTS_HR_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_CONFIG, GOMOKU_MCTS2_S256_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_HR_CONFIG, GOMOKU_MCTS2_S256_HR_FLAG),
    gomokuMcts2S256CrFlagSpec(bareAdapter),
    gomokuMcts2S512CrFlagSpec(bareAdapter),
    ...round1Candidates.map((c) => c.spec),
    ...round2Candidates.map((c) => c.spec),
    round3S512.spec,
    round3S768.spec,
  ]);

  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== 'v7') {
    throw new Error(
      `gomoku-portfolio-round3-diagnostic: registry latest=${latest?.version ?? '(none)'} — expected v7`,
    );
  }
  console.log(`   v7 flags=[${latest.flags.join(', ')}]`);

  // ---------------------------------------------------------------------
  // Step 1+2: cost check + N=100 diagnostic for a given self-contained flag.
  // ---------------------------------------------------------------------
  function diagnose(
    flag: string,
    costSeedBase: number,
    costBotSeedBase: number,
    diagSeedBase: number,
    diagBotSeedBase: number,
  ): DiagnosticStage {
    const bot = composeBot(adapter, [flag]);

    console.log(`   [비용 체크] ${flag} vs L2, N=${COST_N} (시드 ${costSeedBase}-${costSeedBase + COST_N - 1})`);
    const t0 = Date.now();
    const costResult = runHeadToHead(adapter, bot, gomokuOpusBot, seeds(costSeedBase, COST_N), costBotSeedBase);
    const elapsedMs = Date.now() - t0;
    const msPerGame = costResult.blocks > 0 ? elapsedMs / costResult.blocks : Infinity;
    const projectedMinutes = (msPerGame * DIAG_N) / 60_000;
    console.log(
      `     blocks=${costResult.blocks} ms/game=${msPerGame.toFixed(0)} → N=${DIAG_N} 예상 ${projectedMinutes.toFixed(1)}분`,
    );

    console.log(
      `   [진단] ${flag} vs L2, N=${DIAG_N} (신규 시드 ${diagSeedBase}-${diagSeedBase + DIAG_N - 1})`,
    );
    const diagResult = runHeadToHead(adapter, bot, gomokuOpusBot, seeds(diagSeedBase, DIAG_N), diagBotSeedBase);
    console.log(
      `     winRate=${pct(diagResult.candidateWinRate)} CI=${ciStr(diagResult)} drawRate=${pct(diagResult.drawRate)} blocks=${diagResult.blocks}`,
    );
    const triggered = diagResult.winRateCI.lower > TRIGGER_THRESHOLD;
    console.log(
      `     winRateCI.lower=${pct(diagResult.winRateCI.lower)} ${triggered ? '>' : '<='} ${pct(TRIGGER_THRESHOLD)} → ${triggered ? '확증 진행' : '미달'}`,
    );

    return {
      flag,
      costCheck: { n: COST_N, msPerGame, blocks: costResult.blocks },
      diagnostic: { n: DIAG_N, result: diagResult },
      triggered,
    };
  }

  console.log('1) mcts12-s512-opusclone-w16 진단');
  const s512Diagnostic = diagnose(GOMOKU_ROUND3_S512_FLAG, 540_000, 990_301, 541_000, 990_401);

  let s768Diagnostic: DiagnosticStage | null = null;
  let winningFlag: string | null = s512Diagnostic.triggered ? GOMOKU_ROUND3_S512_FLAG : null;

  if (!s512Diagnostic.triggered) {
    console.log('2) s512 미달 — mcts12-s768-opusclone-w16 추가 진단 1점');
    s768Diagnostic = diagnose(GOMOKU_ROUND3_S768_FLAG, 540_100, 990_311, 541_500, 990_411);
    winningFlag = s768Diagnostic.triggered ? GOMOKU_ROUND3_S768_FLAG : null;
  }

  // ---------------------------------------------------------------------
  // Step 3: confirmatory N=200 (only if some diagnostic triggered).
  // ---------------------------------------------------------------------
  let confirmStage: ConfirmStage | null = null;
  let waveStage: WaveStage | null = null;
  let transcendenceStage: TranscendenceStage | null = null;
  let promotedFlags: readonly string[] = latest.flags;

  if (winningFlag !== null) {
    const bot = composeBot(adapter, [winningFlag]);
    console.log(`3) 확증 측정: ${winningFlag} vs L2, N=${CONFIRM_N} (신규 시드 542_000-542_199)`);
    const confirmResult = runHeadToHead(adapter, bot, gomokuOpusBot, seeds(542_000, CONFIRM_N), 990_501);
    console.log(
      `   winRate=${pct(confirmResult.candidateWinRate)} CI=${ciStr(confirmResult)} drawRate=${pct(confirmResult.drawRate)} blocks=${confirmResult.blocks}`,
    );
    const confirmTriggered = confirmResult.winRateCI.lower > TRIGGER_THRESHOLD;
    console.log(`   확증 판정: ${confirmTriggered ? '재확인됨 — 정규 웨이브 진행' : '미확인 — 웨이브 미실행'}`);
    confirmStage = { flag: winningFlag, n: CONFIRM_N, result: confirmResult, triggered: confirmTriggered };

    if (confirmTriggered) {
      console.log('4) 정규 웨이브 (regression 상대=v7, 신규 시드 뱅크, 티어=round2 축소 관행)');
      const ledgerStore = loadOrCreateLedger(ROOT_DIR, GAME_ID);
      const waveLedger = new SeedLedger();
      const reservedAt = now();
      const SMOKE_MAX = 20;
      const PRUNE_BLOCKS = 10;
      const HOLDOUT_BLOCKS = 10;
      const REGRESSION_BLOCKS = 25;
      waveLedger.reserve({ bankId: 'gomoku-portfolio3-smoke', range: { start: 543_000, end: 543_000 + SMOKE_MAX - 1 }, purpose: 'smoke', reservedAt });
      waveLedger.reserve({ bankId: 'gomoku-portfolio3-prune', range: { start: 543_100, end: 543_100 + PRUNE_BLOCKS - 1 }, purpose: 'prune', reservedAt });
      waveLedger.reserve({ bankId: 'gomoku-portfolio3-holdout', range: { start: 543_200, end: 543_200 + HOLDOUT_BLOCKS - 1 }, purpose: 'holdout', reservedAt });
      waveLedger.reserve({ bankId: 'gomoku-portfolio3-regression', range: { start: 543_300, end: 543_300 + REGRESSION_BLOCKS - 1 }, purpose: 'regression', reservedAt });

      const waveConfig = {
        ...assembleWaveConfig(adapter, {
          waveId: 'portfolio-round3',
          candidates: [{ flag: winningFlag }],
          opponent: 'heuristic',
          ledger: waveLedger,
          recordedAt: now(),
          baselineFlags: latest.flags,
          baselineVersion: latest.version,
          tiers: {
            smoke: { bankId: 'gomoku-portfolio3-smoke', sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 }, maxBlocks: SMOKE_MAX, minBlocks: 5 },
            prune: { bankId: 'gomoku-portfolio3-prune', blocks: PRUNE_BLOCKS },
            holdout: { bankId: 'gomoku-portfolio3-holdout', blocks: HOLDOUT_BLOCKS },
            regression: { bankId: 'gomoku-portfolio3-regression', blocks: REGRESSION_BLOCKS },
          },
          screenProbe: { seeds: [1, 2, 3], botSeedBase: 100 },
        }),
      };

      const report: WaveReport = runWave(adapter, waveConfig);
      const result = report.results[0];
      if (result === undefined) {
        throw new Error('gomoku-portfolio-round3-diagnostic: wave report has no results for the single candidate');
      }
      console.log(`   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`);

      const entries: AdoptionEntry[] = report.results.map((r) => {
        const tierStats: AdoptionEntry['tierStats'] = {};
        for (const tier of ['screen', 'smoke', 'prune', 'holdout', 'regression'] as const) {
          const stats = r.stats[tier];
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
        const isNoOp = r.tiersPassed.length === 0 && r.stats.smoke === undefined;
        return {
          flags: r.flags,
          verdict: isNoOp ? 'screened-out' : r.verdict,
          tierStats,
          ...(isNoOp ? { failureReason: 'behavioral no-op (screened out before any games)' } : {}),
        };
      });
      ledgerStore.add({
        waveId: report.waveId,
        recordedAt: now(),
        comparabilityKey: report.comparabilityKey,
        baselineVersion: latest.version,
        opponentId: waveConfig.opponent,
        entries,
        nextLoopNotes: [],
      });
      const nearMiss = extractNearMissCandidates(
        { waveId: report.waveId, recordedAt: now(), comparabilityKey: report.comparabilityKey, baselineVersion: latest.version, opponentId: waveConfig.opponent, entries, nextLoopNotes: [] },
        waveConfig.criteria,
      );
      writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'near-miss-round3.json'), JSON.stringify(nearMiss, null, 2));

      const adopted = result.verdict === 'adopted';
      let promotedVersion: string | null = null;
      if (adopted) {
        const lineage = registry.lineage(latest.version);
        const nextVersion = registry.register({
          version: `v${lineage.length + 1}`,
          flags: [...latest.flags, winningFlag],
          parent: latest.version,
          createdAt: now(),
          sourceWaveId: report.waveId,
          notes: `portfolio-round3(예산 우위 미니 진단)에서 채택: ${winningFlag}`,
        });
        promotedVersion = nextVersion.version;
        promotedFlags = nextVersion.flags;
        console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
      } else {
        console.log('   채택 안 됨 — 승격 없음');
      }
      saveRegistry(ROOT_DIR, GAME_ID, registry);
      saveLedger(ROOT_DIR, GAME_ID, ledgerStore);

      waveStage = {
        waveId: report.waveId,
        comparabilityKey: report.comparabilityKey,
        verdict: result.verdict,
        tiersPassed: result.tiersPassed,
        adopted,
        promotedVersion,
      };

      if (adopted) {
        console.log('5) L3 홀드아웃 초월 판정 (N=100, 게이트 없음 — 승률 숫자만 기록)');
        const l3Bot = composeBot(adapter, promotedFlags);
        const l3Result = runHeadToHead(
          adapter,
          l3Bot,
          gomokuPositionalBot,
          seeds(544_000, L3_N),
          990_601,
        );
        console.log(
          `   L3(${L3_ANCHOR_ID}): winRate=${pct(l3Result.candidateWinRate)} CI=${ciStr(l3Result)} blocks=${l3Result.blocks}`,
        );
        transcendenceStage = {
          flag: winningFlag,
          n: L3_N,
          result: l3Result,
          note: '홀드아웃 가드: LossReport/probe-bank 생성 없음 — 승률 숫자만 기록.',
        };
      } else {
        console.log('   웨이브 미채택 — L3 홀드아웃 판정 미실행');
      }
    }
  } else {
    console.log('3) s512/s768 모두 미달 — 확증/웨이브/초월 판정 전부 미실행 (예산 축 소진, 정직 기록 후 종료)');
  }

  // ---------------------------------------------------------------------
  // Persist.
  // ---------------------------------------------------------------------
  console.log('6) runs/gomoku/portfolio-round3.json 저장');
  const summary = {
    gameId: GAME_ID,
    generatedAt: now(),
    designRationale:
      'v7과 L2는 같은 위협 함수(opus-clone evaluator)를 쓰는 거울 대국(무승부 57.5%, portfolio-round2.json) — 같은 evaluator 위에서 탐색 예산 우위(s256→s512/s768)가 결정 게임을 가져오는지 검증. A1(예산 단독) x A10(모방/이식) 조합은 미시도(ADR-0009 위반 아님, 팀리드 확정).',
    diagnostics: [
      {
        flag: s512Diagnostic.flag,
        costCheck: s512Diagnostic.costCheck,
        n: s512Diagnostic.diagnostic.n,
        winRate: s512Diagnostic.diagnostic.result.candidateWinRate,
        winRateCI: s512Diagnostic.diagnostic.result.winRateCI,
        drawRate: s512Diagnostic.diagnostic.result.drawRate,
        blocks: s512Diagnostic.diagnostic.result.blocks,
        triggered: s512Diagnostic.triggered,
      },
      ...(s768Diagnostic
        ? [
            {
              flag: s768Diagnostic.flag,
              costCheck: s768Diagnostic.costCheck,
              n: s768Diagnostic.diagnostic.n,
              winRate: s768Diagnostic.diagnostic.result.candidateWinRate,
              winRateCI: s768Diagnostic.diagnostic.result.winRateCI,
              drawRate: s768Diagnostic.diagnostic.result.drawRate,
              blocks: s768Diagnostic.diagnostic.result.blocks,
              triggered: s768Diagnostic.triggered,
            },
          ]
        : []),
    ],
    confirmatory: confirmStage
      ? {
          flag: confirmStage.flag,
          n: confirmStage.n,
          winRate: confirmStage.result.candidateWinRate,
          winRateCI: confirmStage.result.winRateCI,
          drawRate: confirmStage.result.drawRate,
          blocks: confirmStage.result.blocks,
          triggered: confirmStage.triggered,
        }
      : { ran: false, reason: '1차 진단(s512, 미달 시 s768) 모두 winRateCI.lower <= 0.5 — 확증 측정 미실행.' },
    wave: waveStage ?? { ran: false, reason: '확증 측정에서 winRateCI.lower > 0.5에 도달하지 못함(또는 확증 미실행) — 정규 웨이브 미실행.' },
    transcendence: transcendenceStage
      ? {
          triggered: true,
          flag: transcendenceStage.flag,
          l3AnchorId: L3_ANCHOR_ID,
          n: transcendenceStage.n,
          winRate: transcendenceStage.result.candidateWinRate,
          winRateCI: transcendenceStage.result.winRateCI,
          blocks: transcendenceStage.result.blocks,
          note: transcendenceStage.note,
        }
      : { triggered: false, reason: '웨이브 미실행 또는 미채택 — L3 홀드아웃 판정 미실행.' },
    conclusion:
      winningFlag !== null && confirmStage?.triggered && waveStage?.adopted
        ? `채택됨 — ${waveStage.promotedVersion}, 예산 우위(${winningFlag}) 가설 확인.`
        : winningFlag !== null && confirmStage?.triggered
          ? '웨이브에서 채택 기준 미달 — 예산 우위 신호는 있었으나 정규 게이트(smoke/prune/holdout/regression) 통과 실패.'
          : winningFlag !== null
            ? '1차 진단은 트리거됐으나 확증(N=200)에서 재확인 실패 — 노이즈로 판단, 채택 절차 미진행.'
            : 's256→s512, s512→s768 모두 vs L2 winRateCI.lower <= 0.5 — 예산 단독 우위 가설 기각. 예산 축은 이 라운드에서 소진 선언(억지 반복 금지, 팀리드 지시).',
  };
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round3.json'), JSON.stringify(summary, null, 2));
  console.log(`   저장: runs/${GAME_ID}/portfolio-round3.json`);
}

main();
