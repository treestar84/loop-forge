# 벤치마크 리더보드 — Opus 즉흥설계 vs Loop Forge 검증 전략

> `docs/BENCHMARK-EXPERIMENT.md`의 3열 실험 실측 결과. 게임이 추가될 때마다 이
> 문서에 행을 더한다. 원본 수치는 `runs/<gameId>/benchmark-3col.{json,md}`,
> 실험 코드는 `src/reference/experiments/<gameId>-opus-bot.ts` +
> `src/reference/runners/<gameId>-benchmark.ts`. 전부 `runHeadToHead`(게이트 없는
> 순수 집계, 좌석 페어드 미러링)로 측정 — SPRT/holdout을 거치지 않은 관찰값이다.
>
> **게임 간 승률을 직접 비교하지 않는다**(문맥마다 `baselines.heuristic`의 강함이
> 다름 — `docs/INTERPRETATION.md` 제1규칙과 동일 원칙). 게임 하나 안에서 A·B·C
> 3개를 함께 보는 것이 이 실험의 단위다.

## 결과 (2026-07-21, N=2,000/열)

| 게임 | A: Opus봇 vs 기본봇 | B: 루프포지봇 vs 기본봇 | C: Opus봇 vs 루프포지봇 | 채택 전략 | 승자(C열) |
|---|---|---|---|---|---|
| 오목 | 100.0% | 100.0% | 97.1% | 3/3 | **Opus** |
| 스플랜더 | 36.6% | 83.0% | 6.9% | 1/3 | **루프포지** (압도적) |
| 장기 | 78.0% | 50.4%(≈50%) | 75.1% | 0/3 (아직 개선 없음) | 의미 없음 — B=기본봇 |
| 도미니언 | 100.0% | 99.5% | 95.3% | 1/3 | **Opus** (근소) |
| 윙스팬 | 76.9% | 50.0% | 76.9% | 0/3 (아직 개선 없음) | 의미 없음 — B=기본봇 |
| 하스스톤 | 96.7% | 50.0% | 96.8% | 0/3 (아직 개선 없음) | 의미 없음 — B=기본봇 |

## 읽는 법

- **채택 전략이 0개인 게임(장기·윙스팬·하스스톤)은 B열이 정의상 ~50%다** — 루프포지봇이
  아직 기본봇과 똑같기 때문이다. 이 3개 게임에서는 "Loop Forge가 아직 이 게임에서
  개선을 못 만들었다"는 뜻이지 실패가 아니다. C열도 이 경우 A열과 사실상 같은
  신호(Opus봇 vs 기본봇)다.
- **채택 전략이 있는 3개 게임(오목·스플랜더·도미니언)에서 결과가 갈렸다** —
  스플랜더는 Loop Forge가 압도(C=6.9%, Opus봇 승률), 오목·도미니언은 오히려 Opus의
  즉흥 설계가 우세했다(C=97.1%, 95.3%, 둘 다 Opus 승률).
- **이건 Loop Forge의 실패가 아니라 GAP-ANALYSIS-6 R5가 예고한 신호다**: 오목·
  도미니언의 채택 판정은 calibration 없이 정해진 소규모 표본(클램프 하한 5~30블록)으로
  났다. 스플랜더에서만 표본이 충분했거나(또는 채택된 전략 자체가 유독 강했거나)
  이겼다. 오목·도미니언은 "표본을 늘리면 결과가 달라질 수 있는 채택"의 실측 증거다.
- 오목에서 추가로 발견된 것: `composeBot`이 여러 플래그를 순서대로 합성할 때
  뒤에 적용된 플래그가 앞선 플래그의 판단을 완전히 덮어쓸 수 있다(오목의
  `centerProximity`가 `blockImmediateThreat`를 사실상 무력화) — 플래그 합성
  순서/상호작용 자체가 별도로 검토할 가치가 있는 지점이다.

## 알려진 인프라 한계 (다음 라운드에서 처치)

- **registry↔ledger 승격 누락(FIX-BACKLOG R9)**: 6개 게임 전부 `registry.json`의
  최신 버전이 `v1`(flags 없음)로 남아있고, 웨이브 채택 판정은 `ledger.json`에만
  있다. 이번 실험은 전부 `ledger`에서 adopted 플래그를 직접 읽어 B열 봇을
  합성했다(각 `benchmark-3col.md`에 `flagSource: ledger-adopted`로 명시). R9가
  처치되면 `registry.latest()`만으로 충분해진다.
- Opus봇은 이번 실험을 위해 **한 번만** 즉흥 설계됐고 Loop Forge의 채점/웨이브
  피드백을 전혀 받지 않았다(실험 전제 유지). 재현성이 필요하면 각 `<gameId>-opus-bot.ts`
  파일이 그대로 고정 소스다 — 다시 "설계"를 요청하면 다른 봇이 나올 수 있다.

## 새 게임 추가 시 절차

1. 온보딩(`docs/ONBOARDING-GUIDE.md`) → `src/reference/runners/<gameId>.ts`로
   웨이브 실행.
2. `src/reference/experiments/<gameId>-opus-bot.ts` — Opus가 규칙만 보고 즉흥
   설계(웨이브/채점 피드백 없이 1회).
3. `src/reference/runners/<gameId>-benchmark.ts` — `runHeadToHead`로 A/B/C 3열
   측정, `runs/<gameId>/benchmark-3col.{json,md}` 저장.
4. 이 문서에 행 추가.
