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
 */

import type { AnyBotFactory, AnyGameAdapter } from '../contract/types';
import type { MatchTrajectoryRecord } from './paired-match';
import type { LossDivergence, LossReport } from './loss-mining';

export interface ProbePosition {
  /** Stable key: `${gameSeed}-${decisionIndex}`. */
  readonly probeId: string;
  readonly gameSeed: number;
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
      choicePrefix: record.choices.slice(0, divergence.decisionIndex),
      deciderSeat: record.candidateSeat,
      decisionPointId: divergence.decisionPointId,
      anchorChoiceKey: divergence.anchorChoiceKey,
      sourceAnchorId,
    });
  }

  probes.sort((a, b) => decisionIndexOfProbeId(a.probeId) - decisionIndexOfProbeId(b.probeId));

  const maxProbes = options?.maxProbes;
  if (maxProbes === undefined || probes.length <= maxProbes) {
    return probes;
  }
  return probes.slice(0, maxProbes);
}

function probeIdOf(divergence: LossDivergence): string {
  return `${divergence.gameSeed}-${divergence.decisionIndex}`;
}

function decisionIndexOfProbeId(probeId: string): number {
  const parsed = Number(probeId.slice(probeId.lastIndexOf('-') + 1));
  return Number.isFinite(parsed) ? parsed : 0;
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
 * The bot is rebuilt once per probe from `botSeedBase` so scoring never
 * depends on probe order.
 */
export function scoreAgainstProbes(
  adapter: AnyGameAdapter,
  botFactory: AnyBotFactory,
  probes: readonly ProbePosition[],
  botSeedBase: number,
): ProbeScore {
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
    const bot = botFactory(botSeedBase);
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
