# ADR-0003 — 승격 전 "현재 챔피언과 직접 대결" 회귀 게이트

**상태**: 채택됨 (2026-07-23)

## 맥락

오목 v3 사고: `mcts-s64` 플래그의 `apply()`가 base를 완전히 무시하고 순수
MCTS 봇을 반환하는 override형 후보였다. 승격 게이트는 항상 "후보 vs raw
기본봇"만 비교했는데, raw 기본봇은 이기지만 **현재 챔피언(v2, 수제 3플래그
합성봇)보다는 약한** 후보가 그대로 통과해버렸다 — 실측 결과 B열이 100%→87.5%로
하락(GAP-ANALYSIS-7 §1.5).

## 결정

`kernel/gates.ts`에 `TierId 'regression'`을 추가하고, `holdout` 통과 후
**상대를 raw 기본봇이 아니라 "현재 챔피언 합성봇"(`baselineFlags`로 조립)**으로
바꿔 재검증한다. 승률 ≥0.5(옵트인 `regressionMinWinRate`로 조정 가능, 기본값
0.5 — 동급 교체는 회귀가 아니므로 통과)여야 최종 승격된다. `WaveConfig.tiers.
regression`이 옵트인 필드라 미설정 시 기존 동작·`reportDigest` 완전 불변.

## 대안

- **매 후보 평가 시 항상 챔피언과 비교**(regression을 필수로): 기각 — 하위호환
  파괴(기존 wave-runner.test.ts의 고정 해시 단언이 전부 깨짐), 그리고 챔피언이
  없는 첫 웨이브(v1)에서는 애초에 무의미.
- **`opponent` 필드 자체를 챔피언으로 바꿈**: 기각 — 그러면 screen/smoke/prune/
  holdout 전 티어의 "raw 기준 성능"이라는 정보를 잃는다. regression은 별도
  최종 관문으로 분리해야 "raw는 이기지만 챔피언에는 진다"는 케이스를 구분해서
  보여줄 수 있다.

## 결과

오목 v4(mcts2-s256-hr)가 regression에서 챔피언 상대 60% 승리를 확인한 뒤
승격된 것이 첫 실전 검증이었다. 이후 스플랜더·도미니언의 IS-MCTS 후보가
실제로 이 게이트에서 차단됐다(raw 대비 압도적이지만 챔피언보다 약함) — 설계
의도가 정확히 작동한 것으로 확인. 근접실패(near-miss)로 강등되는 로직이
`finalVerdict`에 있고, `AdoptionLedger`의 `failedAtTier`가 `'regression'`을
정확히 구분해 기록한다.
