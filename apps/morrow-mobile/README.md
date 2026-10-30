# Morrow — SoloCart's buyer app

**Transactions, device to device.**

Morrow is the mobile half of [SoloCart](../../README.md): a native Expo /
React Native app built around networkless device-to-device payment
negotiation, with online settlement through the seller's SoloCart desk when
one is configured. A merchant creates a request on the **Receive** tab;
Morrow serializes it and broadcasts it as a continuous animated QR stream.
On another device, the **Send** tab uses the real camera to scan,
reconstruct, and verify the request, then pays it — from the wallet or from a
Morrow Reserve — and broadcasts a signed confirmation back. The merchant
scans that confirmation to close the loop.

Both devices' balances are real, persisted, and actually move — this is a
genuine two-device simulation with real signatures at every step, not a
scripted animation. Neither balance is connected to BMONI or any shared
backend; see "Morrow Wallet + confirmation loop" in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for exactly what's real and what
isn't.

> Morrow does not claim fully offline settlement. Only the request handoff is
> networkless. Settlement needs connectivity — either to the seller's
> SoloCart desk or to the other device.

## Requirements

- Node **20+** (this project was built and tested on Node 24 via
  [nvm](https://github.com/nvm-sh/nvm); a `.nvmrc` is included — run `nvm use`).
- A physical iOS or Android device with the [Expo Go](https://expo.dev/go)
  app, or a configured simulator/emulator, for camera access. Camera scanning
  does not work in a browser preview.

## Run locally

```bash
nvm use
npm install
npm start
```

Scan the printed QR with Expo Go (or press `i` / `a` for a simulator/emulator).

With no environment configured the app runs in **device-to-device mode**:
requests and confirmations are signed on-device and verified peer-to-peer, no
server is contacted, and receipts stay honestly `pending` until the merchant
device confirms them. No real funds move.

### SoloCart desk mode (recommended for the demo)

Point the app at your desk's origin to settle through SoloCart's offline
ledger (PayPal Sandbox sits behind the desk for the online leg):

```bash
cp .env.example .env   # EXPO_PUBLIC_SOLOCART_URL=http://<your-laptop-ip>:4173
npx expo start
```

Unset — or `local` — keeps device-to-device mode. In desk mode the **Pay now**
button probes the server before anything is spent: a request the server
doesn't know falls back to local signing, an expired or refused one stops
with nothing charged, and a confirmed payment is submitted to the server
before the wallet is debited.

### Live BMONI mode (optional, off by default)

BMONI remains behind its flag and is **off by default** — its KYC path is
blocked upstream, so the default install never touches the network for
settlement. To wire real BMONI sandbox calls and on-device signing:

```bash
cp .env.example .env   # fill in EXPO_PUBLIC_BMONI_MODE=live
npx expo prebuild
npx expo run:android   # or run:ios
```

This requires a native Expo Dev Client, not Expo Go — BMONI's signing SDK
ships native code Expo Go can't load — and one-time manual KYC/funding setup
per device. See [docs/BMONI_INTEGRATION.md](docs/BMONI_INTEGRATION.md).

## Verify

```bash
npm test           # protocol, optical fountain, Reserve, shared server vectors (vitest)
npx tsc --noEmit   # typecheck
```

`npm test` covers the pure protocol/optical logic layer, including
`src/lib/vectors.test.ts`, which verifies `tests/fixtures/offline-vectors.json`
— the same file the server verifies — so the two wire formats cannot drift
apart. UI and camera behavior were verified with a static web export
(`npx expo export -p web`) rendered through a headless browser — full camera
scanning still requires a physical device.

## Demo script (two devices)

1. On device A, open the **Receive** tab, enter an amount and note, and create
   the request. The screen begins broadcasting an animated QR.
2. On device B, open the **Send** tab and grant camera access. Point the
   camera at device A's screen — reconstruction is loss-tolerant and works
   even if frames are missed or arrive out of order. (A pasted payment link
   or request id works too, on the same screen.)
3. Review the independently reconstructed request and its integrity status on
   device B.
4. Confirm. Device B's own balance is really debited (check the **Home** tab
   before and after). With a desk configured, the signed confirmation is
   submitted before the debit and the receipt says what actually happened;
   without one, the payment is signed locally and lands as `pending` until
   device A confirms it.
5. Device B now broadcasts a signed confirmation. On device A, tap "I've been
   paid — scan confirmation" and point the camera at device B (with a desk
   configured, the server already has this confirmation and the desk redeems
   it there). Device A's balance is really credited once the signature and
   amount check out.
6. Both receipts are saved to each device's own **Activity** tab — device B's
   shown as sent (−), device A's as received (+).

Alternatively, at step 4, if device B has an active **Morrow Reserve**
(Home tab → "Add to Reserve"), a second button appears — "Pay from Reserve."
That path spends pre-authorized offline power with zero network calls of its
own, self-verifies the authorization it just produced, and hands the same
signed proof to the same confirmation flow. See [docs/RESERVE.md](docs/RESERVE.md).

## Project structure

```text
src/app/(tabs)/         Home, Receive, Send, Activity screens (Expo Router)
src/lib/protocol.ts      canonical payment payload, SHA-256 (expo-crypto), expiry
src/lib/optical.ts       optical framing and out-of-order fountain reconstruction
src/lib/replay.ts        local duplicate-request guard (AsyncStorage)
src/lib/solocart.ts      SoloCart desk client: fetch a request, submit a confirmation
src/lib/bmoni.ts         settlement adapter boundary: flag-gated BMONI mode
src/lib/bmoniApi.ts      BMONI sandbox REST client
src/lib/bmoniIdentity.ts device wallet + BMONI user/wallet provisioning
src/lib/bmoniSigner.ts   wraps BMONI's native on-device signing SDK
src/lib/history.ts       local receipt history (AsyncStorage)
src/lib/wallet.ts        real per-device persisted balance (AsyncStorage)
src/lib/confirmation.ts  signed PaymentConfirmation: broadcast back after paying, credits the payee
src/lib/deviceKeys.ts    device Ed25519 keypair (@noble/curves), shared by Reserve and confirmations
src/lib/reserve.ts       Morrow Reserve: offline allowance + signed authorizations
src/vendor/decimen/      extracted Decimen v0.3.0 LT fountain core, MIT
src/components/          Morrow branding (real Figma-sourced symbol/wordmark) and UI primitives
docs/                    architecture, BMONI integration handoff, and Morrow Reserve
```

## Production boundary

Settlement goes through the SoloCart desk (server-verified confirmations,
PayPal Sandbox for the online leg) or stays device-to-device. BMONI is behind
`EXPO_PUBLIC_BMONI_MODE=live` and off by default; its sandbox adapter exists
for that path only, because no sandbox credentials are committed, and any
real BMONI traffic belongs behind a server-side proxy so the API key never
reaches the client bundle. See [docs/BMONI_INTEGRATION.md](docs/BMONI_INTEGRATION.md)
and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Licensing note: this app is derived from an upstream that ships no license
file — see the repository's [LICENSING.md](../../LICENSING.md).

## Decimen attribution

The optical encoder/decoder is extracted from the MIT-licensed
[Decimen Optical Transfer v0.3.0](https://github.com/Pendia/Decimen-Optical-QR-Transfer/tree/v0.3.0),
pinned to commit `29cba8fa25dd160c8b6aa18fe3b48fbc5bde2e36`. Morrow wraps that
LT fountain core in its own payment protocol and optical frame envelope. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
