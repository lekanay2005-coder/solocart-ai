# SoloCart demo walkthrough

Target length: about 2 minutes. Keep the recording public or unlisted on YouTube and under 3 minutes for the Devpost submission.

## Recording outline

**0:00–0:20 — The problem**  
“Independent sellers often receive orders in chat. Turning those messages into a checkout is repetitive, and a wrong quantity or price can cause confusion. SoloCart turns the request into an order the seller reviews first.”

**0:20–0:50 — Draft the order**  
Show the request: `2 handwoven baskets at $18 each, delivery $5`. Choose **Organize order**. Explain that the OpenAI Responses API extracts the item, quantity, price, and delivery when an API key is configured. The local parser is only the credential-free preview fallback.

**0:50–1:15 — Seller review**  
Change a quantity or price, show the updated total, then restore the sample values. Point out that the draft is editable and nothing is sent to PayPal until the seller starts checkout.

**1:15–1:35 — Payment concepts**  
Show the allocation sliders and explain that these are UI simulations. PayPal Sandbox is the only connected payment route; the other concepts do not create or move funds.

**1:35–2:00 — PayPal Sandbox approval**  
With Sandbox credentials configured, choose **View checkout preview** and continue to PayPal Sandbox. Approve using a Sandbox personal test account, return to SoloCart, and show the capture result. State clearly that this is a Sandbox transaction.

**2:00–2:10 — Close**  
Show the repository and mention the seller review step, server-side credentials, and local run instructions.

## Before recording the final version

- Add an OpenAI API key and PayPal Sandbox REST app credentials to the local `.env` file. Never use live PayPal credentials.
- Restart SoloCart and verify the header shows the AI and PayPal Sandbox modes.
- Complete one full Sandbox buyer-approval and capture round trip.
- Remove any secrets and personal data from the recording.
- Upload the finished video to YouTube as public or unlisted, then add its URL to the Devpost project details.

The current environment has no OpenAI or PayPal credentials configured, so the final Sandbox section cannot be recorded truthfully yet. The current no-credential preview can be shown, but it is not a substitute for the completed integration walkthrough.
