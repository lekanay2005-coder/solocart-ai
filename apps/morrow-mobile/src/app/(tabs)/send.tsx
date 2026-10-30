import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { LoadingScreen } from '@/components/ui/loading-screen';
import { Card, Screen } from '@/components/ui/screen';
import { SuccessSeal } from '@/components/ui/success-seal';
import { useToast } from '@/components/ui/toast';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { bmoniAdapter } from '@/lib/bmoni';
import { fetchShare, looksLikePayload, parsePayRef, SolocartError, solocartConfigured, submitConfirmation } from '@/lib/solocart';
import { createPaymentConfirmation, serializeConfirmation } from '@/lib/confirmation';
import { formatMoney } from '@/lib/format';
import { saveReceipt } from '@/lib/history';
import { decodeFrame, encodeFrame, encodeFrames, OpticalReceiver } from '@/lib/optical';
import { deserializeRequest, randomId, verifyPaymentRequest } from '@/lib/protocol';
import { markProcessed, wasProcessed } from '@/lib/replay';
import { getActiveReserve, spendFromReserve, verifyOfflineAuthorization } from '@/lib/reserve';
import { deduct, getBalance } from '@/lib/wallet';
import type { OfflineAuthorization, PaymentConfirmation, PaymentRequest, ReserveState, SettlementReceipt } from '@/lib/types';

type Stage = 'scan' | 'review' | 'auth' | 'settling' | 'confirming' | 'done';
/** How the confirmation reached (or failed to reach) the seller's server. */
type ServerCheck = 'verified' | 'offline' | 'refused' | 'local' | 'bmoni';
/** BMONI stays behind its flag and is off by default — its KYC path is blocked. */
const BMONI_LIVE = process.env.EXPO_PUBLIC_BMONI_MODE === 'live';
const CONFIRM_FRAME_INTERVAL_MS = 120;

const QR_MAX_SIZE = 240;
const QR_SIDE_MARGIN = Spacing.four * 2 + Spacing.four * 2; // Screen padding + Card padding, both sides

