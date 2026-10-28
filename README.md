# SoloCart

**From customer message to confident checkout.** SoloCart is an AI checkout workspace for solo sellers. A seller describes the request, reviews the extracted items and prices, then hands the buyer off to a PayPal Sandbox approval page. Payment route controls, the security strip, and Byte the pet companion make the broader ideas in the brief explorable in one coherent demo.

## What the prototype does

- Extracts products, quantities, unit prices, and delivery fees from a natural-language request.
- Uses OpenAI's Responses API when `OPENAI_API_KEY` is configured. Without it, a local preview parser keeps the demo usable.
- Lets the seller adjust each quantity, unit price, and delivery fee before checkout.
- Calculates totals on the server and creates a PayPal Orders v2 `CAPTURE` order in Sandbox when credentials are set.
- Sends the buyer to PayPal to approve the order, then captures the Sandbox order after PayPal returns to the app.
- Lets the user explore a hypothetical payment split across PayPal USD, privacy credit, conditional token, and offline reserve. Only PayPal Sandbox is connected; the other routes are interface simulations and transfer no value.
- Shows a demo-only security activity panel and a small optional pet companion with interactive snack/play buttons.
- Never exposes the OpenAI or PayPal secret in browser code. The PayPal API host defaults to the Sandbox host.

The local parser is only a preview fallback; the OpenAI connection is the AI path. The current interface handles USD orders and does not store orders or buyer information in a database.

## Design

The web UI follows a Stitch-generated direction for a calm seller checkout workspace. [Open the SoloCart Stitch project](https://stitch.withgoogle.com/projects/2773758884601685044). Figma handoff is not included because Figma is not connected in this environment. The interface uses responsive HTML and CSS directly from the repository.

## Requirements

- Node.js 20 or newer
- Optional: an OpenAI API key
- Optional: PayPal Developer app credentials for the **Sandbox**

## Run locally

```sh
cp .env.example .env
npm start
```

Open [http://localhost:4173](http://localhost:4173). No npm packages are required.

The sample order is already in the request box. Press **Organize order**, edit the draft if needed, and use **View checkout preview** to see the amount that would be sent. To test buyer approval, add PayPal Sandbox credentials in `.env` and restart the server.

## Connect OpenAI

Set `OPENAI_API_KEY` in `.env`. You can also change `OPENAI_MODEL` to a model enabled for your account. With AI configured, the order description is sent to OpenAI for extraction. The model is instructed to treat that text as untrusted input and return order details only. SoloCart displays the result as a draft; sellers must review it before checkout.

## Connect PayPal Sandbox

1. Sign in to the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/) and create a Sandbox REST app.
2. Copy its Sandbox client ID and secret into `.env` as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
3. Restart the app and create a Sandbox checkout. Approve it with a Sandbox personal test account.

PayPal client credentials stay server-side. **Do not put live credentials in this prototype.** The app is hard-wired to PayPal's Sandbox API host and does not support live payments.

The Developer Dashboard uses your regular PayPal login. Use the generated **Personal** Sandbox account to approve the buyer flow; the **Business** Sandbox account represents the seller. See PayPal's [Sandbox getting-started guide](https://github.com/paypaldev/getting-started-with-paypal-sandbox) for account setup and the test-payment workflow.

For a local demo, pending order IDs are kept in server memory for up to three hours. The return route only captures orders created by the running server, and capture retries reuse the same PayPal request ID. Restarting the server clears those pending IDs; a production app needs durable order state and verified PayPal webhooks.

## Example request

> 2 handwoven baskets at $18 each, delivery $5

Expected review: 2 × $18.00 items, $5.00 delivery, $41.00 total.

## Submission notes

- Product: SoloCart
- Short description: An AI order-to-checkout assistant for solo sellers. Turn a customer message into a reviewable PayPal order in seconds.
- AI: OpenAI Responses API (`OPENAI_API_KEY`); local parser available for offline preview.
- Payment integration: PayPal Orders v2 REST API in Sandbox, with buyer approval and capture.
- Simulated concepts: multi-rail allocation preview, illustrative security status, and local pet companion.
- Run instructions: `cp .env.example .env && npm start`
- License: MIT

See [DEMO-WALKTHROUGH.md](./DEMO-WALKTHROUGH.md) for the under-three-minute recording outline and final demo checklist.

This is a hackathon prototype. It is not a production payment system: it has no account authentication, persistent order storage, webhook verification, inventory checks, or live-payment support.
