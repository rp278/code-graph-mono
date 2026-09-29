# Fix — ECS_40001 Bad request to downstream service

**Repo:** `ecom-content-stack`  
**Slug:** `bug-error-stack-trace-serviceerrors-code`  
**Branch:** `pipeline/bug-error-stack-trace-serviceerrors-code/ecom-content-stack`

## What changed and why

Restored the local-profile ContentStack CDN and Management `base-url` defaults in `application-local.yaml` from `…/v3/test` to `…/v3`. Those `/test` suffixes were routing unset-env local runs to invalid ContentStack roots, producing HTTP 4xx that map to `ECS_40001` / `Bad request to downstream service.`

No Java, handler, or other-env changes.

## Diff (inside scope fence)

```diff
- base-url: ${CONTENTSTACK_BASE_URL:https://cdn.contentstack.io/v3/test}
+ base-url: ${CONTENTSTACK_BASE_URL:https://cdn.contentstack.io/v3}

- base-url: ${CONTENTSTACK_MANAGEMENT_BASE_URL:https://api.contentstack.io/v3/test}
+ base-url: ${CONTENTSTACK_MANAGEMENT_BASE_URL:https://api.contentstack.io/v3}
```

File: `src/main/resources/application-local.yaml` only (non-test source).

## Test results

### Before fix (Gate 3 baseline)

Standalone predicates matching `ContentStackLocalBaseUrlDefaultsTest`:
- Bug-condition: **4 FAIL** (`…/v3/test`)
- Preservation: **7 PASS**

Maven: unavailable (GCP Artifact Registry 401 on `tb-platform-parent`).

### After fix

Same standalone predicates:
- Bug-condition: **4 PASS** (`…/v3`)
- Preservation: **7 PASS**
- `OVERALL: FIXED`

Maven: still unavailable for the same auth reason (not a regression of the fix).

No lint script in this Maven repo; no `npm run lint`.

## Scope check

```text
git diff --stat origin/develop...HEAD (after fix commit)
```

Non-test source touched: only `src/main/resources/application-local.yaml` (the two defaults). Tests + `.pipeline/` docs are expected companions. Matches Gate 2 fence.

Note: after the fix, that yaml matches `origin/develop` again (empty diff vs develop for the file). The meaningful before/after is vs the buggy story-branch tip that introduced `/v3/test`.

## Weaknesses / edge cases

- Does not change behavior when `CONTENTSTACK_BASE_URL` / `CONTENTSTACK_MANAGEMENT_BASE_URL` are explicitly set to a bad value — by design (env override still wins).
- Does not prove a live HTTP round-trip to ContentStack in this environment (no credentials / Maven deps).
- Regression coverage is the new JUnit class; CI must have Artifact Registry auth to execute it.

## Traceability

| Clause (from `bugfix.md`) | Covered by |
|----------------------------|------------|
| Expected: local CDN default SHALL be `https://cdn.contentstack.io/v3` | yaml fix + `localProfile_contentStackServiceDefault_isCdnV3WithoutTestSuffix` |
| Expected: local Management default SHALL be `https://api.contentstack.io/v3` | yaml fix + `localProfile_contentStackEntryServiceDefault_isManagementV3WithoutTestSuffix` |
| Unchanged #1: genuine 4xx → ECS_40001 contract | `badRequestErrorCode_remainsEcs40001WithDownstreamMessage` (constants unchanged) |
| Unchanged #3: non-local / test yamls stay `/v3` | `testProfile_contentStackCdnAndManagementDefaults_remainV3WithoutTestSuffix` |
| Unchanged #4: preview local default unchanged | `localProfile_previewServiceDefault_remainsPreviewV3` |
| Unchanged #2 / #5 (handler 4xx resolve / 5xx paths) | No code touch in handler — preserved by omission |
