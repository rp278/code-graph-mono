# Bugfix — ECS_40001 Bad request to downstream service

**Slug:** `bug-error-stack-trace-serviceerrors-code`  
**Kind:** bug  
**Title (inferred — reporter left title blank):** Local ContentStack base URLs append `/test`, causing ECS_40001  
**Affected repo:** `ecom-content-stack` (only)

## Intake (verbatim)

```json
{
    "serviceErrors": [
        {
            "code": "ECS_40001",
            "message": "Bad request to downstream service."
        }
    ]
}
```

Repo hints: none. Extra details: none.

## Signals

| Signal | Source |
|--------|--------|
| `serviceErrors` | Response envelope field |
| `ECS_40001` | Error code constant |
| `Bad request to downstream service.` | Exact error message string |
| No file/line/stack frames | Reporter gave response body only |

## Graph evidence

**Graph: used** (API `http://127.0.0.1:8000`, short timeout), then **file search** to pin the misconfiguration (yaml defaults are not graph nodes).

### Graph queries + hits

1. `MATCH (n) WHERE toLower(coalesce(n.label,'')) CONTAINS 'ecs_40001' …` → **0 rows** (literal code string not indexed as a node label).
2. `… CONTAINS 'errorcode'` → hit `ErrorCode.java` in **ecom-content-stack** (among unrelated hits in other repos).
3. `… CONTAINS 'contentstackexceptionhandler'` → hit `ContentStackExceptionHandler` / `.defaultBadRequestError()` / `.map4xxErrorMono()` in **ecom-content-stack**.
4. Blast-radius walk from `ContentStackExceptionHandler`: `mapException` → `map4xxErrorMono` → `defaultBadRequestError` / `resolveServiceErrors` (same repo). No cross-repo `FETCHES` consumers of this error code showed up for the literal signal.
5. `… application-local …` → **0 rows** (config file not in graph).

### File-search fallback (config / constants)

Commands (workspace `code-repos/`):

- `rg 'ECS_40001|Bad request to downstream service|serviceErrors' code-repos/`
- `rg 'cdn\\.contentstack\\.io|api\\.contentstack\\.io|/v3/test' code-repos/ecom-content-stack`

Hits that define the reported payload:

- `ServiceConstants.ECS_40001 = "ECS_40001"`
- `ErrorConstants.BAD_REQUEST_MESSAGE = "Bad request to downstream service."`
- `ErrorCode.BAD_REQUEST(ECS_40001, BAD_REQUEST_MESSAGE)`
- `ContentStackExceptionHandler.defaultBadRequestError()` builds the reported `{code, message}` list for unparseable / empty 4xx bodies

Hit that explains *why* that payload appears under local defaults (not in graph):

- `src/main/resources/application-local.yaml` defaults:
  - `content-stack-service.base-url` → `https://cdn.contentstack.io/v3/test`
  - `content-stack-entry-service.base-url` → `https://api.contentstack.io/v3/test`
- Same keys on `develop`, `application-test.yaml`, `application-tst.yaml`, and `.github/envs/*` use `/v3` **without** `/test`.
- Recent local commit on `RFW-9777-demo` (“Demo”) introduced the `/test` suffix; preview base URL was left correct.

**Path used:** Graph located the error-code / handler home repo; file search located the broken local URL defaults. No invented graph hits.

## Current behavior

WHEN the `local` Spring profile runs without `CONTENTSTACK_BASE_URL` / `CONTENTSTACK_MANAGEMENT_BASE_URL` env overrides  
THEN the reactive ContentStack CDN and Management clients call `…/v3/test…` paths  
AND ContentStack rejects those as bad requests  
AND the service surfaces `serviceErrors: [{ code: "ECS_40001", message: "Bad request to downstream service." }]`.

## Expected behavior

WHEN the `local` Spring profile runs without those env overrides  
THEN the default CDN base URL SHALL be `https://cdn.contentstack.io/v3`  
AND the default Management base URL SHALL be `https://api.contentstack.io/v3`  
AND outbound ContentStack calls SHALL use the same `/v3` roots as other environments (so a correct local request is not forced into ECS_40001 by a bad default path).

## Unchanged behavior

1. WHEN ContentStack (or another downstream) genuinely returns HTTP 4xx with an empty/unparseable body  
   THEN the system SHALL CONTINUE TO map that via `defaultBadRequestError()` to `ECS_40001` / `Bad request to downstream service.`
2. WHEN ContentStack returns 4xx with a recognizable `error_code` in the body  
   THEN the system SHALL CONTINUE TO resolve via `exceptionHandler.handleContentStackErrorResponse(…)`.
3. WHEN non-local profiles / test resources / GitHub env YAMLs define ContentStack base URLs  
   THEN those files SHALL CONTINUE TO use their existing `/v3` values (no drive-by edits).
4. WHEN `content-stack-preview-service.base-url` is configured for local  
   THEN it SHALL CONTINUE TO default to `https://rest-preview.contentstack.com/v3` (already correct).
5. WHEN 5xx / circuit-breaker / rate-limit / bulkhead / invalid-format paths run in `ContentStackExceptionHandler`  
   THEN those mappings SHALL CONTINUE TO be unchanged.

## Candidate location

| Area | Role |
|------|------|
| `application-local.yaml` → `content-stack-service.base-url` | Mis-default CDN root (`/v3/test`) — primary cause |
| `application-local.yaml` → `content-stack-entry-service.base-url` | Mis-default Management root (`/v3/test`) — same class of cause |
| `ContentStackExceptionHandler.defaultBadRequestError()` | Correct mapping of the *symptom*; not the fault |
| `ErrorCode.BAD_REQUEST` / constants | Definitions of the reported strings; not the fault |

## Provisional scope fence

**In scope (expected fix surface):**

- `ecom-content-stack/src/main/resources/application-local.yaml` — only the two ContentStack service `base-url` default values that incorrectly end in `/v3/test` (restore `/v3`).

**Out of scope unless Gate 2 widens the fence:**

- `ContentStackExceptionHandler`, `ErrorCode`, `ErrorConstants`, `ServiceConstants`
- Other YAML profiles / env files
- `ContentStackServiceImpl` business logic
- Any frontend / xapi consumer

## Open questions

None that block analysis: the reported payload matches the BAD_REQUEST constant pair uniquely owned by `ecom-content-stack`, and the only local default that diverges from every other env is the `/test` URL suffix.
