import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertFeedbackAnchor,
  loadProbeBank,
  loadTrajectories,
  saveProbeBank,
  saveTrajectories,
} from '../trajectory-archive';
import type { BenchmarkAnchor } from '../baseline-registry';
import type { MatchTrajectoryRecord } from '../../loop/paired-match';
import type { ProbePosition } from '../../loop/probe-bank';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'loop-forge-trajectory-archive-'));
}

const RECORD_A: MatchTrajectoryRecord = {
  gameSeed: 5,
  seatingIndex: 0,
  candidateSeat: 0,
  seats: ['candidate', 'opponent'],
  choices: ['0', '9', '0', '9'],
  deciders: [0, 1, 0, 1],
  outcome: { winner: 1, scores: [0, 18] },
};

const RECORD_B: MatchTrajectoryRecord = {
  gameSeed: 6,
  seatingIndex: 1,
  candidateSeat: 1,
  seats: ['opponent', 'candidate'],
  choices: ['9', '0', '9', '0'],
  deciders: [0, 1, 0, 1],
  outcome: { winner: 0, scores: [18, 0] },
};

describe('saveTrajectories / loadTrajectories', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a list of records through JSONL', () => {
    dir = makeTempRoot();
    const filePath = saveTrajectories(dir, [RECORD_A, RECORD_B]);
    expect(filePath).toBe(join(dir, 'trajectories.jsonl'));
    const loaded = loadTrajectories(filePath);
    expect(loaded).toEqual([RECORD_A, RECORD_B]);
  });

  it('round-trips an empty list', () => {
    dir = makeTempRoot();
    const filePath = saveTrajectories(dir, []);
    expect(loadTrajectories(filePath)).toEqual([]);
  });

  it('creates the target directory if missing', () => {
    dir = makeTempRoot();
    const nested = join(dir, 'nested', 'deeper');
    const filePath = saveTrajectories(nested, [RECORD_A]);
    expect(loadTrajectories(filePath)).toEqual([RECORD_A]);
  });
});

// GAP-11 D3: holdout anchors must never feed the design loop, including
// through the trajectory archive.
const FEEDBACK_ANCHOR: BenchmarkAnchor = { anchorId: 'l2-opus', kind: 'external', role: 'feedback' };
const HOLDOUT_ANCHOR: BenchmarkAnchor = { anchorId: 'l3-opus', kind: 'external', role: 'holdout' };

describe('assertFeedbackAnchor', () => {
  it('passes for a feedback anchor', () => {
    expect(() => assertFeedbackAnchor(FEEDBACK_ANCHOR)).not.toThrow();
  });

  it('passes for a non-external anchor (no role)', () => {
    expect(() => assertFeedbackAnchor({ anchorId: 'heuristic-anchor', kind: 'heuristic' })).not.toThrow();
  });

  it('throws for a holdout anchor', () => {
    expect(() => assertFeedbackAnchor(HOLDOUT_ANCHOR)).toThrow(/holdout anchors are for/);
  });
});

describe('saveTrajectories — holdout anchor gate (GAP-11 D3)', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when sourceAnchor is a holdout anchor, without writing anything', () => {
    dir = makeTempRoot();
    const target = join(dir, 'never-created');
    expect(() => saveTrajectories(target, [RECORD_A], HOLDOUT_ANCHOR)).toThrow(/holdout anchors are for/);
  });

  it('succeeds when sourceAnchor is a feedback anchor', () => {
    dir = makeTempRoot();
    const filePath = saveTrajectories(dir, [RECORD_A], FEEDBACK_ANCHOR);
    expect(loadTrajectories(filePath)).toEqual([RECORD_A]);
  });

  it('preserves existing behavior when sourceAnchor is omitted', () => {
    dir = makeTempRoot();
    const filePath = saveTrajectories(dir, [RECORD_A]);
    expect(loadTrajectories(filePath)).toEqual([RECORD_A]);
  });
});

const PROBE_A: ProbePosition = {
  probeId: '5-0',
  gameSeed: 5,
  decisionIndex: 0,
  choicePrefix: [],
  deciderSeat: 0,
  decisionPointId: 'pick',
  anchorChoiceKey: '9',
  sourceAnchorId: 'anchor-v1',
};

const PROBE_B: ProbePosition = {
  probeId: '6-1',
  gameSeed: 6,
  decisionIndex: 1,
  choicePrefix: ['9'],
  deciderSeat: 1,
  decisionPointId: 'pick',
  anchorChoiceKey: '0',
  sourceAnchorId: 'anchor-v1',
};

describe('saveProbeBank / loadProbeBank', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a probe bank, sealed with a sha256 digest', () => {
    dir = makeTempRoot();
    const filePath = join(dir, 'probe-bank.json');
    saveProbeBank(filePath, [PROBE_A, PROBE_B]);
    expect(loadProbeBank(filePath)).toEqual([PROBE_A, PROBE_B]);
  });

  it('throws when the file has been tampered with after sealing', () => {
    dir = makeTempRoot();
    const filePath = join(dir, 'probe-bank.json');
    saveProbeBank(filePath, [PROBE_A, PROBE_B]);

    const tampered = JSON.parse(readFileSync(filePath, 'utf8')) as {
      probes: ProbePosition[];
      seal: string;
    };
    tampered.probes[0] = { ...(tampered.probes[0] as ProbePosition), anchorChoiceKey: '5' };
    writeFileSync(filePath, JSON.stringify(tampered, null, 2), 'utf8');

    expect(() => loadProbeBank(filePath)).toThrow(/seal mismatch/);
  });
});

describe('saveProbeBank — holdout anchor gate (GAP-11 D3)', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when sourceAnchor is a holdout anchor, without writing anything', () => {
    dir = makeTempRoot();
    const filePath = join(dir, 'never-created.json');
    expect(() => saveProbeBank(filePath, [PROBE_A], HOLDOUT_ANCHOR)).toThrow(/holdout anchors are for/);
  });

  it('succeeds when sourceAnchor is a feedback anchor', () => {
    dir = makeTempRoot();
    const filePath = join(dir, 'probe-bank.json');
    saveProbeBank(filePath, [PROBE_A], FEEDBACK_ANCHOR);
    expect(loadProbeBank(filePath)).toEqual([PROBE_A]);
  });

  it('preserves existing behavior when sourceAnchor is omitted', () => {
    dir = makeTempRoot();
    const filePath = join(dir, 'probe-bank.json');
    saveProbeBank(filePath, [PROBE_A]);
    expect(loadProbeBank(filePath)).toEqual([PROBE_A]);
  });
});
