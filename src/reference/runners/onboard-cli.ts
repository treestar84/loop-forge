/**
 * `npm run onboard` — the single self-serve onboarding CLI
 * (docs/GAP-ANALYSIS-13.md §3 S3). An app boundary
 * (src/__tests__/dependency-rules.test.ts's APP_BOUNDARY_PREFIXES): the one
 * place allowed to call `Date.now()`/`new Date()`, touch the filesystem, or
 * spawn a subprocess for this feature, and the only place that imports every
 * layer (contract/kernel/loop/onboarding/artifacts) plus dynamically
 * `require()`s per-game generated files.
 *
 * Subcommands (docs/GAP-ANALYSIS-13.md §1's user journey):
 *   npm run onboard -- <game path or gameId>   S0 diagnosis (first run)
 *   npm run onboard -- scaffold <gameId>       S2 adapter/runner skeleton
 *   npm run onboard -- score <gameId>          G-Score conformance loop
 *   npm run onboard -- status <gameId>         read onboarding-state.json
 *   npm run onboard -- wave <gameId>           G4 wave guidance
 *   npm run onboard                            same as status, auto-detected
 *
 * All state-machine logic (gate transitions, report text, TODO-marker
 * counting) lives in the pure `src/onboarding/onboarding-state.ts` — this
 * file only wires that module to disk I/O, `tsc`, and an optional headless
 * coding agent (`claude -p`).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { parseGameProfile, type GameProfile } from '../../onboarding/profile';
import { estimateReadiness } from '../../onboarding/readiness-estimate';
import { scoreAdapter } from '../../onboarding/score';
import { evaluateWaveReadiness } from '../../onboarding/wave-readiness';
import { deriveArchetypes, renderAdapterScaffold, renderRunnerScaffold } from '../../onboarding/scaffold';
import { renderRulebook } from '../../artifacts/rulebook';
import {
  applyDiagnosis,
  applyScaffold,
  applyScore,
  applyWave,
  countOnboardTodoMarkers,
  renderStatusReport,
  type OnboardingState,
} from '../../onboarding/onboarding-state';
import type { AnyGameAdapter } from '../../contract/types';

function now(): string {
  return new Date().toISOString();
}

function rootDir(): string {
  return join(__dirname, '..', '..', '..');
}

function runsDir(gameId: string, ...segments: readonly string[]): string {
  return join(rootDir(), 'runs', gameId, ...segments);
}

function toPascalCase(gameId: string): string {
  return gameId
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function toCamelCase(gameId: string): string {
  const pascal = toPascalCase(gameId);
  return pascal.length === 0 ? pascal : pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function statePath(gameId: string): string {
  return runsDir(gameId, 'onboarding-state.json');
}

function loadState(gameId: string): OnboardingState | null {
  const path = statePath(gameId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as OnboardingState;
}

function saveState(state: OnboardingState): void {
  mkdirSync(runsDir(state.gameId), { recursive: true });
  writeFileSync(statePath(state.gameId), JSON.stringify(state, null, 2));
}

function requireState(gameId: string): OnboardingState {
  const state = loadState(gameId);
  if (state === null) {
    console.log(
      `runs/${gameId}/onboarding-state.json이 없습니다 — 먼저 \`npm run onboard -- <게임 경로 또는 ${gameId}>\`로 진단을 실행하세요.`,
    );
    process.exit(1);
  }
  return state;
}

// ---------------------------------------------------------------------------
// S0 diagnosis — source scan, profile prompt, headless agent, rulebook
// ---------------------------------------------------------------------------

const IGNORED_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target']);

function scanSourceTree(dir: string): { readonly fileCount: number; readonly extensionCounts: Record<string, number> } {
  const extensionCounts: Record<string, number> = {};
  let fileCount = 0;

  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIR_NAMES.has(entry)) continue;
      const full = join(current, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        fileCount += 1;
        const ext = extname(entry) || '(no extension)';
        extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;
      }
    }
  }

  walk(dir);
  return { fileCount, extensionCounts };
}

function guessLanguage(extensionCounts: Record<string, number>): string {
  const entries = Object.entries(extensionCounts).filter(([ext]) => ext !== '(no extension)');
  if (entries.length === 0) return '알 수 없음';
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] ?? '알 수 없음';
}

/** The full copy/pasteable profile-writing prompt (ONBOARDING-GUIDE §1
 * checklist + GameProfile schema field descriptions). Handed to a headless
 * agent verbatim, or printed for the user to paste into their own. */
