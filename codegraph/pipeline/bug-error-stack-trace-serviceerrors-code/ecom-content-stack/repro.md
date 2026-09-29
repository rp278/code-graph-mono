# Repro & baseline — ECS_40001 Bad request to downstream service

**Repo:** `ecom-content-stack`  
**Slug:** `bug-error-stack-trace-serviceerrors-code`  
**Branch:** `pipeline/bug-error-stack-trace-serviceerrors-code/ecom-content-stack`  
**Gate:** `3_repro`  
**Source changes:** none (tests + `.pipeline/` only)

## Hypothesis under test

Local-profile defaults for `CONTENTSTACK_BASE_URL` / `CONTENTSTACK_MANAGEMENT_BASE_URL` are `…/v3/test` instead of `…/v3`, which forces downstream 4xx mapped to `ECS_40001`.

## Tests added

`src/test/java/com/tailoredbrands/contentstack/config/ContentStackLocalBaseUrlDefaultsTest.java`

| Test | Role | Expected on unfixed code |
|------|------|--------------------------|
| `localProfile_contentStackServiceDefault_isCdnV3WithoutTestSuffix` | Bug condition C / postcondition P | **FAIL** |
| `localProfile_contentStackEntryServiceDefault_isManagementV3WithoutTestSuffix` | Bug condition C / postcondition P | **FAIL** |
| `localProfile_previewServiceDefault_remainsPreviewV3` | Preservation (Unchanged #4) | **PASS** |
| `testProfile_contentStackCdnAndManagementDefaults_remainV3WithoutTestSuffix` | Preservation (Unchanged #3) | **PASS** |
| `badRequestErrorCode_remainsEcs40001WithDownstreamMessage` | Preservation (Unchanged #1 contract) | **PASS** |

## Maven suite attempt

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
./mvnw -Dtest=ContentStackLocalBaseUrlDefaultsTest test
```

**Result:** build failed before tests ran — private parent POM
`com.tailoredbrands.platform:tb-platform-parent:release-1.0.7-441` returns
**401 Unauthorized** from `us-east4-maven.pkg.dev/np-ecom-1-08ba/ecom-artifacts`.
No JUnit XML was produced. This environment cannot resolve TB platform artifacts.

Per pipeline policy (Stage 3 step 5 / hard rule 4): tests are written; execution falls back to recorded manual/standalone evidence below (not a fake green suite).

## Standalone assertion run (same predicates as the JUnit class)

Command (from repo root, unfixed tree):

```bash
python3 <<'PY'
# same checks as ContentStackLocalBaseUrlDefaultsTest against
# application-local.yaml / application-test.yaml / ErrorCode constants
PY
```

Observed output:

```
[FAIL] BUG local CDN default == …/v3 — 'https://cdn.contentstack.io/v3/test'
[FAIL] BUG local CDN has no /v3/test — 'https://cdn.contentstack.io/v3/test'
[FAIL] BUG local Management default == …/v3 — 'https://api.contentstack.io/v3/test'
[FAIL] BUG local Management has no /v3/test — 'https://api.contentstack.io/v3/test'
[PASS] PRESERVE preview default == …/v3 — 'https://rest-preview.contentstack.com/v3'
[PASS] PRESERVE preview has no /test — 'https://rest-preview.contentstack.com/v3'
[PASS] PRESERVE test CDN == …/v3 — 'https://cdn.contentstack.io/v3'
[PASS] PRESERVE test Management == …/v3 — 'https://api.contentstack.io/v3'
[PASS] PRESERVE ECS_40001 constant
[PASS] PRESERVE BAD_REQUEST_MESSAGE
[PASS] PRESERVE ErrorCode.BAD_REQUEST uses those

Bug-condition: 4 FAIL, 0 PASS (hypothesis requires FAIL>0)
Preservation:  7 PASS, 0 FAIL (hypothesis requires FAIL==0)
OVERALL: MATCHES HYPOTHESIS
```

Failure reason matches the root-cause claim: defaults are literally `…/v3/test`, not a different mismatch.

## Manual repro steps (observed)

1. Open `src/main/resources/application-local.yaml`.
2. Note `content-stack-service.base-url` default:
   `https://cdn.contentstack.io/v3/test`.
3. Note `content-stack-entry-service.base-url` default:
   `https://api.contentstack.io/v3/test`.
4. Compare with `develop` / `application-test.yaml` / `.github/envs/*`: those use `/v3` only.
5. With profile `local` and no `CONTENTSTACK_BASE_URL` /
   `CONTENTSTACK_MANAGEMENT_BASE_URL` overrides, clients call ContentStack under
   `/v3/test/…`; a 4xx with empty/unparseable body is mapped by
   `ContentStackExceptionHandler.defaultBadRequestError()` to
   `{ code: "ECS_40001", message: "Bad request to downstream service." }`.

## No non-test source changes

```bash
git diff --stat -- ':!*.test.*' ':!.pipeline' ':!**/src/test/**'
```

Empty (only untracked `.pipeline/` + the new test class). Confirmed: **no** edits under `src/main/`.

## Gate 3 ask

Approve on evidence: bug-condition predicates fail on unfixed defaults for the predicted reason; preservation predicates pass; Maven blocked only by artifact auth, not by contradictory test results; no source fix yet.
