# ADR-0006 — identityCenter 가정 붕괴에 옵트인 이스케이프 해치로 대응

**상태**: 채택됨 (2026-07-27)

## 맥락

C5 축(`scoreC5`)이 "무작위 자기대국 승률 ≈ identityCenter(1/playerCount 또는
1/teamCount)"를 공정성 기준으로 강제 검사한다(`C5_IDENTITY_NOT_FAIR` 블로커).
이 가정은 **승리조건이 대칭인 게임에서만** 성립한다. 아발론 같은 숨은 진영
게임(선/악 승리조건이 OR/AND로 비대칭)에서는 실제 승률이 1/N과 무관하게
결정되는데도, 기존 가이드(GAP-ANALYSIS-3 F4)가 권장한 "teams 미선언" 처리를
그대로 따르면 **가이드를 따른 온보딩이 자기모순으로 거부되는** 실제 결함이
코드 검증으로 확인됐다(GAP-ANALYSIS-10 M1).

## 결정

`GameSpec`에 `hiddenTeamStructure?`(숨은 진영)·`cooperativeStructure?`(협동
게임, M2) 옵트인 필드를 추가한다. 둘 중 하나라도 true면 `scoreC5`가
`identityCenter`를 정적 공식 대신 **실측 `identity.meanWinRate` 자기참조**로
재정의한다 — 좌석 편향 검사(`identity.bias`)는 별도 경로라 완전히 그대로
유지(C5의 원래 목적인 좌석 편향 사고 재발 방지는 무력화하지 않음).

## 대안

- **`classifyGame`의 `matchStructure` 분류 자체를 확장**(예: `'hidden-team'`
  값 추가): 이번 라운드에서는 보류 — 하위 소비자(blueprint, benchmark 렌더링
  등)에 미치는 파급을 실제로 증명된 문제 없이 넓히는 것은 과설계로 판단.
  실제 아발론 온보딩에서 이 오분류가 진짜 문제를 일으키면 그때 처치.
- **`identityCenter` 검사 자체를 완화(모든 게임에서 벗어남 허용)**: 기각 —
  좌석 편향 사고 재발 방지라는 원래 목적을 죽인다.

## 결과

아발론 온보딩(`hiddenTeamStructure:true`)에서 C5가 실측치(0.237)를 자기 기준점
삼아 블로커 없이 통과함을 로그로 직접 확인 — M1 실증 성공. 부수로 초기
heuristic(정보 미활용) 설계가 `C5_HEURISTIC_NOT_DISTINCT`로 실제 거부돼
재설계했다 — 블로커가 항상 어댑터 버그를 뜻하진 않지만, 이번엔 진짜 버그였던
반례.