function buildProfilePrompt(gameId: string, sourcePath: string | null, priorError: string | null): string {
  const lines: string[] = [];
  lines.push(
    `당신은 "${gameId}" 게임의 소스${sourcePath ? `(경로: ${sourcePath})` : '(경로 미제공 — 규칙 문서 기반으로 작성)'}를 읽고, ` +
      'Loop Forge의 GameProfile JSON을 작성해야 합니다. 아래 체크리스트(docs/ONBOARDING-GUIDE.md §1)를 채운 뒤, ' +
      '설명 없이 JSON 객체 하나만 출력하세요(코드블록 없이, 순수 JSON):',
  );
  lines.push('');
  lines.push('체크리스트:');
  lines.push('- 페이즈 구조와 턴 순서');
  lines.push('- 결정 지점 목록 — 각 지점이 유한 열거 가능한 선택인지(enumerable)');
  lines.push('- 무작위성의 원천 전부 + 각각 시드 주입 가능 여부(seedable)');
  lines.push('- 은닉 정보의 경계 — 누구에게 은닉되는지(hiddenFrom) 구체적으로, 경계가 명확한지(boundaryExplicit)');
  lines.push('- 승패 판정 규칙(outcomeRule)과 종국 보장 규칙(terminationGuarantee, 무한 게임 방지)');
  lines.push('- 기존 AI/NPC 로직의 위치');
  lines.push('- UI/네트워크/애니메이션과 룰의 결합 지점(uiCouplingNotes) 및 그 심각도(uiCouplingSeverity: none/low/medium/high)');
  lines.push('- 참조 구현의 완전성(referenceImplementation: full-code/partial/document-only)');
  lines.push('');
  lines.push('GameProfile JSON 스키마 필드:');
  lines.push('{');
  lines.push('  "gameId": string,');
  lines.push('  "summary": string,');
  lines.push('  "playerCount": number,');
  lines.push('  "phases": [{ "id": string, "description": string }],');
  lines.push(
    '  "decisionPoints": [{ "id": string, "description": string, "hiddenInfoVisible": string, "enumerable"?: boolean }],',
  );
  lines.push('  "randomnessSources": [{ "id": string, "description": string, "seedable": boolean }],');
  lines.push(
    '  "hiddenInformation": [{ "id": string, "description": string, "hiddenFrom": string, "boundaryExplicit"?: boolean }],',
  );
  lines.push('  "outcomeRule": string,');
  lines.push('  "existingAiLocations": [{ "path": string, "description": string }],');
  lines.push('  "uiCouplingNotes": string[],');
  lines.push('  "knownIssues": string[],');
  lines.push('  "turnBased"?: boolean, "competitive"?: boolean, "independentGames"?: boolean, "decisionsStructurable"?: boolean,');
  lines.push('  "terminationGuarantee"?: string,');
  lines.push('  "uiCouplingSeverity"?: "none" | "low" | "medium" | "high",');
  lines.push('  "referenceImplementation"?: "full-code" | "partial" | "document-only"');
  lines.push('}');
  lines.push('');
  lines.push(`gameId 필드는 정확히 "${gameId}"로 채우세요. 배열 필드는 빈 배열이라도 반드시 포함하세요.`);
  if (priorError !== null) {
    lines.push('');
    lines.push(`이전 시도가 검증에 실패했습니다 — 다음 오류를 고쳐 다시 JSON만 출력하세요: ${priorError}`);
  }
  return lines.join('\n');
}

