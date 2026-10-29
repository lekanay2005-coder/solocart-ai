# SoloCart interface system

## Product surface

SoloCart is a seller workspace for turning a customer request into an editable order and handing checkout to PayPal Sandbox for buyer approval. The seller remains in control of the draft; the interface must label simulations and avoid implying live funds or unsupported security features.

## Visual direction

Use the Stitch project as a reference for a refined, high-contrast workspace with clear order review, compact navigation, and strong separation between the request composer and checkout review. The amber capabilities brief contributes warm focus and precise linework; the cobalt brief contributes restrained ambient light and layered surfaces; the Vertex3D brief contributes clear form focus and confident split emphasis. Apply those qualities to SoloCart without importing fictional brands or claims.

The app defaults to a midnight navy canvas with lightly illuminated panels. Use amber for AI/order-preparation emphasis and active navigation. Keep PayPal blue exclusive to the checkout handoff. Use cyan for informational accents and green only for completed/safe states. The light theme remains available in Settings.

## Typography and layout

- Instrument Sans is the UI and display family; JetBrains Mono is reserved for short technical status labels.
- Keep labels and supporting text readable at compact sizes; numbers use tabular figures.
- Keep the order composer and editable order review together on desktop. Stack them on narrow screens.
- Keep Overview, Orders, Activity, and New order in primary navigation. Place less frequent tools in More; use a fixed bottom navigation on phones.
- Prefer crisp borders and subtle, directional light over decorative blur or heavy shadow.

## Interaction and states

- Preserve keyboard focus visibility, readable error/success states, disabled checkout states, and useful empty states.
- Respect reduced motion; transitions communicate state and remain brief.
- Theme changes must update the whole app and browser chrome color.
- PayPal checkout stays explicitly in Sandbox and only happens after buyer approval.
