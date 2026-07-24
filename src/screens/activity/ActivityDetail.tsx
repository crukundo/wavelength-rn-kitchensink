import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { X } from 'lucide-react-native';
import { Entry } from '@lightninglabs/wavelength-react';
import { CopyRow } from '../../components/ui/CopyRow';
import { Label } from '../../components/ui/Label';
import { formatSats, formatTimestampFull } from '../../lib/format';
import { Palette, fonts } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeProvider';
import { useThemedStyles } from '../../theme/useThemedStyles';

const KIND_LABEL: Record<string, string> = {
  receive: 'Received',
  send: 'Sent',
  deposit: 'Boarding deposit',
  exit: 'Unilateral exit',
};

// FAILURE_HINT translates the SDK's stable failure classification into the one
// sentence a user needs. The codes are wrapper-owned lowercase strings, so
// switching on them is safe across proto renumbering; failureReason remains the
// raw supplement and is shown verbatim alongside.
//
// needs_intervention is the only code meaning the wallet cannot resolve itself.
const FAILURE_HINT: Record<string, string> = {
  timed_out: 'The operation passed its deadline before reaching a final state.',
  expired: 'The swap expired before it was funded.',
  refunded: 'The payment was refunded back to this wallet.',
  needs_intervention:
    'This reached a state the wallet cannot resolve on its own and needs manual recovery.',
  failed: 'Terminal failure with no more specific classification.',
};

