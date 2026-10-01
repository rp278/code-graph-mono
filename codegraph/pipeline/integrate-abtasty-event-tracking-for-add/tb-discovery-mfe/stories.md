# Stories — Integrate AbTasty event tracking for add to cart on PDP

**Slug:** `integrate-abtasty-event-tracking-for-add`  
**Requirement (verbatim):** Integrate AbTasty event tracking for add to cart on PDP

## Graph evidence

**Graph: used** (API `http://127.0.0.1:8000`) plus **file search** over `code-repos/` to confirm call sites and remaining gaps.

### Graph queries + hits

1. `MATCH (n:Node) WHERE toLower(n.label) CONTAINS "abtasty" RETURN … LIMIT 25`  
   → AbTasty helpers/nodes in `tb-discovery-mfe` (`ensureAbTastyActivatedForCurrentView`, `POST /api-replatform/analytics/abtasty`, …) and `tb-common-mfe` (`sendServerAbTastyEvent`, `abtastyServerEvents.ts`, `getAbTastyTagSend`, …).
2. `… CONTAINS "trackAbTastyAddToCart"` → `trackAbTastyAddToCart()` / `.ts` / test — `tb-discovery-mfe` (present in current checkout on `RFW-9856-fix-a2c-metrics`; **not** on `origin/main` / `origin/develop` as a separate module).
3. `… CONTAINS "emitAddToCart"` → `emitAddToCartEvent()` — `tb-discovery-mfe`.
4. `… CONTAINS "addToCart"` / `"add-to-cart"` / `"addToBag"` as bare labels → no useful ATC-tracking nodes (naming is camelCase helpers above).

### File-search (ground truth for what’s already wired vs gap)

Commands (under `code-repos/`):

- `rg -i 'abtasty|abTasty|ABTasty' tb-discovery-mfe tb-common-mfe`
- `rg 'trackAbTastyAddToCart|AB_TASTY_ATC|PDP_TO_ATC|ITEM_ATC|Add_to_Cart_on_PDP' …`
- Compared `origin/develop` vs current checkout for `emitAddToCartEvent` / `useSlideoutAddToBag`

**Already on `origin/develop` (do not re-build):**

| Layer | Behavior |
|-------|----------|
| `tb-discovery-mfe` `emitAddToCartEvent` | On successful ATC (`errorMessage` null / `'null'`), calls `pdpTracking.trackPdpInteraction({ content_type: 'add to cart', link_text })` |
| `tb-common-mfe` `PdpTracking.trackPdpInteraction` | Maps `content_type` containing `"add to cart"` → `abTastyTracking.trackGoal(AB_TASTY_GLOBAL_GOALS.PDP_TO_ATC_RATE)` (`"PDP → ATC Rate"`) |
| `tb-discovery-mfe` BFF proxy `emitPdpAtcAbTastyGoals` | On localhost/proxy `POST v1/secure/cart/items` success, fires Action Tracking `Add_to_Cart_on_PDP_for_{Delivery,BOPIS,STS}` — **not** the production browser→deployed-BFF path |

**Gap (this run’s story):**

| Surface | Path today on develop | AbTasty `PDP → ATC Rate` |
|---------|----------------------|---------------------------|
| Regular / sticky / bundle / PGC / confirmation-slideout Matching Items | `emitAddToCartEvent` / `useAddToCartAnalytics` | Yes |
| Matching Items drawer / How To Wear It (Stylitics) drawers | `useSlideoutAddToBag` → GTM inside `@MensWearhouse/product-slideouts` | **No** — bypasses `emitAddToCartEvent` |

Open in-flight work on checkout branch `RFW-9856-fix-a2c-metrics` / PR [#1909](https://github.com/MensWearhouse/tb-discovery-mfe/pull/1909) extracts `trackAbTastyAddToCart` and wires slideouts — useful reference, not a substitute for this pipeline story branch.

**Repos not in scope for a separate story:**

- `tb-common-mfe` — goal bridge already exists; no change required for `"PDP → ATC Rate"`.
- Other xapi / content-stack repos — no PDP ATC UI or AbTasty client goals.
- Production client emission of fulfillment-specific `Add_to_Cart_on_PDP_for_*` Action Tracking events (today only on the Next BFF proxy) — **not named in the free-text requirement**; leave for Gate 2 clarifying question if product wants those in deployed envs too.

## Affected repos

1. **`tb-discovery-mfe`** — sole story (close slideout gap; keep existing emit path correct).

---

## Story: tb-discovery-mfe — AbTasty PDP add-to-cart goal coverage

Every successful PDP add-to-bag must contribute exactly once to the AbTasty global goal **`PDP → ATC Rate`**, via the existing `pdpTracking.trackPdpInteraction` / `content_type: 'add to cart'` contract in `tb-common-mfe`. Failures and tracking exceptions must not corrupt the purchase path.

### Acceptance criteria (EARS)

1. **WHEN** a shopper successfully adds to bag from a PDP surface that emits through `emitAddToCartEvent` (regular PDP, sticky/variant, bundle, physical gift card, confirmation-slideout Matching Items)  
   **THE SYSTEM SHALL** fire exactly one AbTasty `PDP → ATC Rate` goal hit with `content_type: 'add to cart'` and `link_text` set to that surface’s click location (or `'add to cart'` when absent).

2. **WHEN** a shopper successfully adds to bag from a Matching Items drawer or How To Wear It (Stylitics) drawer on PDP  
   **THE SYSTEM SHALL** fire exactly one AbTasty `PDP → ATC Rate` goal hit with `content_type: 'add to cart'` and `link_text` equal to the surface label (`Matching items in the slideout` / `stylitics slideout on PDP`).

3. **IF** add-to-bag fails (validation error or unsuccessful cart API result)  
   **THEN THE SYSTEM SHALL** not fire the AbTasty `PDP → ATC Rate` goal for that attempt.

4. **IF** AbTasty / `trackPdpInteraction` throws during a successful add-to-bag  
   **THEN THE SYSTEM SHALL** still complete the add-to-bag success path (tracking failure must not surface as an ATC failure to the shopper).

5. **WHEN** the same successful add-to-bag is reported more than once through the pending-emit path (e.g. physical gift card)  
   **THE SYSTEM SHALL** fire the AbTasty `PDP → ATC Rate` goal at most once for that user action.
