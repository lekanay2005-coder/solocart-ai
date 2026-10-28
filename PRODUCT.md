# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated: dependency-free Node.js server with a vanilla HTML, CSS, and JavaScript client. This keeps the solo hackathon prototype easy to run and inspect.

## Users

Working assumption: independent sellers who receive order requests in natural language and want a fast way to prepare checkout without hand-building a cart.

## Product Purpose

Working assumption: SoloCart turns a customer's plain-language request into an editable order draft, then hands the buyer off to PayPal Sandbox for approval. Success means a seller can verify the line items and total before the buyer sees checkout.

## Positioning

Working assumption: the seller remains the review point between AI extraction and payment. The AI prepares order details; it cannot approve or capture a payment on its own.

## Operating Context

This is a solo PayPal AI Hackathon prototype. The submission needs a working demo, a public source repository with a license, setup instructions, and a short video. The hackathon requires meaningful use of both PayPal and an AI tool.

## Capabilities and Constraints

- The client supports an editable USD order draft and delivery fee.
- OpenAI Responses API extraction is optional and configured server-side.
- A local parser supports a credential-free preview.
- PayPal Orders v2 is configured for Sandbox only; the server never uses PayPal Live endpoints.
- There is no authentication, database, order persistence, webhook verification, inventory system, or production payment support.
- The target deploy platform and hosting provider are undecided.

## Evidence on Hand

The PayPal AI Hackathon Devpost page says projects must meaningfully use PayPal and AI, demonstrate a working prototype, and include clear run instructions or a hosted demo. It requires a public, open-source repository with a visible license and a demo video under three minutes.
