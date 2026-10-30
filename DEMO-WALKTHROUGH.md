# SoloCart demo walkthrough

Target length: about 3 minutes. Keep the recording public or unlisted on
YouTube and under 3 minutes for the Devpost submission.

## Recording outline

**0:00–0:20 — The problem**
"Independent sellers often receive orders in chat. Turning those messages
into a checkout is repetitive, and a wrong quantity or price causes confusion.
When connectivity drops, checkout disappears entirely. SoloCart turns the
request into an order the seller reviews first — and keeps paying offline."

**0:20–0:50 — Draft the order**
Show the request: `2 handwoven baskets at $18 each, delivery $5`. Choose
**Organize order**. Explain that the OpenAI Responses API extracts the item,
quantity, price and delivery when an API key is configured, with a fallback
chain behind it; the local parser is only the credential-free preview.

**0:50–1:15 — Seller review**
Change a quantity or price, show the updated total, restore the sample
values. The draft is editable and nothing is sent to PayPal until the seller
starts checkout.

**1:15–1:40 — PayPal Sandbox approval**
With Sandbox credentials configured, choose **View checkout preview** and
continue to PayPal Sandbox. Approve with a Sandbox personal test account,
return, and show the captured result. State clearly: real API, Sandbox money,
live payments impossible.

**1:40–2:15 — The offline handoff**
Open **Offline pay**, issue a request from the draft, show the link/QR. On a
phone (Expo Go with `EXPO_PUBLIC_SOLOCART_URL` pointing at your laptop, or
`pay.html` in a browser), open it and pay from the **Reserve** — the app signs
on-device. Back on the desk, redeem it: the ledger records it, double-spend is
rejected on a second try. Say the honest line out loud: signatures are real,
settlement is simulated — no money moves offline.

**2:15–2:40 — Automations and Byte**
Open **Automations**: create a recipe that triggers on `order.settled`,
show it planning (or failing honestly with "add OPENAI_API_KEY"), and note
that the write step waits for your confirm click. Point at Byte reacting to
real events — celebrating a capture, thinking while the AI runs.

**2:40–3:00 — Close**
Show the repository, `npm test` passing (114 tests), and mention: server-side
credentials, `cp .env.example .env && npm start`, licensing in LICENSING.md.

## Before recording the final version

- Add an OpenAI API key and PayPal Sandbox REST app credentials to `.env`.
  Never use live PayPal credentials.
- Restart and verify the header shows the AI and PayPal Sandbox modes.
- Complete one full Sandbox buyer-approval and capture round trip.
- For the phone segment: `cd apps/morrow-mobile && npm install`, set
  `EXPO_PUBLIC_SOLOCART_URL=http://<your-laptop-ip>:4173` in its `.env`, start
  Expo, and confirm the phone can reach the desk (same Wi-Fi, firewall open).
- If no credentials are available, say so on camera: the no-credential preview
  (local parser, offline handoff with the Reserve, redeem on the desk) works
  fully without any key and is not a substitute for the Sandbox segment —
  it is a different, honest segment.

The current environment has no OpenAI or PayPal credentials configured, so
the Sandbox and AI segments cannot be recorded truthfully here; everything
else in the outline runs without them.
