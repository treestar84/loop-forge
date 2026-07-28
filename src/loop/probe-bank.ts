/**
 * Probe position bank (docs/GAP-ANALYSIS-11.md D4, stage 3): promote
 * LossReport divergences into a sealed set of fixed positions — "(seed,
 * choicePrefix)" pairs, the chess-engine-suite (EPD/STS) idea applied here.
 * Once a losing position is captured as a probe, every future candidate can
 * be screened against it for a few ms per position instead of a full game,
 * and no candidate can silently repeat a previously-discovered mistake.
 *
 * Game-neutral: only encodeChoice/applyChoice/getObservation/
 * getLegalChoices/currentDecision are used.
 *
 * Anchor derivation (GAP-11 Phase 1-E finding): scoreAgainstProbes rebuilds
 * the anchor/candidate bot for a probe from a seed forked on
 * `${probe.gameSeed}:${probe.decisionIndex}` — the exact same derivation
 * loss-mining.ts's mineLosses uses per candidate decision (see that file's
 * doc comment). Sharing the derivation is required for self-consistency:
 * scoring the same anchor that produced a probe's anchorChoiceKey against
 * its own probe bank (same seed base as mineLosses's anchorSeedBase) must
 * reproduce agreementRate 1.0.
 */

import type { AnyBotFactory, AnyGameAdapter } from '../contract/types';
import { createRng } from '../kernel/rng';
import type { MatchTrajectoryRecord } from './paired-match';
import type { LossDivergence, LossReport } from './loss-mining';

/** Same convention as loss-mining.ts's/loop/calibrate.ts's BOT_SEED_SPACE. */
const BOT_SEED_SPACE = 2 ** 31;

export interface ProbePosition {
  /** Stable key: `${gameSeed}-${decisionIndex}`. */
  readonly probeId: string;
  readonly gameSeed: number;
  /** Same value as encoded in probeId; kept as its own field so callers
   * (e.g. scoreAgainstProbes) never need to parse it back out of probeId. */
  readonly decisionIndex: number;
  /** encodeChoice sequence to replay from createInitialState(gameSeed) to reach this position. */
  readonly choicePrefix: readonly string[];
  readonly deciderSeat: number;
  readonly decisionPointId: string;
  /** The choice the anchor actually made in this position. */
  readonly anchorChoiceKey: string;
  readonly sourceAnchorId: string;
}

/**
 * Promote a LossReport's divergences into probes. Divergences are deduped by
 * probeId (gameSeed + decisionIndex is already unique per divergence, so
 * this only matters if `report` was built by concatenating overlapping
 * runs). When `maxProbes` truncates the set, earlier divergences
 * (smaller decisionIndex) are kept first — the assumption being that an
 * earlier branch point is more load-bearing: a mistake made early has more
 * downstream game left to be ruined by it, and is more likely to recur
 * across many candidates than a late-game idiosyncrasy.
 */
export function buildProbeBank(
  report: LossReport,
  records: readonly MatchTrajectoryRecord[],
  sourceAnchorId: string,
  options?: { readonly maxProbes?: number },
): readonly ProbePosition[] {
  // Multiple records can share the same gameSeed — e.g. every seatingPlan
  // permutation runPairedBlock's trajectoryCollector emits for one game seed
  // seats the candidate differently, so their `choices` arrays diverge from
  // the very first decision. A LossDivergence only carries (gameSeed,
  // decisionIndex), so the source record must be picked by matching the
  // divergence's own recorded candidateChoiceKey at that index — not just by
  // gameSeed — or choicePrefix ends up reconstructed from the wrong record.
  const recordsBySeed = new Map<number, MatchTrajectoryRecord[]>();
  for (const record of records) {
    const bucket = recordsBySeed.get(record.gameSeed) ?? [];
    bucket.push(record);
    recordsBySeed.set(record.gameSeed, bucket);
  }

  function findSourceRecord(divergence: LossDivergence): MatchTrajectoryRecord | undefined {
    const candidates = recordsBySeed.get(divergence.gameSeed) ?? [];
    return candidates.find(
      (record) =>
        record.choices[divergence.decisionIndex] === divergence.candidateChoiceKey &&
        record.deciders[divergence.decisionIndex] === record.candidateSeat,
    );
  }

  const seenProbeIds = new Set<string>();
  const probes: ProbePosition[] = [];

  for (const divergence of report.divergences) {
    const probeId = probeIdOf(divergence);
    if (seenProbeIds.has(probeId)) {
      continue;
    }
    const record = findSourceRecord(divergence);
    if (!record) {
      continue;
    }
    seenProbeIds.add(probeId);
    probes.push({
      probeId,
      gameSeed: divergence.gameSeed,
      decisionIndex: divergence.decisionIndex,
      choicePrefix: record.choices.slice(0, divergence.decisionIndex),
      deciderSeat: record.candidateSeat,
      decisionPointId: divergence.decisionPointId,
      anchorChoiceKey: divergence.anchorChoiceKey,
      sourceAnchorId,
    });
  }

  probes.sort((a, b) => a.decisionIndex - b.decisionIndex);

  const maxProbes = options?.maxProbes;
  if (maxProbes === undefined || probes.length <= maxProbes) {
    return probes;
  }
  return probes.slice(0, maxProbes);
}

