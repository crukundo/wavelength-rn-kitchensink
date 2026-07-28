import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Check, Play, Square, X } from 'lucide-react-native';
import {
  useWalletBalance,
  useWalletExitBatch,
  useWalletList,
  useWalletLogs,
  useWalletReceive,
  useWalletRefresh,
} from '@lightninglabs/wavelength-react';
import { PageHead } from '../../components/layout/PageHead';
import { AppTab } from '../../components/layout/nav';
import { Band } from '../../components/ui/Band';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { GhostButton, PrimaryButton } from '../../components/ui/Button';
import { InlineError } from '../../components/ui/InlineError';
import { Label } from '../../components/ui/Label';
import { Segmented } from '../../components/ui/Segmented';
import { SummaryRow } from '../../components/ui/SummaryRow';
import { pendingOutSat } from '../../lib/balance';
import { errorMessage } from '../../lib/errors';
import { formatSats, shortKey } from '../../lib/format';
import { Palette, fonts } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeProvider';
import { useThemedStyles } from '../../theme/useThemedStyles';

// Test L2 asks whether joining a server round can block invoice creation, the
// way bark's maintenance() held the wallet lock and stopped users receiving.
//
// The SDK exposes no refresh RPC, so a round join cannot be requested directly.
// The one operation a client can start on demand that does round work is a
// cooperative exit: "A cooperative batch queues each outpoint into the next
// round" (wavelength-core exit.d.ts:5), and again at :86. That is the trigger.
//
// Read the caveat before quoting a result: this measures whether ROUND WORK
// blocks receive, using the cooperative-exit path to get into a round. The
// automatic refresh at the needs_refresh threshold is a different caller into
// (probably) the same round machinery, and cannot be triggered on demand. A
// clean run is evidence that receive is not serialised behind a round; it is
// not proof that the refresh path behaves identically.

// Probe invoices are never paid, so they cost nothing, but each one is a real
// activity entry. 1,000 sats is the amount R1 already passed on repeatedly, so
// a failure here is about timing rather than about the amount.
const PROBE_AMOUNT_SAT = 1000;

// Idle invoices taken before the round starts. Without them a slow call during
// the round proves nothing: this operator may simply be slow.
const BASELINE_SAMPLES = 3;

// The L2 pass condition: anything longer reproduces the bark failure.
const FAIL_THRESHOLD_MS = 30_000;

// Calls go out on a fixed cadence and are NOT awaited, so one hung call no
// longer stops the probe. That is the point. Run 1's ten-minute block was
// measured by a serial loop, so nothing else was attempted while it hung and
// the run cannot say what was actually blocked. A second call that starts
// during a stall and returns normally means one lost response. Every
// overlapping call stalling means the wallet itself was held, which is the
// bark failure.
//
// Capped so the probe cannot manufacture its own contention: at a 10s interval
// a ten-minute stall would otherwise leave 60 invoice calls outstanding, which
// is a load test, not a lock test. A skipped slot is counted, not dropped
// silently.
const MAX_IN_FLIGHT = 4;

// Settlement runs on its own clock. It used to be checked only after a sample
// returned, so the earliest run 1 could stamp settlement was the moment the
// block cleared — the round settling "exactly when the block cleared" was the
// instrument, not a finding. This poll is independent of the samples.
const SETTLE_POLL_MS = 5_000;

// How often the in-flight drain re-checks, and how often the screen re-reads
// the clock so a call that has been outstanding for minutes still ticks up.
const DRAIN_POLL_MS = 250;
const CLOCK_MS = 1_000;

type Mode = 'fast' | 'long';

// The first run of L2 used fast, and its limit is why long exists. exitBatch
// queues the exit and returns in about 0.1s, so a 90 second window can end with
// the round still not executed — as it did on 24 July 2026, where the exit was
// still outgoing three minutes later. Fast shows whether WAITING for a round
// blocks receive. Long runs until the exit actually settles, which is the only
// way to see the round EXECUTE.
//
// Long trades resolution for reach: at a 10s interval a lock held for the 30s
// that matters here is still caught several times over, while the invoice count
// stays survivable over half an hour.
const MODES: Record<
  Mode,
  { label: string; intervalMs: number; capMs: number; tailMs: number }
