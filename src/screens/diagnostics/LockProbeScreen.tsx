import { useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Check, Play, Square, X } from 'lucide-react-native';
import {
  useWalletBalance,
  useWalletExitBatch,
  useWalletList,
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
  /** Absolute time the call STARTED, so offsets survive a late joinAt. */
  t: number;
  ms: number;
  ok: boolean;
  detail: string;
};

type Phase = 'idle' | 'baseline' | 'probing' | 'done';

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
  const [outpoint, setOutpoint] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [samples, setSamples] = useState<Sample[]>([]);
  const [joinAt, setJoinAt] = useState(0);
  const [settledAt, setSettledAt] = useState(0);
  const [joinNote, setJoinNote] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  // Bumped to cancel: the loop compares it against the id it started with, so a
  // stop takes effect at the next iteration even mid-call.
  const runIdRef = useRef(0);
  // The loop closes over one render's balance, so it reads the live value
  // through a ref instead. Settlement is the loop's own exit condition.
  const balanceRef = useRef(balance);
  balanceRef.current = balance;

  const cfg = MODES[mode];
  const vtxos = listData?.vtxos?.vtxos ?? [];
  const running = phase === 'baseline' || phase === 'probing';

  const loadVtxos = () => {
    void list({ view: 'vtxos' }).catch(() => undefined);
  };

  // One timed invoice. Never throws: a failed call is a data point, not an
  // error, and the run must continue past it to see whether receive recovers.
  const probeOnce = async (): Promise<Sample> => {
    const started = Date.now();
    try {
      const res = await receive({
        amountSat: PROBE_AMOUNT_SAT,
        memo: 'L2 lock probe',
      });

      return {
        t: started,
        ms: Date.now() - started,
        ok: true,
        detail: res.entry?.id ? shortKey(res.entry.id, 6, 4) : 'invoice',
      };
    } catch (e) {
      return {
        t: started,
        ms: Date.now() - started,
        ok: false,
        detail: errorMessage(e),
      };
    }
  };

  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const run = async () => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const live = () => runIdRef.current === runId;

    setSamples([]);
    setJoinAt(0);
    setSettledAt(0);
    setJoinNote('');
    setError('');
    setPhase('baseline');

    // Baseline: what does receive cost when nothing else is happening?
    for (let i = 0; i < BASELINE_SAMPLES && live(); i += 1) {
      const sample = await probeOnce();
      if (!live()) {
        return;
      }

      setSamples((prev) => [...prev, sample]);
      await wait(cfg.intervalMs);
    }

    if (!live()) {
      return;
    }

    // The exit adds its value to pending_out. Settlement is that addition
    // going away again, so the level before the exit is the reference point.
    const pendingOutBefore = pendingOutSat(balanceRef.current);

    // Start the round join WITHOUT awaiting it. Awaiting would serialise the
    // probe behind the very call it is meant to run alongside, which would
    // manufacture the blocking it is trying to detect.
    const startedAt = Date.now();
    setJoinAt(startedAt);
    setPhase('probing');
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

    // pending_out has to be seen RISING before a fall can mean anything. The
    // balance lags the exit call by a poll, so without this the first reading
    // still shows the pre-exit level and would count as an instant settlement.
    let sawRise = false;
    let settled = 0;

    while (live() && Date.now() - startedAt < cfg.capMs) {
      // Stop once the round has executed and the tail has been collected. The
      // tail is the point of long mode: latency AFTER settlement is what says
      // whether the wallet was held during the round or merely after it.
      if (cfg.tailMs > 0 && settled > 0 && Date.now() - settled >= cfg.tailMs) {
        break;
      }

      const sample = await probeOnce();
      if (!live()) {
        return;
      }

      setSamples((prev) => [...prev, sample]);

      const out = pendingOutSat(balanceRef.current);
      if (out > pendingOutBefore) {
        sawRise = true;
      } else if (sawRise && settled === 0) {
        settled = Date.now();
        setSettledAt(settled);
      }

      // Refresh without awaiting: the balance must stay current for the check
      // above, but blocking the probe on it would distort the interval.
      void refresh().catch(() => undefined);
      await wait(cfg.intervalMs);
    }

    if (live()) {
      setPhase('done');
    }
  };

  const stop = () => {
    runIdRef.current += 1;
    setPhase('done');
  };

  const start = () => {
    if (!outpoint) {
      setError('Select a VTXO to exit. That exit is what joins the round.');
      return;
    }

    setConfirm(true);
  };

  // Split on joinAt rather than on array position: the baseline count is a
  // constant today, but a cancelled baseline would otherwise mislabel rows.
  const baseline = samples.filter((s) => joinAt === 0 || s.t < joinAt);
  const during = samples.filter((s) => joinAt > 0 && s.t >= joinAt);
  const worstBaseline = baseline.reduce((m, s) => Math.max(m, s.ms), 0);
  const worstDuring = during.reduce((m, s) => Math.max(m, s.ms), 0);
  const failedDuring = during.filter((s) => !s.ok).length;
  const blocked = worstDuring >= FAIL_THRESHOLD_MS || failedDuring > 0;
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
            This spends the selected VTXO and creates up to{' '}
            {Math.ceil(cfg.capMs / cfg.intervalMs) + BASELINE_SAMPLES} unpaid
            invoices, each a real activity entry memoed "L2 lock probe". Expect
            fewer: the interval is measured from the end of each call, and long
            mode stops as soon as the round settles. The invoices cost nothing.
            The exit does.
          </Text>
        </View>
        {error ? <InlineError message={error} /> : null}
        <View style={styles.actions}>
          {running ? (
            <PrimaryButton onPress={stop} icon={Square}>
              Stop
            </PrimaryButton>
          ) : (
            <PrimaryButton onPress={start} icon={Play} disabled={!outpoint}>
              Start probe
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
                    }, against ${(worstBaseline / 1000).toFixed(1)}s idle. This is the bark failure.`
                  : `Worst call during the round took ${(worstDuring / 1000).toFixed(1)}s, against ${(worstBaseline / 1000).toFixed(1)}s idle. No call came near the ${FAIL_THRESHOLD_MS / 1000}s threshold.`}
                {settledAt > 0
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
            {joinNote ? <SummaryRow label="Round join" value={joinNote} /> : null}
            <SummaryRow
              label="Round settled"
              value={
                settledAt > 0
                  ? `+${((settledAt - joinAt) / 1000).toFixed(0)}s after join`
                  : running
                    ? 'waiting'
                    : 'not observed'
              }
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
            const slow = s.ms >= FAIL_THRESHOLD_MS;
            const isSettled = settledSample?.t === s.t;

            return (
              <View
                key={s.t}
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
                  {s.ms} ms
                </Text>
                <Text
                  style={[
                    styles.cell,
                    styles.colResult,
                    !s.ok && { color: palette.bad },
                  ]}
                  numberOfLines={1}
                >
                  {isSettled ? 'settled — ' : ''}
                  {s.ok ? s.detail : `failed: ${s.detail}`}
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