function probeIdOf(divergence: LossDivergence): string {
  return `${divergence.gameSeed}-${divergence.decisionIndex}`;
}

export interface ProbeScore {
  readonly probes: number;
  readonly agreements: number;
  readonly agreementRate: number;
  readonly skipped: number;
}

/**
 * Score `botFactory` against a fixed probe set: for each probe, replay
 * choicePrefix from createInitialState(probe.gameSeed), ask the bot what it
 * would do, and compare against probe.anchorChoiceKey. A probe whose replay
 * hits an illegal/unencodable prefix choice, or that never reaches a
 * decision for probe.deciderSeat, is skipped (not counted as a mismatch).
 * The bot is rebuilt once per probe from a seed forked on
 * `${probe.gameSeed}:${probe.decisionIndex}` off of `botSeedBase` — the same
 * derivation loss-mining.ts's mineLosses uses per candidate decision (file
 * doc comment's "anchor derivation" note) — so scoring never depends on
 * probe order, and scoring the same anchor+seed base that produced the
 * probe bank reproduces its anchorChoiceKey exactly (agreementRate 1.0).
 */
export function scoreAgainstProbes(
  adapter: AnyGameAdapter,
  botFactory: AnyBotFactory,
  probes: readonly ProbePosition[],
  botSeedBase: number,
): ProbeScore {
  const rootRng = createRng(botSeedBase);
  let agreements = 0;
  let skipped = 0;

  for (const probe of probes) {
    let state = adapter.createInitialState(probe.gameSeed);
    let reachedDecider = true;

    for (const choiceKey of probe.choicePrefix) {
      const decision = adapter.currentDecision(state);
      if (!decision) {
        reachedDecider = false;
        break;
      }
      const legal = adapter.getLegalChoices(state);
      const matched = legal.find((candidate) => adapter.encodeChoice(candidate) === choiceKey);
      if (matched === undefined) {
        reachedDecider = false;
        break;
      }
      state = adapter.applyChoice(state, matched);
    }

    if (!reachedDecider) {
      skipped += 1;
      continue;
    }

    const decision = adapter.currentDecision(state);
    if (!decision || decision.player !== probe.deciderSeat) {
      skipped += 1;
      continue;
    }
    const legal = adapter.getLegalChoices(state);
    if (legal.length === 0) {
      skipped += 1;
      continue;
    }

    const observation = adapter.getObservation(state, decision.player);
    const probeSeed = rootRng.fork(`${probe.gameSeed}:${probe.decisionIndex}`).nextInt(BOT_SEED_SPACE);
    const bot = botFactory(probeSeed);
    let choice: unknown;
    try {
      choice = bot.decide(decision.decisionPoint, observation, legal);
    } catch {
      skipped += 1;
      continue;
    }
    const choiceKey = adapter.encodeChoice(choice);
    if (choiceKey === probe.anchorChoiceKey) {
      agreements += 1;
    }
  }

  const scored = probes.length - skipped;
  return {
    probes: probes.length,
    agreements,
    agreementRate: scored > 0 ? agreements / scored : 0,
    skipped,
  };
}