> = {
  fast: { label: 'Fast', intervalMs: 3_000, capMs: 90_000, tailMs: 0 },
  long: {
    label: 'Long',
    intervalMs: 10_000,
    capMs: 30 * 60_000,
    tailMs: 60_000,
  },
};

type Sample = {
  /** Monotonic per run: completions no longer arrive in start order. */
  id: number;
  /** Absolute time the call STARTED, so offsets survive a late joinAt. */
  t: number;
  /** null while the call is still outstanding. */
  ms: number | null;
  /** null while outstanding. */
  ok: boolean | null;
  detail: string;
  /** Calls already outstanding when this one started. 0 means it ran alone. */
  overlap: number;
};

type LogLine = {
  /** Stamped on arrival: WavelengthLogPayload carries no time of its own. */
  t: number;
  level: string;
  message: string;
};

// draining is the window after the last call is dispatched, when the run is
// waiting on whatever is still outstanding. A stall caught at the end of the
// window is the most interesting sample in the run, so it is waited out rather
// than truncated.
type Phase = 'idle' | 'baseline' | 'probing' | 'draining' | 'done';

const makeStyles = (p: Palette) => ({
  intro: {
    color: p.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 12,
  },
  rows: {
    gap: 10,
    marginTop: 12,
  },
  modeRow: {
    alignItems: 'center' as const,
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    marginTop: 12,
  },
  modeLabel: {
    color: p.text,
    fontFamily: fonts.sansMedium,
    fontSize: 14,
  },
  vtxo: {
    alignItems: 'center' as const,
    borderColor: p.border,
    borderWidth: 1,
    flexDirection: 'row' as const,
    gap: 12,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  vtxoOn: {
    backgroundColor: p.well,
    borderColor: p.accent,
  },
  vtxoBody: {
    flex: 1,
  },
  vtxoAmount: {
    color: p.text,
    fontFamily: fonts.monoMedium,
    fontSize: 14,
  },
  vtxoOutpoint: {
    color: p.muted,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginTop: 2,
  },
  warn: {
    backgroundColor: p.warnSoft,
    borderColor: p.warn,
    borderWidth: 1,
    marginTop: 16,
    padding: 12,
  },
  warnText: {
    color: p.text,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
  },
  actions: {
    gap: 12,
    marginTop: 16,
  },
  verdict: {
    borderWidth: 1,
    marginTop: 12,
    padding: 12,
  },
  verdictHead: {
    alignItems: 'center' as const,
    flexDirection: 'row' as const,
    gap: 8,
  },
  verdictTitle: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
  },
  verdictBody: {
    color: p.text,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
  },
  tableHead: {
    borderColor: p.border,
    borderBottomWidth: 1,
    flexDirection: 'row' as const,
    marginTop: 16,
    paddingBottom: 6,
  },
  row: {
    borderColor: p.border,
    borderBottomWidth: 1,
    flexDirection: 'row' as const,
    paddingVertical: 7,
  },
  rowBaseline: {
    backgroundColor: p.surfaceAlt,
  },
  rowSettled: {
    backgroundColor: p.goodSoft,
  },
  cellHead: {
    color: p.muted,
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: 'uppercase' as const,
  },
  cell: {
    color: p.text,
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  colAt: {
    width: 74,
  },
  colMs: {
    width: 84,
  },
  colResult: {
    flex: 1,
  },
});

// LockProbeScreen runs test L2: it starts a round join and measures how long
// invoice creation takes while that round is in flight.
export function LockProbeScreen({
  onNavigate,
}: {
  onNavigate: (tab: AppTab) => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { receive } = useWalletReceive();
  const { refresh } = useWalletRefresh();
  const { exitBatch } = useWalletExitBatch();
  const { list, listData, listPending, listError } = useWalletList();
  const balance = useWalletBalance();
  const [mode, setMode] = useState<Mode>('long');
  // Control mode probes without joining a round: no exit, no VTXO spent. Run
  // it on a second wallet alongside a real run to tell the two candidate
  // causes apart. A second wallet is a separate app container, so a separate
  // daemon and a separate lock, but the same operator and swap server. If the
  // real run blocks and the control does not, the wait is inside the blocked
  // wallet's own process. If both block at the same moment, it is the operator.
  const [control, setControl] = useState(false);
  const [outpoint, setOutpoint] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [samples, setSamples] = useState<Sample[]>([]);
  const [joinAt, setJoinAt] = useState(0);
  const [settledAt, setSettledAt] = useState(0);
  const [joinNote, setJoinNote] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  // Re-read every second while a run is live, so a call that has been
  // outstanding for minutes shows its elapsed time instead of leaving the
  // screen looking frozen — which is exactly what run 1 looked like.
  const [nowMs, setNowMs] = useState(0);
  // Bumped to cancel: the loop compares it against the id it started with, so a
  // stop takes effect at the next iteration even mid-call.
  const runIdRef = useRef(0);
  // Calls outstanding right now, and the most ever outstanding at once. The
  // second number is what says whether a clean run actually tested overlap or
  // simply never had two calls in flight.
  const inFlightRef = useRef(0);
  const maxInFlightRef = useRef(0);
  const sampleIdRef = useRef(0);
  const skippedRef = useRef(0);
  // Written by the settlement watcher, read by the dispatch loop's exit
  // condition. A ref because both run outside React's render cycle.
  const settledRef = useRef(0);
  const pendingOutBeforeRef = useRef(0);
  // The loop closes over one render's balance, so it reads the live value
  // through a ref instead. Settlement is the loop's own exit condition.
  const balanceRef = useRef(balance);
  balanceRef.current = balance;

  // SDK-level log capture. Note what this is NOT: it carries nothing from the
  // Go daemon. Every 'log' event the SDK emits is its own diagnostic — a
  // throwing subscriber, an unparseable activity entry, a failed stream close,
  // an unknown native event (wavelength-core base-client.js:123,
  // wavelength-react-native client.js:86). The daemon's own logging, whatever
  // debugLevel is set to, reaches neither this buffer nor os_log nor any file
  // in its data directory, so it cannot be read from this harness at all.
  //
  // Still worth capturing: if a receive blocks for ten minutes and the SDK
  // drops an activity entry or loses the stream in that window, this is the
  // only place that would show. An empty capture is itself a result.
  //
  // The buffer is a 200-line tail (engine/constants.js MAX_LOGS) carrying no
  // timestamps, so lines are stamped on arrival and copied out before they
  // roll off.
  const { logs } = useWalletLogs();
  const logStoreRef = useRef<LogLine[]>([]);
  const lastLogKeyRef = useRef<string | null>(null);
  const logGapsRef = useRef(0);

  useEffect(() => {
    if (logs.length === 0) {
      return;
    }

    const key = (l: { level: string; message: string }) =>
      `${l.level} ${l.message}`;
    const prev = lastLogKeyRef.current;
    let from = 0;

    if (prev !== null) {
      // Find where the previously captured tail ends inside the new buffer.
      // Searching from the back matters: a repeated message would otherwise
      // match an older copy and re-capture everything after it.
      let found = -1;
      for (let i = logs.length - 1; i >= 0; i -= 1) {
        if (key(logs[i]) === prev) {
          found = i;
          break;
        }
      }

      if (found === -1) {
        // The buffer rolled past everything we had. Lines were lost; record
        // that rather than pretending the capture is continuous.
        logGapsRef.current += 1;
      } else {
        from = found + 1;
      }
    }

    if (from < logs.length) {
      const now = Date.now();
      for (let i = from; i < logs.length; i += 1) {
        logStoreRef.current.push({
          t: now,
          level: logs[i].level,
          message: logs[i].message,
        });
      }
      lastLogKeyRef.current = key(logs[logs.length - 1]);
    }
  }, [logs]);

  const cfg = MODES[mode];
  const vtxos = listData?.vtxos?.vtxos ?? [];
  const running =
    phase === 'baseline' || phase === 'probing' || phase === 'draining';

  const loadVtxos = () => {
    void list({ view: 'vtxos' }).catch(() => undefined);
  };

  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // Start one timed invoice and return immediately. Never throws: a failed call
  // is a data point, not an error, and the run must continue past it to see
  // whether receive recovers. The sample is recorded at dispatch and completed
  // in place, so an outstanding call is visible while it is still hanging.
  const dispatch = (live: () => boolean) => {
    if (inFlightRef.current >= MAX_IN_FLIGHT) {
      skippedRef.current += 1;
      return;
    }

    const id = sampleIdRef.current + 1;
    sampleIdRef.current = id;
    const started = Date.now();
    const overlap = inFlightRef.current;
    inFlightRef.current += 1;
    maxInFlightRef.current = Math.max(maxInFlightRef.current, inFlightRef.current);
    setSamples((prev) => [
      ...prev,
      { id, t: started, ms: null, ok: null, detail: '', overlap },
    ]);

    const finish = (ok: boolean, detail: string) => {
      // A call left over from a cancelled run must not decrement this run's
      // counter, which was reset to zero when the run started.
      if (!live()) {
        return;
      }

      inFlightRef.current -= 1;
      setSamples((prev) =>
        prev.map((s) =>
          s.id === id ? { ...s, ms: Date.now() - started, ok, detail } : s,
        ),
      );
    };

    void receive({ amountSat: PROBE_AMOUNT_SAT, memo: 'L2 lock probe' })
      .then((res) =>
        finish(true, res.entry?.id ? shortKey(res.entry.id, 6, 4) : 'invoice'),
      )
      .catch((e) => finish(false, errorMessage(e)));
  };

  // Wait for every outstanding call to return. Deliberately unbounded: if a
  // call is stalled when the window ends, how long it stalls for is the result.
  // Stop ends the wait.
  const drainInFlight = async (live: () => boolean) => {
    while (live() && inFlightRef.current > 0) {
      await wait(DRAIN_POLL_MS);
    }
  };

  // Settlement on its own clock, independent of the samples. The exit adds its
  // value to pending_out, so settlement is that addition going away again, and
  // the level before the exit is the reference point. pending_out has to be
  // seen RISING first: the balance lags the exit call by a poll, so without
  // that the first reading still shows the pre-exit level and would count as an
  // instant settlement.
  //
  // A control run has no settlement to find but still polls, so that both
  // wallets make the same background calls and their timelines stay comparable.
  const watchSettlement = async (live: () => boolean) => {
    let sawRise = false;

    while (live() && (control || settledRef.current === 0)) {
      // Not awaited: the watcher's cadence must not depend on how long a
      // balance refresh takes.
      void refresh().catch(() => undefined);
      await wait(SETTLE_POLL_MS);

      if (!live()) {
        return;
      }

      if (control) {
        continue;
      }

      const out = pendingOutSat(balanceRef.current);
      if (out > pendingOutBeforeRef.current) {
        sawRise = true;
      } else if (sawRise) {
        settledRef.current = Date.now();
        setSettledAt(settledRef.current);
      }
    }
  };

  const run = async () => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const live = () => runIdRef.current === runId;
    // Stop bumps runId, which ends everything. A run that ends on its own does
    // not, so the watcher needs this too — otherwise a control run, which never
    // sees a settlement, would keep polling the balance after the run is over.
    let finished = false;

    setSamples([]);
    setJoinAt(0);
    setSettledAt(0);
    setJoinNote('');
    setError('');
    setPhase('baseline');
    logStoreRef.current = [];
    logGapsRef.current = 0;
    lastLogKeyRef.current = null;
    inFlightRef.current = 0;
    maxInFlightRef.current = 0;
    sampleIdRef.current = 0;
    skippedRef.current = 0;
    settledRef.current = 0;

    // Baseline: what does receive cost when nothing else is happening? Drained
    // between calls, so "nothing else in flight" stays literally true — the
    // in-round samples are the ones meant to overlap.
    for (let i = 0; i < BASELINE_SAMPLES && live(); i += 1) {
      dispatch(live);
      await drainInFlight(live);

      if (!live()) {
        return;
      }

      await wait(cfg.intervalMs);
    }

    if (!live()) {
      return;
    }

    pendingOutBeforeRef.current = pendingOutSat(balanceRef.current);

    const startedAt = Date.now();
    setJoinAt(startedAt);
    setPhase('probing');

    void watchSettlement(() => live() && !finished);

    if (control) {
      // No round, no exit, nothing spent. Everything below still runs, so the
      // two wallets produce directly comparable timelines.
      setJoinNote('Control run — no round joined');
    } else {
      // Start the round join WITHOUT awaiting it. Awaiting would serialise the
      // probe behind the very call it is meant to run alongside, which would
      // manufacture the blocking it is trying to detect.
      void exitBatch({ mode: 'cooperative', outpoints: [outpoint] })
        .then((res) => {
          const started = res.started.length > 0;
          setJoinNote(
            `${started ? 'Queued into a round' : 'Not started'} after ${
              ((Date.now() - startedAt) / 1000).toFixed(1)
            }s${res.stoppedBy ? ` — stopped: ${res.stoppedBy.reason}` : ''}`,
          );
        })
        .catch((e) => setJoinNote(`Exit call failed: ${errorMessage(e)}`));
    }

    // Fixed cadence, measured start to start. Nothing here awaits a call, so a
    // stalled invoice does not hold up the next one.
    while (live() && Date.now() - startedAt < cfg.capMs) {
      // Stop once the round has executed and the tail has been collected. The
      // tail is the point of long mode: latency AFTER settlement is what says
      // whether the wallet was held during the round or merely after it.
      if (
        cfg.tailMs > 0 &&
        settledRef.current > 0 &&
        Date.now() - settledRef.current >= cfg.tailMs
      ) {
        break;
      }

      dispatch(live);
      await wait(cfg.intervalMs);
    }

    if (!live()) {
      return;
    }

    setPhase('draining');
    await drainInFlight(live);
    finished = true;

    if (live()) {
      setPhase('done');
    }
  };

  const stop = () => {
    runIdRef.current += 1;
    setPhase('done');
  };

  const start = () => {
    if (!control && !outpoint) {
      setError('Select a VTXO to exit. That exit is what joins the round.');
      return;
    }

    // A control run spends nothing, so there is nothing to confirm.
    if (control) {
      void run();
      return;
    }

    setConfirm(true);
  };

  // Tick the clock while a run is live so outstanding calls show their elapsed
  // time. Without it a ten-minute stall renders as a still screen, which is
  // indistinguishable from a crashed probe.
  useEffect(() => {
    if (!running) {
      return;
    }

    setNowMs(Date.now());
    const handle = setInterval(() => setNowMs(Date.now()), CLOCK_MS);

    return () => clearInterval(handle);
  }, [running]);

  // Publish the whole run on the global object so it can be pulled out of the
  // JS runtime over the Metro debugger. A 15 minute run produces far more
  // timing and log data than is readable by scrolling a phone screen, and
  // reading it back as one JSON blob avoids transcription mistakes in the
  // numbers that the evaluation then rests on.
  useEffect(() => {
    (globalThis as unknown as Record<string, unknown>).__l2probe = {
      mode,
      // Recorded because a control run and a round run are read side by side,
      // and the two objects are otherwise the same shape.
      control,
      phase,
      joinAt,
      settledAt,
      joinNote,
      samples,
      // Enough to reconstruct the schedule without reading this file.
      intervalMs: cfg.intervalMs,
      maxInFlight: MAX_IN_FLIGHT,
      settlePollMs: SETTLE_POLL_MS,
      maxInFlightSeen: maxInFlightRef.current,
      skipped: skippedRef.current,
      logs: logStoreRef.current,
      logGaps: logGapsRef.current,
    };
  }, [mode, control, cfg.intervalMs, phase, joinAt, settledAt, joinNote, samples]);

  // An outstanding call has no duration yet, so it counts as the time it has
  // been running. A call that has hung for five minutes is the finding, and
  // waiting for it to return before saying so would hide it.
  const clock = running && nowMs > 0 ? nowMs : Date.now();
  const took = (s: Sample) => s.ms ?? Math.max(0, clock - s.t);

  // Split on joinAt rather than on array position: the baseline count is a
  // constant today, but a cancelled baseline would otherwise mislabel rows.
  const baseline = samples.filter((s) => joinAt === 0 || s.t < joinAt);
  const during = samples.filter((s) => joinAt > 0 && s.t >= joinAt);
  const worstBaseline = baseline.reduce((m, s) => Math.max(m, took(s)), 0);
  const worstDuring = during.reduce((m, s) => Math.max(m, took(s)), 0);
  const failedDuring = during.filter((s) => s.ok === false).length;

  // A stall is what the run is hunting: a call over the threshold, or one that
  // failed outright. Both are counted while still outstanding.
  const stalls = during.filter(
    (s) => took(s) >= FAIL_THRESHOLD_MS || s.ok === false,
  );
  const blocked = stalls.length > 0;

  // The discrimination this probe exists for. Of the calls that started while
  // another call was stalled, how many were served normally? Some means the
  // wallet kept answering and one call lost its response. None means every
  // receive in that window was affected, which is the bark shape. And no
  // overlapping calls at all means this run cannot tell the two apart, which
  // has to be said rather than left to look like a pass.
  const overlapping = during.filter((s) =>
    stalls.some((st) => st.id !== s.id && s.t >= st.t && s.t <= st.t + took(st)),
  );
  const servedDuringStall = overlapping.filter(
    (s) => s.ok === true && took(s) < FAIL_THRESHOLD_MS,
  );
  const verdictColor = blocked ? palette.bad : palette.good;
  // The first sample at or after settlement, so the table can mark where the
  // round actually executed rather than leaving it to be inferred from a time.
  const settledSample = settledAt > 0 ? during.find((s) => s.t >= settledAt) : undefined;

  return (
    <ScrollView>
      <PageHead
        title="Lock probe"
        subtitle="Test L2 — can a round join block receive?"
        accent="orange"
        onBack={() => onNavigate('settings')}
      />

      <Band>
        <Label accent="orange" rule>
          What this measures
        </Label>
        <Text style={styles.intro}>
          Kesh shelved Ark partly because maintenance held the wallet lock and
          blocked invoice creation, so users could not receive. This starts a
          cooperative exit, which queues a VTXO into the next round, then times
          an invoice every {cfg.intervalMs / 1000} seconds. It takes{' '}
          {BASELINE_SAMPLES} idle readings first, because a slow call proves
          nothing without knowing what normal costs.
        </Text>
        <Text style={styles.intro}>
          Calls go out on the clock and are not waited for, up to{' '}
          {MAX_IN_FLIGHT} at once, so a call that hangs does not stop the next
          one. That is what separates the two ways receive can fail: if a call
          stalls and the calls started during it are still served, one response
          was lost. If they all stall, the wallet itself was held.
        </Text>
        <View style={styles.modeRow}>
          <Text style={styles.modeLabel}>Role</Text>
          <Segmented
            size="sm"
            value={control ? 'control' : 'round'}
            onChange={(v) => setControl(v === 'control')}
            options={[
              { value: 'round', label: 'Join round' },
              { value: 'control', label: 'Control' },
            ]}
          />
        </View>
        <Text style={styles.intro}>
          {control
            ? 'Control joins no round and spends nothing. Run it on the second wallet at the same time as a real run on the first. Both hit the same operator but each has its own daemon and its own lock, so if only the real run blocks, the wait is inside that wallet. If both block together, it is the operator.'
            : 'This wallet joins the round and pays for it with a VTXO.'}
        </Text>
        <View style={styles.modeRow}>
          <Text style={styles.modeLabel}>Window</Text>
          <Segmented
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'fast' as Mode, label: 'Fast' },
              { value: 'long' as Mode, label: 'Long' },
            ]}
          />
        </View>
        <Text style={styles.intro}>
          {mode === 'fast'
            ? 'Fast runs for 90 seconds. That shows whether waiting for a round blocks receive, but the round itself may not execute in the window — on 24 July it had not, three minutes later.'
            : 'Long keeps probing until the exit settles, then for another minute after. That is the only way to catch the round actually executing. It gives up after 30 minutes.'}
        </Text>
        <View style={styles.rows}>
          <SummaryRow label="Probe amount" value={`${formatSats(PROBE_AMOUNT_SAT)} sats`} />
          <SummaryRow label="Interval" value={`${cfg.intervalMs / 1000}s`} />
          <SummaryRow
            label="Gives up after"
            value={`${cfg.capMs / 60_000} min`}
          />
          <SummaryRow label="Fails at" value={`${FAIL_THRESHOLD_MS / 1000}s per call`} />
        </View>
      </Band>

      <Band tinted>
        <Label accent="teal" rule>
          VTXO to exit
        </Label>
        <Text style={styles.intro}>
          The exit is the trigger, not the subject. Its value leaves Ark and
          lands in the on-chain backing wallet, so pick the one you least mind
          moving — you will need to board it back to reuse it.
        </Text>
        {listError ? <InlineError message={errorMessage(listError)} /> : null}
        {vtxos.map((v) => {
          const on = v.outpoint === outpoint;

          return (
            <Pressable
              key={v.outpoint}
              onPress={() => setOutpoint(on ? '' : v.outpoint)}
              disabled={running}
              style={[styles.vtxo, on && styles.vtxoOn]}
              accessibilityRole="button"
              accessibilityLabel={`${formatSats(v.amountSat ?? 0)} sats`}
              accessibilityState={{ selected: on }}
            >
              <View style={styles.vtxoBody}>
                <Text style={styles.vtxoAmount}>
                  {formatSats(v.amountSat ?? 0)} sats
                </Text>
                <Text style={styles.vtxoOutpoint}>
                  {shortKey(v.outpoint, 12, 8)}
                </Text>
              </View>
              {on ? <Check size={16} color={palette.accent} /> : null}
            </Pressable>
          );
        })}
        <View style={styles.actions}>
          <GhostButton onPress={loadVtxos} busy={listPending} block>
            {vtxos.length > 0 ? 'Reload VTXOs' : 'Load VTXOs'}
          </GhostButton>
        </View>
      </Band>

      <Band>
        <Label accent="violet" rule>
          Run
        </Label>
        <View style={styles.warn}>
          <Text style={styles.warnText}>
            {control
              ? `Control run: no exit, no VTXO spent, nothing to undo. It creates unpaid invoices every ${cfg.intervalMs / 1000} seconds until you stop it or ${cfg.capMs / 60_000} minutes pass.`
              : null}
            {control ? null : 'This spends the selected VTXO and creates up to '}
            {control
              ? null
              : `${Math.ceil(cfg.capMs / cfg.intervalMs) + BASELINE_SAMPLES} unpaid invoices, each a real activity entry memoed "L2 lock probe". Long mode usually stops earlier, as soon as the round settles. The invoices cost nothing. The exit does.`}
          </Text>
        </View>
        {error ? <InlineError message={error} /> : null}
        <View style={styles.actions}>
          {running ? (
            <PrimaryButton onPress={stop} icon={Square}>
              Stop
            </PrimaryButton>
          ) : (
            <PrimaryButton
              onPress={start}
              icon={Play}
              disabled={!control && !outpoint}
            >
              {control ? 'Start control' : 'Start probe'}
            </PrimaryButton>
          )}
        </View>
      </Band>

      {samples.length > 0 ? (
        <Band tinted>
          <Label accent="lime" rule>
            Result
          </Label>

          {phase === 'done' && during.length > 0 ? (
            <View style={[styles.verdict, { borderColor: verdictColor }]}>
              <View style={styles.verdictHead}>
                {blocked ? (
                  <X size={16} color={verdictColor} />
                ) : (
                  <Check size={16} color={verdictColor} />
                )}
                <Text style={[styles.verdictTitle, { color: verdictColor }]}>
                  {blocked ? 'Receive was blocked' : 'Receive stayed responsive'}
                </Text>
              </View>
              <Text style={styles.verdictBody}>
                {blocked
                  ? `Worst call during the round took ${(worstDuring / 1000).toFixed(1)}s${
                      failedDuring > 0 ? `, and ${failedDuring} failed outright` : ''
                    }, against ${(worstBaseline / 1000).toFixed(1)}s idle.`
                  : `Worst call during the round took ${(worstDuring / 1000).toFixed(1)}s, against ${(worstBaseline / 1000).toFixed(1)}s idle. No call came near the ${FAIL_THRESHOLD_MS / 1000}s threshold.`}
                {blocked
                  ? overlapping.length === 0
                    ? ' No other call was in flight while it stalled, so this run cannot say whether the wallet was held or one response was lost.'
                    : servedDuringStall.length > 0
                      ? ` ${servedDuringStall.length} of ${overlapping.length} calls that started during the stall were served normally, so the wallet kept creating invoices throughout: this was a lost response on one call, not a wallet-wide lock.`
                      : ` All ${overlapping.length} calls that started during the stall were affected too, so receive was blocked wallet-wide. This is the bark failure.`
                  : ''}
                {control
                  ? ' Control run: no round was joined, so this measures receive with nothing of this wallet’s in flight.'
                  : settledAt > 0
                    ? ' The round executed inside the window, so this covers the round running and not only the wait for it.'
                    : ' The exit never settled inside the window, so this covers waiting for a round, not running one. Do not quote it as the whole of L2.'}
              </Text>
            </View>
          ) : null}

          <View style={styles.rows}>
            <SummaryRow
              label="Idle worst"
              value={baseline.length > 0 ? `${worstBaseline} ms` : '-'}
            />
            <SummaryRow
              label="In-round worst"
              value={during.length > 0 ? `${worstDuring} ms` : '-'}
            />
            <SummaryRow
              label="Calls"
              value={`${baseline.length} idle, ${during.length} in round`}
            />
            <SummaryRow
              label="Concurrency"
              value={`${maxInFlightRef.current} max in flight${
                skippedRef.current > 0
                  ? `, ${skippedRef.current} slots skipped at the cap`
                  : ''
              }`}
            />
            {stalls.length > 0 ? (
              <SummaryRow
                label="Served during stall"
                value={`${servedDuringStall.length} of ${overlapping.length} overlapping calls`}
              />
            ) : null}
            {joinNote ? <SummaryRow label="Round join" value={joinNote} /> : null}
            <SummaryRow
              label="Round settled"
              value={
                control
                  ? 'no round joined'
                  : settledAt > 0
                    ? `+${((settledAt - joinAt) / 1000).toFixed(0)}s after join, ±${SETTLE_POLL_MS / 1000}s`
                    : running
                      ? 'waiting'
                      : 'not observed'
              }
            />
            <SummaryRow
              label="Daemon log lines"
              value={`${logStoreRef.current.length}${
                logGapsRef.current > 0 ? `, ${logGapsRef.current} gaps` : ''
              }`}
            />
          </View>

          <View style={styles.tableHead}>
            <Text style={[styles.cellHead, styles.colAt]}>At</Text>
            <Text style={[styles.cellHead, styles.colMs]}>Took</Text>
            <Text style={[styles.cellHead, styles.colResult]}>Result</Text>
          </View>
          {samples.map((s) => {
            const isBaseline = joinAt === 0 || s.t < joinAt;
            const at = joinAt === 0 ? 0 : (s.t - joinAt) / 1000;
            const slow = took(s) >= FAIL_THRESHOLD_MS;
            const isSettled = settledSample?.id === s.id;

            return (
              <View
                key={s.id}
                style={[
                  styles.row,
                  isBaseline && styles.rowBaseline,
                  isSettled && styles.rowSettled,
                ]}
              >
                <Text style={[styles.cell, styles.colAt]}>
                  {isBaseline ? 'idle' : `+${at.toFixed(0)}s`}
                </Text>
                <Text
                  style={[
                    styles.cell,
                    styles.colMs,
                    slow && { color: palette.bad },
                  ]}
                >
                  {took(s)} ms
                </Text>
                <Text
                  style={[
                    styles.cell,
                    styles.colResult,
                    s.ok === false && { color: palette.bad },
                  ]}
                  numberOfLines={1}
                >
                  {isSettled ? 'settled — ' : ''}
                  {s.overlap > 0 ? `${s.overlap} in flight — ` : ''}
                  {s.ok === null
                    ? 'outstanding'
                    : s.ok
                      ? s.detail
                      : `failed: ${s.detail}`}
                </Text>
              </View>
            );
          })}
        </Band>
      ) : null}

      <ConfirmDialog
        open={confirm}
        title="Start the lock probe?"
        description={`This exits the selected VTXO cooperatively, moving its value out of Ark and into the on-chain wallet, and creates unpaid invoices until the exit settles or ${cfg.capMs / 60_000} minutes pass. The exit cannot be undone.`}
        confirmLabel="Start probe"
        destructive
        onConfirm={() => {
          setConfirm(false);
          void run();
        }}
        onCancel={() => setConfirm(false)}
      />
    </ScrollView>
  );
}
