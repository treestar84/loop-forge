# 출처 — 온보딩에 참조한 오픈소스 게임 프로젝트

> `src/reference/*.ts`의 각 게임 어댑터는 아래 오픈소스 저장소를 **참조 구현**으로
> 삼아 headless로 새로 작성했다(`docs/ONBOARDING-GUIDE.md` §2: "원본 프로젝트를
> 고치는 게 아니라, 원본의 룰을 참조 구현 삼아 어댑터 안에 headless로 재구성한다").
> **코드를 그대로 복사하지 않았다** — 룰의 수치·구조를 참고해 TypeScript로 독립
> 재구현했고, 그 사실과 원본과의 의도적 차이점을 각 어댑터 파일 상단 주석에
> 명시했다. 라이선스는 각 저장소 페이지에서 직접 확인할 것(이 표는 참고용 목록이지
> 라이선스 재고지가 아니다).

| 게임 | 저장소 | 언어 | 참조 범위 | 어댑터 파일 |
|---|---|---|---|---|
| 스플랜더 | [caeleel/splendor](https://github.com/caeleel/splendor) | Python(서버)+JS | 전체 룰(젬 5종·카드 3티어·노블·예약) | `src/reference/splendor.ts` |
| 오목 | [imjacobclark/BoardGameEngine](https://github.com/imjacobclark/BoardGameEngine) | Java | 구조 참고만 — 승리 판정은 원본 결함을 베끼지 않고 처음부터 새로 설계 | `src/reference/gomoku.ts` |
| 장기 | [davisethan/janggi](https://github.com/davisethan/janggi) | Python | 기물별 이동 규칙, 궁성/장군-마주보기 — General/Guard 대각선 이동 버그는 베끼지 않고 수정 | `src/reference/janggi.ts` |
| 도미니언 | [rspeer/dominiate](https://github.com/rspeer/dominiate) | CoffeeScript | 기본 세트 룰 중 12종 카드 부분집합(§5.7 증분 온보딩) | `src/reference/dominion.ts` |
| 윙스팬(core) | [keithgw/wingspan](https://github.com/keithgw/wingspan) | Python | **주의**: 이 저장소는 실제 윙스팬 보드게임 룰이 아니라 RL 학습용으로 극단 단순화된 자원게임(서식지·트리거·알·목표카드 없음)이다. "소스가 최종 근거" 원칙대로 이 단순화된 버전을 그대로 온보딩했다 — `src/reference/wingspan.ts`의 어댑터는 실제 시판 윙스팬의 재현이 **아니다**. | `src/reference/wingspan.ts` |
| 하스스톤(mirror) | [danielyule/hearthbreaker](https://github.com/danielyule/hearthbreaker) | Python | 중립 카드 12장, 미러 매치 전용(직업 카드·인터럽트 범위 밖) | `src/reference/hearthstone.ts` |
| 아발론(The Resistance: Avalon, 5인 기본 역할) | [AlexLomm/avalon-engine](https://github.com/AlexLomm/avalon-engine) | JS/TS(MIT) | **구조 참고만** — headless 엔진의 페이즈 구성(제안→투표→미션 순환)만 참고, 코드는 복사하지 않고 공개 표준 룰에서 처음부터 재구현. **스코프 축소**: 5인 기본 역할(멀린·충직한 종자 2·모드레드의 하수인·암살자)만 구현, 퍼시발·모르가나·모드레드(역할)·오베론 등 확장 역할은 범위 밖. 발언/주장(claim)도 구조화 결정 지점으로 이산화하지 않고 이번 패스에서 생략(ONBOARDING-GUIDE.md §"F4" 참고). | `src/reference/avalon.ts` |

## 알고리즘 충실 이식 (코드 수준 파생)

게임 콘텐츠와 별개로, 아래 모듈은 [google-deepmind/open_spiel](https://github.com/google-deepmind/open_spiel)
(Apache-2.0)의 참조 구현을 기준 삼아 TypeScript로 **충실 이식(faithful port)**한
파생물이다(DESIGN.md §7 라이선스 정책 예외, 2026-07-23 개정):

| 모듈 | 원 구현 | 이식 범위 |
|---|---|---|
| `src/search/mcts.ts` | `open_spiel/python/algorithms/mcts.py` | UCT 선택·랜덤 롤아웃 평가기. chance/동시수 처리는 범위 밖(Loop Forge는 랜덤성을 시드에 접음) |
| `src/search/ismcts.ts` | Cowling, Powley & Whitehouse (2012) "Information Set Monte Carlo Tree Search"(IEEE TCIAIG) + `open_spiel/algorithms/is_mcts.{h,cc}` | SO-ISMCTS: 정보집합 트리(루트 관찰 기준 행동열 키), 결정화별 합법 간선 제한, availability-count UCB1. mcts.ts의 롤아웃 평가기를 재사용(중복 이식 아님) |
| `src/learn/mccfr.ts` | `open_spiel/python/algorithms/outcome_sampling_mccfr.py` | outcome-sampling MCCFR. chance 샘플링을 게임 시드 샘플링으로 대응 |

## 참고: 로프-포지 자체의 설계 아이디어 출처

게임 콘텐츠가 아니라 **로프-포지 아키텍처 자체**가 참고한 선행 프로젝트(OpenSpiel,
PettingZoo, Fishtest/OpenBench, 티추 NPC 하네스 등)는 `DESIGN.md` §7 "오픈소스
체리픽 명세"에 별도로 정리돼 있다 — 이 문서(CREDITS.md)와는 대상이 다르다
(이건 게임 콘텐츠 출처, DESIGN.md §7은 설계 아이디어 출처).