function claudeAvailable(): boolean {
  try {
    execFileSync('command', ['-v', 'claude'], { shell: '/bin/sh', stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const trimmed = (candidate ?? text).trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('no JSON object found in headless agent output');
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

/** Attempts to auto-run the profile-writing prompt via `claude -p`, retrying
 * up to 2 times on validation failure before returning null (fallback to
 * printing the prompt). Never throws — any failure just falls through. */
function tryHeadlessProfile(gameId: string, sourcePath: string | null): GameProfile | null {
  if (!claudeAvailable()) return null;

  let priorError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = buildProfilePrompt(gameId, sourcePath, priorError);
    const result = spawnSync('claude', ['-p', prompt], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    if (result.status !== 0 || !result.stdout) {
      return null;
    }
    try {
      const parsed = extractJsonObject(result.stdout);
      return parseGameProfile(parsed);
    } catch (error) {
      priorError = error instanceof Error ? error.message : String(error);
    }
  }
  return null;
}

function loadOrCreateProfile(gameId: string, sourcePath: string | null, noAgent: boolean): GameProfile | null {
  const profilePath = runsDir(gameId, 'profile.json');
  if (existsSync(profilePath)) {
    const raw = JSON.parse(readFileSync(profilePath, 'utf8'));
    return parseGameProfile(raw);
  }

  if (!noAgent) {
    const headlessProfile = tryHeadlessProfile(gameId, sourcePath);
    if (headlessProfile !== null) {
      mkdirSync(runsDir(gameId), { recursive: true });
      writeFileSync(profilePath, JSON.stringify(headlessProfile, null, 2));
      console.log(`헤드리스 에이전트가 GameProfile을 작성하고 검증을 통과했습니다: runs/${gameId}/profile.json`);
      return headlessProfile;
    }
    console.log('헤드리스 에이전트(`claude -p`) 자동 실행에 실패했거나 사용할 수 없습니다 — 프롬프트를 출력합니다.\n');
  }

  console.log('=== 아래 프롬프트를 당신의 코딩 에이전트에 붙여넣으세요 ===\n');
  console.log(buildProfilePrompt(gameId, sourcePath, null));
  console.log(`\n=== 응답을 runs/${gameId}/profile.json에 저장한 뒤 이 명령을 다시 실행하세요 ===`);
  return null;
}

function adapterFilePath(gameId: string): string {
  return join(rootDir(), 'src', 'reference', `${gameId}.ts`);
}

function runnerFilePath(gameId: string): string {
  return join(rootDir(), 'src', 'reference', 'runners', `${gameId}.ts`);
}

function runDiagnosis(arg: string, noAgent: boolean): void {
  const looksLikePath = existsSync(arg) && statSync(arg).isDirectory();
  const sourcePath = looksLikePath ? resolve(arg) : null;
  const gameId = looksLikePath ? basename(resolve(arg)) : arg;

  console.log(`=== ${gameId} 진단 시작 ===`);
  if (sourcePath) {
    const scan = scanSourceTree(sourcePath);
    console.log(`소스 스캔: 파일 ${scan.fileCount}개, 주 언어(추정) ${guessLanguage(scan.extensionCounts)}`);
  } else {
    console.log('경로가 아닌 gameId로 인식 — 소스 스캔을 생략합니다.');
  }

  const profile = loadOrCreateProfile(gameId, sourcePath, noAgent);
  if (profile === null) {
    return; // prompt already printed; nothing else to do until profile.json exists.
  }

  const estimate = estimateReadiness(profile);
  const adapterExists = existsSync(adapterFilePath(gameId));
  const generatedAtLabel = now();

  const rulebook = renderRulebook(profile, estimate, { generatedAtLabel });
  mkdirSync(runsDir(gameId), { recursive: true });
  writeFileSync(runsDir(gameId, 'RULEBOOK.md'), rulebook);

  const state = applyDiagnosis(gameId, estimate, generatedAtLabel);
  saveState(state);

  console.log('');
  console.log(`판정: ${state.verdict}`);
  if (state.score) {
    console.log(`적합도: ${state.score.value}% (${state.score.kind === 'P' ? '추정' : '실측'})`);
  }
  if (estimate.verdict === 'estimate' && estimate.items) {
    const top3 = [...estimate.items]
      .map((item) => ({ ...item, lost: item.weight - item.score }))
      .filter((item) => item.lost > 0)
      .sort((a, b) => b.lost - a.lost)
      .slice(0, 3);
    if (top3.length > 0) {
      console.log('보완 목록 상위 3개:');
      for (const item of top3) {
        console.log(`  - ${item.id} ${item.label} (${item.lost}점 감점): ${item.reason}`);
      }
    }
  }
  if (!adapterExists && estimate.verdict !== 'impossible') {
    console.log('(참고: 아직 어댑터가 없어 위 %는 P-Score 추정치입니다.)');
  }
  console.log(`룰북: runs/${gameId}/RULEBOOK.md`);
  console.log(`다음 행동: ${state.nextAction}`);
}

// ---------------------------------------------------------------------------
// S2 scaffold
// ---------------------------------------------------------------------------

function runScaffold(gameId: string): void {
  const profilePath = runsDir(gameId, 'profile.json');
  if (!existsSync(profilePath)) {
    console.log(`runs/${gameId}/profile.json이 없습니다 — 먼저 \`npm run onboard -- <게임 경로 또는 ${gameId}>\`로 진단을 실행하세요.`);
    process.exit(1);
  }
  const profile = parseGameProfile(JSON.parse(readFileSync(profilePath, 'utf8')));

  const adapterPath = adapterFilePath(gameId);
  const runnerPath = runnerFilePath(gameId);
  if (existsSync(adapterPath) || existsSync(runnerPath)) {
    console.log(
      `이미 존재하는 파일이 있어 거부합니다 — 덮어쓰지 않습니다: ` +
        `${existsSync(adapterPath) ? adapterPath : ''} ${existsSync(runnerPath) ? runnerPath : ''}`.trim(),
    );
    process.exit(1);
  }

  const determination = deriveArchetypes(profile);
  console.log(`아키타입 판정: ${determination.archetypes.join(', ')}`);
  for (const reason of determination.reasons) {
    console.log(`  - ${reason}`);
  }

  const adapterSource = renderAdapterScaffold(profile, determination);
  const runnerSource = renderRunnerScaffold(profile);
  mkdirSync(join(rootDir(), 'src', 'reference', 'runners'), { recursive: true });
  writeFileSync(adapterPath, adapterSource);
  writeFileSync(runnerPath, runnerSource);
  console.log(`생성됨: ${adapterPath}`);
  console.log(`생성됨: ${runnerPath}`);

  const { count, markers } = countOnboardTodoMarkers(adapterSource);
  console.log(`\nTODO(onboard) 마커 ${count}개:`);
  for (const marker of markers) {
    console.log(`  - ${marker}`);
  }

  console.log('\ntsc --noEmit 실행 중...');
  let tscPassed = false;
  try {
    execFileSync('npx', ['tsc', '--noEmit'], { cwd: rootDir(), stdio: 'pipe' });
    tscPassed = true;
    console.log('tsc --noEmit: 0 에러.');
  } catch (error) {
    const output = error instanceof Error && 'stdout' in error ? String((error as { stdout?: Buffer }).stdout ?? '') : '';
    console.log('tsc --noEmit: 에러 있음.');
    if (output) console.log(output);
  }

  const prev = requireState(gameId);
  const state = applyScaffold(prev, count, tscPassed, now());
  saveState(state);
  console.log(`\n다음 행동: ${state.nextAction}`);
}

// ---------------------------------------------------------------------------
// G-Score
// ---------------------------------------------------------------------------

function loadAdapter(gameId: string): AnyGameAdapter {
  const path = adapterFilePath(gameId);
  if (!existsSync(path)) {
    console.log(`${path}가 없습니다 — 먼저 \`npm run onboard -- scaffold ${gameId}\`를 실행하세요.`);
    process.exit(1);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(path) as Record<string, unknown>;
  const exportName = `${toCamelCase(gameId)}Adapter`;
  const adapter = mod[exportName];
  if (adapter === undefined) {
    console.log(`${path}에서 export "${exportName}"을 찾지 못했습니다.`);
    process.exit(1);
  }
  return adapter as AnyGameAdapter;
}

/** Number of C0..C7 axes — used as the blocking-axis count sentinel when
 * `scoreAdapter` itself throws (see the catch branch below): an adapter
 * whose stub bodies still throw TODO(onboard) errors can crash the scorer
 * before it produces per-axis blockers (e.g. an unimplemented baseline
 * throws inside score.ts's C1 sampling loop, which has no try/catch around
 * a totally-unimplemented adapter) — this is the normal, expected state of
 * a fresh scaffold, not a bug in this CLI, so it is reported as a maximally
 * unready score rather than a raw stack trace. */
const CONFORMANCE_AXIS_COUNT = 8;

/** Re-measures G2's two facts (TODO(onboard) marker count + tsc result) at
 * score time — `score` is meant to run repeatedly during G-Convert
 * (ONBOARDING-GUIDE.md §3.1), so it refreshes g2 itself instead of trusting
 * whatever `scaffold` last recorded (which is stale the moment an agent
 * edits the generated file). */
function checkG2Now(gameId: string): { readonly todoCount: number; readonly tscPassed: boolean } {
  const adapterSource = readFileSync(adapterFilePath(gameId), 'utf8');
  const { count } = countOnboardTodoMarkers(adapterSource);
  let tscPassed = false;
  try {
    execFileSync('npx', ['tsc', '--noEmit'], { cwd: rootDir(), stdio: 'pipe' });
    tscPassed = true;
  } catch {
    tscPassed = false;
  }
  return { todoCount: count, tscPassed };
}

function runScore(gameId: string): void {
  const prevState = requireState(gameId);
  const adapter = loadAdapter(gameId);
  const { todoCount, tscPassed } = checkG2Now(gameId);

  console.log(`=== ${gameId} G-Score ===`);
  console.log(`G2 재확인: TODO(onboard) 마커 ${todoCount}개, tsc ${tscPassed ? '통과' : '실패'}`);

  let conformance;
  try {
    conformance = scoreAdapter(adapter);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log('scoreAdapter가 예외를 던졌습니다 — 어댑터 골격에 아직 구현되지 않은 부분이 있습니다:');
    console.log(`  ${message}`);
    console.log('TODO(onboard) 마커를 먼저 채운 뒤 다시 채점하세요.');
    const state = applyScore(prevState, todoCount, tscPassed, 0, CONFORMANCE_AXIS_COUNT, now());
    saveState(state);
    console.log(`\n다음 행동: ${state.nextAction}`);
    return;
  }
  const readiness = evaluateWaveReadiness(conformance);

  console.log(`overallScore=${conformance.overallScore} ready=${conformance.ready}`);
  for (const axis of conformance.axes) {
    console.log(`  ${axis.axis}: ${axis.score}${axis.blockers.length > 0 ? ` (${axis.blockers.length} blocker)` : ''}`);
    for (const blocker of axis.blockers) {
      console.log(`    - [${blocker.code}] ${blocker.message}`);
      console.log(`      remediation: ${blocker.remediation}`);
    }
  }
  if (readiness.warnings.length > 0) {
    console.log('경고:');
    for (const warning of readiness.warnings) {
      console.log(`  - ${warning}`);
    }
  }

  const state = applyScore(prevState, todoCount, tscPassed, conformance.overallScore, readiness.blockingAxes.length, now());
  saveState(state);
  console.log(`\n적합도(실측, C-Score): ${conformance.overallScore}%`);
  console.log(`다음 행동: ${state.nextAction}`);
}

// ---------------------------------------------------------------------------
// Status / wave
// ---------------------------------------------------------------------------

function runStatus(gameId: string): void {
  const state = requireState(gameId);
  console.log(renderStatusReport(state));
}

function runWaveGuidance(gameId: string): void {
  const state = requireState(gameId);
  if (state.gates.g3 !== 'pass') {
    console.log(`G3(적합성) 게이트가 아직 통과하지 못했습니다 — 먼저 \`npm run onboard -- score ${gameId}\`로 blocker를 해소하세요.`);
    console.log(renderStatusReport(state));
    return;
  }
  const runnerPath = runnerFilePath(gameId);
  console.log(`G3 통과 — 첫 웨이브를 실행할 수 있습니다.`);
  console.log(`실행: npx ts-node ${runnerPath}`);
  console.log('(무거운 자기대국이므로 이 CLI가 자동으로 실행하지는 않습니다 — 위 명령을 직접 실행하세요.)');

  const updated = applyWave(state, true, now());
  saveState(updated);
  console.log(`\n다음 행동: ${updated.nextAction}`);
}

// ---------------------------------------------------------------------------
// Argument parsing / dispatch
// ---------------------------------------------------------------------------

function findSingleTrackedGameId(): string | null {
  const runs = join(rootDir(), 'runs');
  if (!existsSync(runs)) return null;
  const candidates = readdirSync(runs).filter((entry) => existsSync(join(runs, entry, 'onboarding-state.json')));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function main(): void {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const noAgentIndex = args.indexOf('--no-agent');
  const noAgent = noAgentIndex !== -1;
  if (noAgent) args.splice(noAgentIndex, 1);

  if (args.length === 0) {
    const gameId = findSingleTrackedGameId();
    if (gameId === null) {
      console.log(
        '진행 중인 게임을 하나로 특정할 수 없습니다 — `npm run onboard -- status <gameId>`로 지정하거나, ' +
          '`npm run onboard -- <게임 경로 또는 gameId>`로 새 진단을 시작하세요.',
      );
      return;
    }
    runStatus(gameId);
    return;
  }

  const [command, gameId] = args;
  if (command === 'scaffold' && gameId) {
    runScaffold(gameId);
  } else if (command === 'score' && gameId) {
    runScore(gameId);
  } else if (command === 'status' && gameId) {
    runStatus(gameId);
  } else if (command === 'wave' && gameId) {
    runWaveGuidance(gameId);
  } else if (command !== undefined) {
    runDiagnosis(command, noAgent);
  } else {
    console.log('사용법: npm run onboard -- <게임 경로 또는 gameId> | scaffold|score|status|wave <gameId>');
  }
}

main();
