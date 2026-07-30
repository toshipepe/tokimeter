# Pricing methodology

Tokimeter separates usage measurement from dollar valuation.

| Part | Method |
|---|---|
| Token metadata | Token, cache, model, and timestamp fields come from the local records each supported tool writes. “Exact tokens” means those recorded numeric fields; it does not mean Tokimeter reconstructs missing turns. |
| API-equivalent value | For subscription usage, Tokimeter applies sourced per-token API rates to the recorded buckets. The result is a notional API-equivalent value (`~$`), not the subscription fee, an invoice, or a claim about provider quota. |
| Provider/tool-reported cost | When a supported tool records its own request-time or billed cost, Tokimeter preserves that value and labels its provenance as reported. The optional paid API proxy remains experimental until reconciled against real provider invoices. |
| Cache pricing | Input, cache write/creation, cache read, and output are priced separately when the tool records them. If a sourced model price omits an explicit cache-write rate, Tokimeter uses 1.25× input; if it omits an explicit cache-read rate, Tokimeter uses the documented compatibility fallback in the pricing engine. |
| Price provenance | Every priced call is classified as **verified built-in**, **community feed**, **custom local**, or **provider/tool reported**. Known internal identifiers without a public rate are labeled **internal / unpriced**. Custom prices override verified built-ins, which override the opt-in community feed. |
| Unknown models | An unknown model is **unpriced**. Its `$2 input / $8 output per 1M` heuristic can be displayed as a separate rough estimate, but it is excluded from priced totals, savings claims, and authoritative comparisons until a sourced or custom price exists. |
| Internal model identifiers | A provider may record a private routing identifier such as `codex-auto-review` without publishing its billable model mapping. Tokimeter recognizes that provenance but keeps it outside authoritative totals rather than aliasing it to a public model without evidence. |

Built-in rates live in `ts/packages/core/src/pricing.js`. The community table is
downloaded only when you run `tokimeter pricing refresh`; its source and fetch
time are stored in `~/.tokimeter/pricing-feed.json`. Local overrides live in
`~/.tokimeter/pricing.json`. The legacy Python SDK uses the verified/custom/
reported/unpriced subset and does not load the community feed.

Inspect the active provenance with:

```bash
tokimeter pricing source <model>
tokimeter pricing list
```