const makeStyles = (p: Palette) => ({
  // The backdrop is a sibling of the sheet, not its parent. Nesting the sheet
  // inside a Pressable makes that Pressable claim the touch responder and the
  // ScrollView never receives the pan, so the sheet renders its full content
  // but refuses to scroll.
  root: {
    flex: 1,
    justifyContent: 'flex-end' as const,
  },
  backdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  sheet: {
    backgroundColor: p.surface,
    borderColor: p.border,
    borderTopWidth: 1,
    maxHeight: '88%' as const,
  },
  hairline: {
    backgroundColor: p.accent,
    height: 1,
  },
  head: {
    alignItems: 'flex-start' as const,
    borderBottomWidth: 1,
    borderColor: p.border,
    flexDirection: 'row' as const,
    gap: 12,
    justifyContent: 'space-between' as const,
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  title: {
    color: p.text,
    fontFamily: fonts.sansSemiBold,
    fontSize: 18,
  },
  amount: {
    fontFamily: fonts.monoMedium,
    fontSize: 28,
    letterSpacing: -0.5,
    marginTop: 6,
  },
  amountUnit: {
    color: p.muted,
    fontFamily: fonts.mono,
    fontSize: 13,
  },
  close: {
    alignItems: 'center' as const,
    borderColor: p.border,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center' as const,
    width: 32,
  },
  status: {
    alignSelf: 'flex-start' as const,
    borderWidth: 1,
    marginTop: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  statusText: {
    fontFamily: fonts.sansMedium,
    fontSize: 9,
    letterSpacing: 0.8,
    textTransform: 'uppercase' as const,
  },
  body: {
    paddingBottom: 32,
  },
  section: {
    borderColor: p.border,
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  sectionBody: {
    gap: 14,
    marginTop: 16,
  },
  row: {
    alignItems: 'flex-start' as const,
    flexDirection: 'row' as const,
    gap: 16,
    justifyContent: 'space-between' as const,
  },
  rowLabel: {
    color: p.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
  },
  rowValue: {
    color: p.text,
    flexShrink: 1,
    fontFamily: fonts.mono,
    fontSize: 13,
    textAlign: 'right' as const,
  },
  failBox: {
    backgroundColor: p.badSoft,
    borderColor: p.bad,
    borderWidth: 1,
    gap: 8,
    marginTop: 16,
    padding: 12,
  },
  failHint: {
    color: p.text,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
  },
  failReason: {
    color: p.bad,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 18,
  },
});

// DetailRow is one short label/value pair. Long or copyable values use CopyRow
// instead, so nothing in this sheet is ever truncated.
function DetailRow({ label, value }: { label: string; value: string }) {
  const styles = useThemedStyles(makeStyles);

  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} selectable>
        {value}
      </Text>
    </View>
  );
}

// Section renders a titled block, or nothing when it has no populated fields.
// Every field on an Entry is best-effort, so an empty section means "the
// backing subsystem never supplied this", which is not worth a row of dashes.
function Section({
  title,
  accent,
  children,
}: {
  title: string;
  accent: 'teal' | 'violet' | 'sky' | 'orange' | 'lime';
  children: React.ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const items = Array.isArray(children) ? children.flat() : [children];
  if (!items.some(Boolean)) {
    return null;
  }

  return (
    <View style={styles.section}>
      <Label accent={accent} rule>
        {title}
      </Label>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

// ActivityDetail is the full record behind one activity row. The list is
// deliberately dense and truncates to a single line each; this sheet is the
// only place the complete Entry is visible, including the failure reason, the
// payment preimage (the proof a Lightning send actually paid) and the on-chain
// txid. Nothing here is truncated and every long value is copyable.
export function ActivityDetail({
  entry,
  onClose,
}: {
  entry: Entry | null;
  onClose: () => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(makeStyles);

  if (!entry) {
    return null;
  }

  // Mirror the list's treatment of a cooperative leave: the daemon uses one
  // 'exit' kind for both a cooperative on-chain send (which carries an on-chain
  // request) and a unilateral exit (which does not).
  const cooperativeSend =
    entry.kind === 'exit' && Boolean(entry.request?.onchainAddress);
  const incoming = entry.kind === 'receive' || entry.kind === 'deposit';
  const failed = entry.status === 'failed';
  const pending = entry.status === 'pending';
  const title = cooperativeSend
    ? 'Cooperative exit'
    : (KIND_LABEL[entry.kind] ?? entry.kind);
  const amountColor = failed
    ? palette.faint
    : incoming
      ? palette.good
      : palette.text;
  const statusColor = failed
    ? palette.bad
    : pending
      ? palette.warn
      : palette.good;
  const statusBg = failed
    ? palette.badSoft
    : pending
      ? palette.warnSoft
      : palette.goodSoft;

  const amountSat = Math.abs(entry.amountSat ?? 0);
  const feeSat = entry.feeSat ?? 0;
  const progress = entry.progress;
  const request = entry.request;
  // Only an outbound entry has a meaningful total: the fee is charged on top of
  // what leaves. An inbound fee (boarding) is already deducted from the amount
  // credited, so adding it would overstate what arrived.
  const showTotal = !incoming && feeSat > 0;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
    >
      <View style={styles.root}>
        <Pressable
          style={[StyleSheet.absoluteFill, styles.backdrop]}
          onPress={onClose}
          accessibilityLabel="Dismiss"
        />
        <View style={styles.sheet}>
          <View style={styles.hairline} />
          <View style={styles.head}>
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.title}>{entry.note || title}</Text>
              <Text style={[styles.amount, { color: amountColor }]}>
                {incoming ? '+' : '-'}
                {formatSats(amountSat)}{' '}
                <Text style={styles.amountUnit}>sats</Text>
              </Text>
              <View
                style={[
                  styles.status,
                  { backgroundColor: statusBg, borderColor: statusColor },
                ]}
              >
                <Text style={[styles.statusText, { color: statusColor }]}>
                  {entry.status}
                </Text>
              </View>
            </View>
            <Pressable
              onPress={onClose}
              style={styles.close}
              accessibilityLabel="Close"
            >
              <X size={16} color={palette.muted} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body}>
            {failed && (entry.failureReason || entry.failureCode) ? (
              <View style={styles.section}>
                <Label accent="orange" rule>
                  Why it failed
                </Label>
                <View style={styles.failBox}>
                  {entry.failureCode ? (
                    <Text style={styles.failHint}>
                      {FAILURE_HINT[entry.failureCode] ?? entry.failureCode}
                    </Text>
                  ) : null}
                  {entry.failureReason ? (
                    <Text style={styles.failReason} selectable>
                      {entry.failureReason}
                    </Text>
                  ) : null}
                </View>
              </View>
            ) : null}

            <Section title="Summary" accent="violet">
              <DetailRow label="Type" value={title} />
              <DetailRow label="Amount" value={`${formatSats(amountSat)} sats`} />
              {feeSat > 0 ? (
                <DetailRow label="Fee" value={`${formatSats(feeSat)} sats`} />
              ) : null}
              {showTotal ? (
                <DetailRow
                  label="Total out"
                  value={`${formatSats(amountSat + feeSat)} sats`}
                />
              ) : null}
              {entry.failureCode ? (
                <DetailRow label="Failure code" value={entry.failureCode} />
              ) : null}
              {progress?.phaseLabel ? (
                <DetailRow
                  label="Phase"
                  value={progress.phaseLabel.replace(/_/g, ' ')}
                />
              ) : null}
              {progress?.phase && progress.phase !== 'unspecified' ? (
                <DetailRow
                  label="Phase code"
                  value={progress.phase.replace(/_/g, ' ')}
                />
              ) : null}
            </Section>

            <Section title="Destination" accent="sky">
              {request?.type ? (
                <DetailRow label="Request type" value={request.type} />
              ) : null}
              {request?.lightningInvoice ? (
                <CopyRow label="Invoice" value={request.lightningInvoice} />
              ) : null}
              {request?.onchainAddress ? (
                <CopyRow label="On-chain address" value={request.onchainAddress} />
              ) : null}
              {request?.arkAddress ? (
                <CopyRow label="Ark address" value={request.arkAddress} />
              ) : null}
              {entry.counterparty ? (
                <CopyRow label="Counterparty" value={entry.counterparty} />
              ) : null}
            </Section>

            <Section title="Proof" accent="lime">
              {progress?.paymentHash || request?.paymentHash ? (
                <CopyRow
                  label="Payment hash"
                  value={progress?.paymentHash || request?.paymentHash || ''}
                />
              ) : null}
              {progress?.preimage ? (
                <CopyRow label="Preimage" value={progress.preimage} />
              ) : null}
            </Section>

            <Section title="On-chain" accent="orange">
              {progress?.txid ? (
                <CopyRow label="Txid" value={progress.txid} />
              ) : null}
              {progress?.confirmationHeight ? (
                <DetailRow
                  label="Confirmed at height"
                  value={formatSats(progress.confirmationHeight)}
                />
              ) : null}
              {progress?.vTXOOutpoint ? (
                <CopyRow label="VTXO outpoint" value={progress.vTXOOutpoint} />
              ) : null}
            </Section>

            <Section title="Timing" accent="teal">
              {entry.createdAt ? (
                <DetailRow
                  label="Created"
                  value={formatTimestampFull(entry.createdAt)}
                />
              ) : null}
              {entry.updatedAt && entry.updatedAt !== entry.createdAt ? (
                <DetailRow
                  label="Last update"
                  value={formatTimestampFull(entry.updatedAt)}
                />
              ) : null}
            </Section>

            <Section title="Reference" accent="violet">
              {entry.id ? <CopyRow label="Entry id" value={entry.id} /> : null}
              {entry.cursor ? (
                <DetailRow label="Stream cursor" value={String(entry.cursor)} />
              ) : null}
            </Section>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