export default function SendScreen() {
  const theme = useTheme();
  const { showToast } = useToast();
  const { width: windowWidth } = useWindowDimensions();
  const qrSize = Math.min(QR_MAX_SIZE, windowWidth - QR_SIDE_MARGIN);
  const [permission, requestPermission] = useCameraPermissions();
  const [stage, setStage] = useState<Stage>('scan');
  const [progress, setProgress] = useState(0);
  const [received, setReceived] = useState<PaymentRequest | null>(null);
  const [receipt, setReceipt] = useState<SettlementReceipt | null>(null);
  const [confirmation, setConfirmation] = useState<PaymentConfirmation | null>(null);
  const [confirmFrameIndex, setConfirmFrameIndex] = useState(0);
  const [balance, setBalance] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [cameraActive, setCameraActive] = useState(true);
  const [reserve, setReserve] = useState<ReserveState | null>(null);
  const [expiresInMin, setExpiresInMin] = useState(0);
  const [payingFromReserve, setPayingFromReserve] = useState(false);
  const [expectedAmount, setExpectedAmount] = useState('');
  const [showExpectedAmount, setShowExpectedAmount] = useState(false);
  const [serverCheck, setServerCheck] = useState<ServerCheck>('local');
  const [serverMessage, setServerMessage] = useState('');
  const [paidFromReserve, setPaidFromReserve] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const receiverRef = useRef<OpticalReceiver | null>(null);
  const settledRef = useRef(false);

  if (receiverRef.current === null) receiverRef.current = new OpticalReceiver();
  const receiver = receiverRef.current;

  const confirmationFrames = useMemo(
    () => (confirmation ? encodeFrames(serializeConfirmation(confirmation), confirmation.requestId) : []),
    [confirmation]
  );

  useEffect(() => {
    if (!confirmationFrames.length) return;
    const timer = setInterval(() => setConfirmFrameIndex(i => (i + 1) % confirmationFrames.length), CONFIRM_FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [confirmationFrames]);

  useEffect(() => {
    if (!received) return;
    const tick = () => setExpiresInMin(Math.max(0, Math.round((received.expiresAt - Date.now()) / 60000)));
    tick();
    const timer = setInterval(tick, 15000);
    return () => clearInterval(timer);
  }, [received]);

  useFocusEffect(
    useCallback(() => {
      setCameraActive(true);
      getActiveReserve().then(setReserve);
      getBalance().then(setBalance);
      return () => setCameraActive(false);
    }, [])
  );

  function resetScan() {
    receiverRef.current = new OpticalReceiver();
    settledRef.current = false;
    setStage('scan');
    setProgress(0);
    setReceived(null);
    setReceipt(null);
    setConfirmation(null);
    setConfirmFrameIndex(0);
    setError('');
    setExpectedAmount('');
    setShowExpectedAmount(false);
    setServerCheck('local');
    setServerMessage('');
    setPaidFromReserve(false);
    setPasteText('');
    getBalance().then(setBalance);
  }

  // Optional, sender-typed cross-check: catches a request whose amount was
  // set differently from whatever the sender and merchant actually agreed on
  // out loud, instead of relying purely on the sender noticing the number on
  // screen. Blank by default — doesn't add friction unless used. Confirming
  // with a mismatch still works, it just requires one explicit "pay anyway"
  // tap via the same Alert-confirmation pattern used everywhere else in this
  // screen, rather than swapping in a whole separate warning UI.
  const expectedAmountMinor = expectedAmount.trim() ? Math.round(Number(expectedAmount.replaceAll(',', '')) * 100) : null;
  const amountMismatch =
    received !== null && expectedAmountMinor !== null && Number.isFinite(expectedAmountMinor) && expectedAmountMinor !== received.amountMinor;

  function confirmMismatchThenRun(run: () => void) {
    if (!received || !amountMismatch) {
      run();
      return;
    }
    Alert.alert(
      "Amount doesn't match",
      `This request is for ${formatMoney(received.amountMinor, received.currency)}, not the ${formatMoney(
        expectedAmountMinor!,
        received.currency
      )} you expected. Check with ${received.merchant.name} before paying.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Pay anyway', style: 'destructive', onPress: run },
      ]
    );
  }

  async function acceptRequest(parsed: PaymentRequest) {
    if (!(await verifyPaymentRequest(parsed))) throw new Error('This request is expired or failed its integrity check.');
    if (await wasProcessed(parsed.id)) throw new Error('This payment request has already been processed.');
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setReceived(parsed);
    setStage('review');
  }

  async function handleBarcodeScanned(result: BarcodeScanningResult) {
    if (stage !== 'scan' || settledRef.current) return;
    const raw = result.data;
    try {
      let parsed: PaymentRequest;
      try {
        const frame = decodeFrame(raw);
        const status = receiver.add(frame);
        setProgress(status.total > 0 ? Math.min(1, status.received / status.total) : 0);
        if (!status.complete) return;
        parsed = deserializeRequest(receiver.result());
      } catch {
        // Not fountain frames: SoloCart's web QR is the raw request payload,
        // and a payment link names a request the server holds (phase 5).
        if (looksLikePayload(raw)) {
          parsed = deserializeRequest(raw);
        } else {
          const ref = parsePayRef(raw);
          if (!ref) throw new Error('Could not read a payment request from that code.');
          parsed = (await fetchShare(ref)).request;
        }
      }
      settledRef.current = true;
      await acceptRequest(parsed);
    } catch (cause) {
      // A completed OpticalReceiver ignores every further frame (correct for
      // a successful decode, wrong here) — without a fresh instance, every
      // subsequent camera frame just re-triggers this same stale failure.
      receiverRef.current = new OpticalReceiver();
      settledRef.current = false;
      setProgress(0);
      setError(cause instanceof Error ? cause.message : 'Could not reconstruct the request.');
    }
  }

  /** Manual entry for scanners and slow links: a payment link, a request id,
   * or a pasted payload — same acceptance path as the camera. */
  async function openPasted() {
    const text = pasteText.trim();
    if (!text) {
      setError('Paste the payment link or request id first.');
      return;
    }
    if (stage !== 'scan' || settledRef.current) return;
    settledRef.current = true;
    try {
      let parsed: PaymentRequest;
      if (looksLikePayload(text)) {
        parsed = deserializeRequest(text);
      } else {
        const ref = parsePayRef(text);
        if (!ref) throw new Error('That does not look like a SoloCart payment link or request id.');
        parsed = (await fetchShare(ref)).request;
      }
      await acceptRequest(parsed);
    } catch (cause) {
      settledRef.current = false;
      setError(cause instanceof Error ? cause.message : 'Could not open that payment.');
    }
  }

  async function afterSettlement(
    nextReceipt: SettlementReceipt,
    request: PaymentRequest,
    options: { deductWallet: boolean; offlineAuthorization?: OfflineAuthorization; viaBmoni?: boolean }
  ) {
    const nextConfirmation = await createPaymentConfirmation({
      requestId: request.id,
      amountMinor: request.amountMinor,
      currency: request.currency,
      payerLabel: 'Morrow customer',
      settlementReference: nextReceipt.reference,
      offlineAuthorization: options.offlineAuthorization,
    });

    // SoloCart settlement path (phase 5): the server verifies this signed
    // confirmation, the seller redeems it there, and that redemption is what
    // settles the payment (PayPal Sandbox for the online leg). Order matters:
    // a rejection must never charge the wallet, while a network gap falls
    // back to the proof QR — the merchant can scan it, and the server accepts
    // the same confirmation later.
    let check: ServerCheck = options.viaBmoni ? 'bmoni' : 'local';
    if (!options.viaBmoni && solocartConfigured()) {
      try {
        await submitConfirmation(request.id, serializeConfirmation(nextConfirmation));
        check = 'verified';
        setServerMessage('');
      } catch (cause) {
        const code = cause instanceof SolocartError ? cause.code : 'rejected';
        if (code === 'rejected' && options.deductWallet) throw cause;
        check = code === 'network' || code === 'unavailable' ? 'offline' : 'refused';
        setServerMessage(cause instanceof Error ? cause.message : '');
      }
    }

    if (options.deductWallet) {
      await deduct(request.amountMinor);
      setBalance(await getBalance());
    }
    await markProcessed(request.id);
    await saveReceipt(nextReceipt);
    setReceipt(nextReceipt);
    setConfirmation(nextConfirmation);
    setServerCheck(check);
    setPaidFromReserve(Boolean(options.offlineAuthorization));
    setConfirmFrameIndex(0);
    setStage('confirming');
  }

  function confirm() {
    confirmMismatchThenRun(runConfirm);
  }

  async function runConfirm() {
    if (!received) return;
    setError('');
    if (balance !== null && received.amountMinor > balance) {
      setError('Insufficient balance for this payment.');
      return;
    }
    setStage('auth');
    try {
      if (BMONI_LIVE) {
        // BMONI rail — behind its flag, off by default: its KYC path is blocked.
        await bmoniAdapter.authenticate();
        setStage('settling');
        const nextReceipt = await bmoniAdapter.settle(received);
        await afterSettlement({ ...nextReceipt, status: 'settled', direction: 'sent' }, received, { deductWallet: true, viaBmoni: true });
        showToast({ message: `Sent ${formatMoney(received.amountMinor, received.currency)} — hand over your screen to confirm`, variant: 'success' });
        return;
      }

      if (solocartConfigured()) {
        // SoloCart settles through a Reserve-signed authorization, so probe
        // the server BEFORE anything is spent. A request it doesn't know (a
        // device-to-device one) falls through to the local path below; an
        // expired, replayed or refused one stops here with nothing charged.
        setStage('settling');
        let serverKnowsRequest = true;
        try {
          const share = await fetchShare(received.id);
          if (share.status !== 'pending') {
            throw new Error(`This request is ${share.status} on the seller's desk — nothing was charged.`);
          }
        } catch (cause) {
          if (cause instanceof SolocartError && cause.code === 'rejected' && /does not exist/.test(cause.message)) {
            serverKnowsRequest = false; // a local device-to-device request
          } else {
            throw cause; // expired / already confirmed / unreachable — nothing charged
          }
        }
        if (serverKnowsRequest) {
          const remaining = reserve ? reserve.allowance.valueMinor - reserve.spentMinor : 0;
          if (!reserve || remaining < received.amountMinor) {
            throw new Error('SoloCart payments settle through your Reserve — add to Reserve on the home screen first. Nothing was charged.');
          }
          await payReserveCore();
          showToast({ message: `Sent ${formatMoney(received.amountMinor, received.currency)} — hand over your screen to confirm`, variant: 'success' });
          return;
        }
        // Not a server request: sign locally, no server involved.
      }

      // Local device-to-device mode: sign here, hand over the proof, and call
      // the receipt what it honestly is — pending, not settled.
      setStage('settling');
      const nextReceipt: SettlementReceipt = {
        id: randomId('rcpt'),
        requestId: received.id,
        status: 'pending',
        direction: 'sent',
        amountMinor: received.amountMinor,
        currency: received.currency,
        merchantName: received.merchant.name,
        customerName: 'This device',
        settledAt: Date.now(),
        reference: `MRW-${Date.now().toString(36).toUpperCase()}`,
      };
      await afterSettlement(nextReceipt, received, { deductWallet: true });
      showToast({ message: `Signed ${formatMoney(received.amountMinor, received.currency)} — hand over your screen to confirm`, variant: 'success' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Settlement could not be completed. Your account was not charged.';
      setError(message);
      setStage('review');
      showToast({ message, variant: 'error' });
    }
  }

  function payFromReserve() {
    confirmMismatchThenRun(async () => {
      if (!received || payingFromReserve) return;
      setError('');
      setPayingFromReserve(true);
      try {
        await payReserveCore();
        showToast({ message: 'Signed offline — hand over your screen to confirm', variant: 'success' });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Could not pay from Morrow Reserve.';
        setError(message);
        showToast({ message, variant: 'error' });
      } finally {
        setPayingFromReserve(false);
      }
    });
  }

  /** Signs the Reserve authorization, self-verifies it, and hands everything
   * to afterSettlement — which sends the confirmation to SoloCart when one is
   * configured. Throws; callers decide how to surface it. */
  async function payReserveCore() {
    if (!received) return;
    const auth = await spendFromReserve({
      recipientRequestId: received.id,
      recipientName: received.merchant.name,
      amountMinor: received.amountMinor,
    });
    // Self-verify the authorization we just produced — proves the signing
    // and recipient-binding checks a merchant device would run actually
    // hold, rather than trusting our own output blindly.
    const verdict = await verifyOfflineAuthorization(auth, received.id);
    if (!verdict.valid) throw new Error(verdict.reason ?? 'Could not verify the offline authorization.');

    const nextReceipt: SettlementReceipt = {
      id: randomId('rcpt'),
      requestId: received.id,
      status: 'pending',
      direction: 'sent',
      amountMinor: received.amountMinor,
      currency: received.currency,
      merchantName: received.merchant.name,
      customerName: 'This device (Morrow Reserve)',
      settledAt: Date.now(),
      reference: `${auth.allowanceId}:${auth.sequence}`,
    };
    // Already deducted from the wallet when this Reserve was created —
    // spending from it now only decrements the Reserve's own bookkeeping.
    // The receiver independently re-verifies `auth` itself, not just this
    // receipt — see verifyPaymentConfirmation in confirmation.ts.
    await afterSettlement(nextReceipt, received, { deductWallet: false, offlineAuthorization: auth });
  }

  // Wallet was already debited back when `confirm()`/`payFromReserve()` ran —
  // this screen's only job left is getting proof into the merchant's hands.
  // Nothing stops someone tapping Done without ever showing this screen, so
  // the money would vanish with no one credited. This is the one guard rail
  // available given there's no server to verify the scan actually happened.
  function confirmDone() {
    if (!received) return;
    Alert.alert(
      'Did they scan it?',
      `${received.merchant.name}'s balance only updates once they scan this screen. If you leave now without showing it to them, your money is gone and they never receive it.`,
      [
        { text: 'Not yet', style: 'cancel' },
        { text: 'Yes, they scanned it', onPress: () => setStage('done') },
      ]
    );
  }

  if (stage === 'scan') {
    if (!permission) return <LoadingScreen />;
    if (!permission.granted) {
      return (
        <Animated.View key="scan-permission" entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)} style={styles.flex}>
          <Screen>
            <ThemedText type="title" style={styles.title}>
              Send
            </ThemedText>
            <Card>
              <ThemedText>Morrow needs camera access to receive payment requests optically.</ThemedText>
              {permission.canAskAgain ? (
                <Button label="Grant camera access" onPress={requestPermission} />
              ) : (
                <Button label="Open settings to enable camera" onPress={() => Linking.openSettings()} />
              )}
            </Card>
          </Screen>
        </Animated.View>
      );
    }

    return (
      <Animated.View key="scan" entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)} style={styles.cameraContainer}>
        {cameraActive && (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handleBarcodeScanned}
          />
        )}
        <View style={[StyleSheet.absoluteFill, styles.scanOverlay]} pointerEvents="none">
          <View style={styles.scanFrame} />
        </View>
        <View style={styles.scanFooter}>
          <ThemedText style={styles.scanHint}>Point your camera at the merchant&apos;s screen</ThemedText>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress * 100}%`, backgroundColor: theme.accent }]} />
          </View>
          <View style={styles.pasteRow}>
            <TextInput
              value={pasteText}
              onChangeText={setPasteText}
              placeholder="…or paste a payment link"
              placeholderTextColor="rgba(255,255,255,0.65)"
              style={styles.pasteInput}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={openPasted}
              accessibilityLabel="Payment link or request id"
            />
            <View style={styles.pasteButton}>
              <Button label="Open" variant="secondary" onPress={openPasted} />
            </View>
          </View>
          {error ? <ErrorState message={error} /> : null}
        </View>
      </Animated.View>
    );
  }

  if ((stage === 'review' || stage === 'auth' || stage === 'settling') && received) {
    const reserveRemaining = reserve ? reserve.allowance.valueMinor - reserve.spentMinor : 0;
    const reserveSufficient = reserve !== null && reserveRemaining >= received.amountMinor;
    return (
      <Animated.View key="review" entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)} style={styles.flex}>
        <Screen>
          <Button label="‹ Back to camera" variant="ghost" onPress={resetScan} disabled={stage !== 'review'} />
          <ThemedText type="small" themeColor="textSecondary">
            Paying
          </ThemedText>
          <ThemedText type="title" style={styles.title} numberOfLines={2}>
            {received.merchant.name}
          </ThemedText>
          <ThemedText type="title" style={styles.amount} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
            {formatMoney(received.amountMinor, received.currency)}
          </ThemedText>
          <ThemedText themeColor="textSecondary" numberOfLines={2}>
            {received.note}
          </ThemedText>

          <Card>
            <ThemedText type="smallBold">Request verified</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              SHA-256 integrity · fresh nonce · expires in {expiresInMin} min
            </ThemedText>
          </Card>

          <View style={styles.balanceRow}>
            <ThemedText themeColor="textSecondary">Pay from</ThemedText>
            <ThemedText type="smallBold" numberOfLines={1}>
              {balance !== null ? formatMoney(balance, received.currency) : '…'} available
            </ThemedText>
          </View>

          {stage === 'review' &&
            (showExpectedAmount ? (
              <Card>
                <ThemedText type="small" themeColor="textSecondary">
                  What did you agree to pay? (optional check)
                </ThemedText>
                <View style={styles.amountRow}>
                  <ThemedText type="title" style={styles.currencyPrefix}>
                    ₦
                  </ThemedText>
                  <TextInput
                    value={expectedAmount}
                    onChangeText={setExpectedAmount}
                    keyboardType="decimal-pad"
                    style={[styles.expectedAmountInput, { color: theme.text }]}
                    placeholder="0.00"
                    placeholderTextColor={theme.textSecondary}
                    accessibilityLabel="Amount you agreed to pay"
                    autoFocus
                  />
                </View>
                {amountMismatch && (
                  <ThemedText type="small" themeColor="danger">
                    Doesn&apos;t match this request — you&apos;ll be asked to confirm before paying.
                  </ThemedText>
                )}
              </Card>
            ) : (
              <Button label="Verify this is the right amount" variant="ghost" onPress={() => setShowExpectedAmount(true)} />
            ))}

          {error ? <ErrorState message={error} /> : null}

          {stage === 'review' && <Button label="Confirm payment" onPress={confirm} />}
          {stage === 'review' && reserve && (
            <>
              <ThemedText type="small" themeColor="textSecondary" style={styles.orDivider}>
                or, with no connection at all
              </ThemedText>
              {reserveSufficient ? (
                <Button
                  label={`Pay ${formatMoney(received.amountMinor, received.currency)} from Reserve (offline)`}
                  variant="secondary"
                  onPress={payFromReserve}
                  loading={payingFromReserve}
                />
              ) : (
                <>
                  <Button label="Not enough in Reserve for this" variant="secondary" disabled onPress={() => {}} />
                  <ThemedText type="small" themeColor="textSecondary" style={styles.orDivider}>
                    Reserve has {formatMoney(reserveRemaining, reserve.allowance.currency)} available — this payment needs{' '}
                    {formatMoney(received.amountMinor, received.currency)}.
                  </ThemedText>
                </>
              )}
            </>
          )}
          {stage === 'auth' && (
            <Card style={styles.processingRow}>
              <ActivityIndicator color={theme.text} />
              <ThemedText>Authenticating your device-held signing key…</ThemedText>
            </Card>
          )}
          {stage === 'settling' && (
            <Card style={styles.processingRow}>
              <ActivityIndicator color={theme.text} />
              <ThemedText>
                {BMONI_LIVE
                  ? 'Settling your payment. This step requires connectivity.'
                  : solocartConfigured()
                    ? 'Signing on this device, then verifying with SoloCart. This step requires connectivity.'
                    : 'Signing this payment on your device.'}
              </ThemedText>
            </Card>
          )}
        </Screen>
      </Animated.View>
    );
  }

  if (stage === 'confirming' && confirmation && received) {
    const currentFrame = confirmationFrames[confirmFrameIndex];
    const confirmingCopy =
      serverCheck === 'verified'
        ? `Your signed proof is with SoloCart — ${received.merchant.name} redeems it there, and that redemption is what settles the payment. The QR below is the same proof if they'd rather scan it directly.`
        : serverCheck === 'offline'
          ? `SoloCart couldn't be reached just now, so keep this screen ready: ${received.merchant.name} can scan the proof, and the server accepts the same confirmation later.`
          : serverCheck === 'refused'
            ? `The seller's server refused this confirmation${serverMessage ? `: ${serverMessage}` : ''} — show the proof to ${received.merchant.name} so their device can verify it directly.`
            : serverCheck === 'bmoni'
              ? `Settled through BMONI. Hand ${received.merchant.name} your screen so they can confirm the receipt.`
              : `No SoloCart server is configured: ${received.merchant.name}'s device confirms this payment when it scans your screen — hand it over.`;
    return (
      <Animated.View key="confirming" entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)} style={styles.flex}>
        <Screen>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
            Last step — proving it to {received.merchant.name}
          </ThemedText>
          <ThemedText type="title" style={styles.title}>
            One more scan
          </ThemedText>
          <ThemedText themeColor="textSecondary">{confirmingCopy}</ThemedText>

          <Card style={styles.qrCard}>
            {currentFrame && <QRCode value={encodeFrame(currentFrame)} size={qrSize} backgroundColor={theme.surface} color={theme.text} />}
          </Card>

          <Button label="Done" onPress={confirmDone} />
        </Screen>
      </Animated.View>
    );
  }

  if (stage === 'done' && receipt) {
    const isPending = receipt.status === 'pending';
    return (
      <Animated.View key="done" entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)} style={styles.flex}>
        <Screen>
          <SuccessSeal size={72} />
          <ThemedText type="small" themeColor={isPending ? 'textSecondary' : 'positive'} style={styles.centerText}>
            {isPending ? 'Payment verified — settlement pending' : 'Payment settled'}
          </ThemedText>
          <ThemedText
            type="title"
            themeColor="danger"
            style={[styles.amount, styles.centerText]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.6}>
            −{formatMoney(receipt.amountMinor, receipt.currency)}
          </ThemedText>
          <ThemedText themeColor="textSecondary" numberOfLines={1} style={styles.centerText}>
            to {receipt.merchantName}
          </ThemedText>

          {balance !== null && (
            <View style={styles.balanceRow}>
              <ThemedText themeColor="textSecondary">New balance</ThemedText>
              <ThemedText type="smallBold" numberOfLines={1}>
                {formatMoney(balance, receipt.currency)}
              </ThemedText>
            </View>
          )}

          {isPending && (
            <Card>
              <ThemedText type="smallBold">{paidFromReserve ? 'Paid from Morrow Reserve' : 'Signed on this device'}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {serverCheck === 'verified'
                  ? 'SoloCart verified this confirmation. The payment settles when the seller redeems it on the server — through PayPal Sandbox for the online leg. Until then it is honestly pending.'
                  : paidFromReserve
                    ? 'This device signed the authorization without needing the network. The seller redeems it on SoloCart — or scans this proof — once either side is back online.'
                    : 'No server was involved: the merchant device verifies this proof directly when it scans your screen.'}
              </ThemedText>
            </Card>
          )}

          <Card>
            <View style={styles.receiptRow}>
              <ThemedText themeColor="textSecondary">Reference</ThemedText>
              <ThemedText type="smallBold" numberOfLines={1} style={styles.receiptValue}>
                {receipt.reference}
              </ThemedText>
            </View>
            <View style={styles.receiptRow}>
              <ThemedText themeColor="textSecondary">{isPending ? 'Signed' : 'Settled'}</ThemedText>
              <ThemedText type="smallBold" numberOfLines={1} style={styles.receiptValue}>
                {new Date(receipt.settledAt).toLocaleString()}
              </ThemedText>
            </View>
          </Card>

          <Button label="Send another payment" onPress={resetScan} />
        </Screen>
      </Animated.View>
    );
  }

  return <LoadingScreen />;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  title: { fontSize: 28, lineHeight: 34 },
  amount: { fontSize: 40, lineHeight: 46 },
  cameraContainer: { flex: 1, backgroundColor: '#000000' },
  scanOverlay: { alignItems: 'center', justifyContent: 'center' },
  scanFrame: { width: 260, height: 260, borderRadius: 24, borderWidth: 2, borderColor: 'rgba(255,255,255,0.8)' },
  scanFooter: { position: 'absolute', left: 0, right: 0, bottom: 48, paddingHorizontal: Spacing.four, gap: Spacing.two },
  scanHint: { color: '#FFFFFF', textAlign: 'center' },
  pasteRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  pasteInput: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: Spacing.two,
    color: '#FFFFFF',
    borderColor: 'rgba(255,255,255,0.5)',
    borderWidth: 1,
    borderRadius: 10,
    fontSize: 14,
  },
  pasteButton: { width: 88 },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden' },
  progressFill: { height: 4, borderRadius: 2 },
  balanceRow: { flexDirection: 'row', justifyContent: 'space-between', gap: Spacing.two },
  processingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  qrCard: { alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.five },
  receiptRow: { flexDirection: 'row', justifyContent: 'space-between', gap: Spacing.two },
  receiptValue: { flexShrink: 1, textAlign: 'right' },
  orDivider: { textAlign: 'center' },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  currencyPrefix: { fontSize: 24 },
  expectedAmountInput: { fontSize: 28, fontFamily: Fonts.sansSemiBold, flex: 1, padding: 0, minWidth: 0 },
  centerText: { textAlign: 'center' },
});
