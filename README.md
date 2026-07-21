# Loop Forge

완성된 게임 프로젝트(보드게임·전략 카드게임 등)를 받아서, 그 게임의 NPC 난이도를
**프롬프트 한 줄 없이** 자동으로 끌어올리는 플랫폼.

## 동작 원리

1. **게임 온보딩 파이프라인** — 게임을 파악(G-Profile)하고, 하네스에서 돌 수 있는
   상태인지 세분화 점수로 채점(G-Score)하고, headless 쌍둥이를 구현(G-Convert)하고,
   실게임과의 정합성을 증명(G-Parity)한다. 임계 미달이면 루프는 실행을 거부한다.
2. **큰 루프 / 작은 루프** — 후보 전략을 설계(큰 루프)하고, 좌석 미러링 페어 대국 ·
   SPRT · holdout 시드 격리를 갖춘 다단 게이트(작은 루프)로 통계 검증을 거쳐 진짜
   효과 있는 전략만 채택한다.
3. **게임 특성 자동 분류** — 팀 유무·완전정보 여부·승/패 전용 여부·콘텐츠 무게·
   결정 수 규모를 `GameSpec` 선언만으로 자동 분류하고, 그로부터 채점 표본 크기·
   웨이브 기준·벤치마크 렌더링을 자동 조립한다(사람이 게임마다 손으로 설정값을
   기억해서 맞출 필요가 옵트인이 아니라 옵트아웃).

선행 프로젝트(웹 티추 NPC 하네스: 후보 4,100개 · 16만+ 판 · 과적합 발견과 아키텍처
재설계)의 실사고 — 좌석 편향 +15%p, 고정 시드 과적합, ±7.9%p 노이즈 오채택, 관찰
오염 — 를 채점 축과 게이트 규칙으로 일반화했다.

## 구조

```
src/contract/    ① 게임 어댑터 계약 (결정 지점은 데이터, 봇 인터페이스는 decide() 하나)
src/kernel/      ③ 실험 커널 (rng · 시드 원장 · 페어드 통계 · SPRT · digest · 다단 게이트 ·
                    게임 특성 분류기classify.ts/설정 조립기blueprint.ts)
src/loop/        ④ 루프 엔진 (매치/페어드 러너 · 캘리브레이션 · 웨이브 러너 ·
                    웨이브 설정 조립assemble-wave-config.ts)
src/onboarding/  ② 적합성 게이트 (C0~C7 채점 배터리 + 수정 지침 리포트)
src/artifacts/   산출물 계층 (게임별 실행 기록run-store · 기준선/채택 이력의 재로드
                    가능한 영속화game-state · 게임당 통합 요약game-summary · 벤치마크
                    앵커 사다리benchmark)
src/reference/   레퍼런스+실전 게임 어댑터 7종(아래 표) + 게임별 실행 진입점
                    (reference/runners/<gameId>.ts)
```

의존 방향: `contract ← kernel ← loop ← onboarding`, `artifacts`는 `loop`/`kernel`
위. `reference/demo.ts`와 `reference/runners/*.ts`만 전 계층을 넘나드는 앱 경계.
전부 `src/__tests__/dependency-rules.test.ts`가 기계적으로 강제한다.

## 온보딩된 게임

| 게임 | 원본 소스 | conformance | 웨이브 채택 |
|---|---|---|---|
| mini-trick (레퍼런스) | 자체 설계 | C0~C6 100 | `npm run demo`로 실행 |
| 스플랜더 | [caeleel/splendor](https://github.com/caeleel/splendor) | C0~C6 100 | 1/3 채택 |
| 오목 | [imjacobclark/BoardGameEngine](https://github.com/imjacobclark/BoardGameEngine) | C0~C6 100 | 3/3 채택 |
| 장기 | [davisethan/janggi](https://github.com/davisethan/janggi) | C0~C6 100 | 0/3 채택 |
| 도미니언 | [rspeer/dominiate](https://github.com/rspeer/dominiate) | C0~C6 100 | 1/3 채택 |
| 윙스팬(core) | [keithgw/wingspan](https://github.com/keithgw/wingspan) | C0~C6 100 | 0/3 채택 |
| 하스스톤(mirror) | [danielyule/hearthbreaker](https://github.com/danielyule/hearthbreaker) | C0~C6 100 | 0/3 채택 |

원본 저장소 상세·라이선스는 [docs/CREDITS.md](./docs/CREDITS.md). 7개 게임 전부
**C0~C6(게임 로직·통계적 신뢰성)은 만점**이지만, **C7(원본과의 정합성)은 아직
증명되지 않았다** — 지금은 어댑터 self-play로 만든 재현성 fixture만 있고 원본
게임에서 뽑은 진짜 리플레이가 없어 60점으로 캡되어 있다(`ReplayFixture.provenance`,
`docs/ONBOARDING-GUIDE.md` §4). 각 게임을 직접 돌려보려면:

```bash
npx ts-node src/reference/runners/<gameId>.ts   # 예: gomoku, splendor, janggi...
```

## 벤치마크: Opus 즉흥설계 vs Loop Forge (2026-07-21, N=2,000/열)

"복잡한 통계 파이프라인 없이 LLM에게 봇을 즉흥으로 설계시킨 것"과 "Loop Forge가
검증까지 거쳐 채택한 전략"을 게임마다 3열로 비교한 실측 결과. 전체 설계·해석은
[docs/BENCHMARK-LEADERBOARD.md](./docs/BENCHMARK-LEADERBOARD.md).

| 게임 | A: Opus봇 vs 기본봇 | B: 루프포지봇 vs 기본봇 | C: Opus봇 vs 루프포지봇 |
|---|---|---|---|
| 오목 | 100.0% | 100.0% | 97.1% (Opus 우세) |
| 스플랜더 | 36.6% | 83.0% | 6.9% (**루프포지 압도**) |
| 장기 | 78.0% | 50.4%(채택 0개) | 75.1% |
| 도미니언 | 100.0% | 99.5% | 95.3% (Opus 근소 우세) |
| 윙스팬 | 76.9% | 50.0%(채택 0개) | 76.9% |
| 하스스톤 | 96.7% | 50.0%(채택 0개) | 96.8% |

채택 전략이 있는 3개 게임 중 스플랜더는 Loop Forge가 압도했지만, 오목·도미니언은
즉흥 Opus봇에 밀렸다 — 표본 크기가 작은 소규모 웨이브 채택의 한계를 그대로
드러낸 정직한 결과다(`docs/FIX-BACKLOG.md` R5/R9).

## 시작

```bash
npm install
npm run typecheck && npm test
npm run demo   # mini-trick 온보딩 채점 → 캘리브레이션 → 웨이브 → 채택 판정
```

## 문서

- 설계 상세: [DESIGN.md](./DESIGN.md), 단계 계획: [ROADMAP.md](./ROADMAP.md)
- 온보딩 절차: [docs/ONBOARDING-GUIDE.md](./docs/ONBOARDING-GUIDE.md)
- 지표 해석: [docs/INTERPRETATION.md](./docs/INTERPRETATION.md)
- 갭 분석 이력·수정 백로그: [docs/FIX-BACKLOG.md](./docs/FIX-BACKLOG.md)
- 벤치마크 실험 설계: [docs/BENCHMARK-EXPERIMENT.md](./docs/BENCHMARK-EXPERIMENT.md),
  실측 리더보드: [docs/BENCHMARK-LEADERBOARD.md](./docs/BENCHMARK-LEADERBOARD.md)
- 원본 게임 출처: [docs/CREDITS.md](./docs/CREDITS.md)
