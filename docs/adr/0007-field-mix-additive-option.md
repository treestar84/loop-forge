# ADR-0007 — fieldMix를 opponent 대체가 아닌 추가 옵션으로 도입

**상태**: 채택됨 (2026-07-27)

## 맥락

`WaveConfig.opponent: 'heuristic' | 'random'`가 문자열 하나라, 대인원 FFA
게임(카탄 등)에서 "나머지 좌석 중 일부는 heuristic, 일부는 random" 같은 혼합
상대 구성(필드 믹스)을 표현할 방법이 없었다(GAP-ANALYSIS-3 F3/Y7 킹메이킹 갭,
GAP-ANALYSIS-10 M4).

## 결정

`WaveConfig`에 옵션 필드 `fieldMix?: ReadonlyArray<'heuristic'|'random'>`
(길이=playerCount-1)를 추가한다. 지정 시 기존 `opponent`보다 우선해 각
비후보 슬롯을 개별 구성한다. `runPairedBlock`의 opponent 파라미터를
단일/배열 겸용으로 확장하고, wave-runner 전 함수(`runTrajectory`,
`screenCandidate`, `runSmokeTier`, `runFixedTier`, `evaluateCandidate`,
`runWave`)를 "비후보 슬롯들의 봇 팩토리 목록" 기반으로 일반화했다. 미지정 시
전 슬롯이 동일 factory로 채워져 기존 경로와 완전히 동일 — `reportDigest`
고정 해시로 하위호환을 회귀 테스트로 고정.

## 대안

- **`opponent` 필드 타입을 유니온으로 교체**(문자열 | 배열): 기각 — 기존
  `opponent: 'heuristic'` 형태를 쓰는 모든 호출자의 타입을 바꿔야 해서 churn이
  큼. 완전히 새 옵션 필드로 추가하는 편이 하위호환 위험이 0에 가깝다.
- **`screenCandidate`의 no-op 스크리닝(base vs base)에도 fieldMix를 적용 안
  함**: 검토 후 기각 — field-mix 슬롯 구성을 유지한 채 후보 슬롯만 base로
  바꾸는 게 일관성 있다고 판단해 그렇게 구현.

## 결과

카탄 온보딩에서 `fieldMix: ['heuristic','heuristic','random']` 웨이브를
실제로 돌려 슬롯별로 정말 다른 봇이 배치되고, 같은 후보의 승률이 상대 구성에
따라 실제로 달라짐(roadExpansionPriority 0.183→0.267 등)을 로그로 확인 —
M4 실증 성공. 별도로 카탄의 registry v1(채택 0개) 벤치마크에서 "후보=상대가
동일 봇이면 좌석 순열 평균이 정확히 1/playerCount로 수렴한다"는 수학적 사실도
이 인프라 덕에 실측 확인됐다(정확히 25.0%, CI 폭 0).
