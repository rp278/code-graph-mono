# Root cause — ECS_40001 Bad request to downstream service

**Repo:** `ecom-content-stack`  
**Slug:** `bug-error-stack-trace-serviceerrors-code`  
**Based on:** Gate 1–approved `bugfix.md`

## Hypothesis

The local-profile default base URLs for `content-stack-service` and `content-stack-entry-service` incorrectly end in `/v3/test` instead of `/v3`. When those env vars are unset, the platform reactive client calls ContentStack at invalid paths; ContentStack responds with HTTP 4xx; `ContentStackExceptionHandler` maps that to `serviceErrors` with `ECS_40001` / `Bad request to downstream service.`

## Evidence

### Faulty defaults (cause)

`application-local.yaml` lines 34–40:

```yaml
content-stack-service:
  is-secured: false
  base-url: ${CONTENTSTACK_BASE_URL:https://cdn.contentstack.io/v3/test}
  ...
content-stack-entry-service:
  is-secured: false
  base-url: ${CONTENTSTACK_MANAGEMENT_BASE_URL:https://api.contentstack.io/v3/test}
```

Compare with the same file on `develop` and with every other env:

| Source | CDN / Management default |
|--------|--------------------------|
| `application-local.yaml` (current, `RFW-9777-demo`) | `…/v3/test` |
| `develop` / `application-tst.yaml` / `application-test.yaml` / `.github/envs/*` | `…/v3` |
| `content-stack-preview-service` (same local file) | `…/v3` (already correct) |

Git: commit `9e5b5b0` (“Demo”) introduced the `/test` suffix on those two defaults.

### Trace: input → fault → symptom

1. App starts with Spring profile `local` and without `CONTENTSTACK_BASE_URL` / `CONTENTSTACK_MANAGEMENT_BASE_URL`.
2. Platform reactive client config binds `com.tailoredbrands.platform.services.content-stack-service.base-url` (and entry-service) from the yaml defaults above (`ReactiveClientConfig` / `CONTENT_STACK_SERVICE_ROOT`).
3. Any CDN or Management API call is issued against `https://cdn.contentstack.io/v3/test/...` or `https://api.contentstack.io/v3/test/...`.
4. ContentStack returns HTTP 4xx for the invalid path.
5. `ContentStackExceptionHandler.mapException` takes the 4xx branch → `map4xxErrorMono` → when the body is empty or lacks a resolvable `error_code`, `defaultBadRequestError()` returns:

```java
ServiceError.builder()
    .code(ErrorCode.BAD_REQUEST.getCode())      // ECS_40001
    .message(ErrorCode.BAD_REQUEST.getMessage()) // "Bad request to downstream service."
    .build()
```

That matches the reporter payload exactly. The handler is behaving as designed; the bad URL defaults are what force the 4xx.

## Bug condition C

`local` profile is active **and** `CONTENTSTACK_BASE_URL` is unset (or empty so the yaml default applies) **and/or** `CONTENTSTACK_MANAGEMENT_BASE_URL` is unset — i.e. the effective default string contains `/v3/test` rather than ending at `/v3`.

Under C, any ContentStack CDN/Management call that uses that client base URL is routed to an invalid root and can surface as `ECS_40001`.

## Postcondition P

After the fix, under the same inputs that satisfy C (local profile, those env vars unset):

- Effective default for `content-stack-service.base-url` **SHALL** be `https://cdn.contentstack.io/v3`
- Effective default for `content-stack-entry-service.base-url` **SHALL** be `https://api.contentstack.io/v3`
- Neither default string **SHALL** contain the path segment `/test` after `/v3`

## Preservation (`¬C ⇒ F'(x) = F(x)`)

Covers Unchanged clauses from `bugfix.md`:

| ¬C / nearby case | Must stay identical | Maps to Unchanged # |
|------------------|---------------------|---------------------|
| Genuine downstream 4xx with empty/unparseable body | Still `defaultBadRequestError()` → ECS_40001 | 1 |
| 4xx body with resolvable `error_code` | Still `handleContentStackErrorResponse` | 2 |
| Non-local yamls / GitHub envs | Untouched `/v3` values | 3 |
| Preview service local default | Remains `https://rest-preview.contentstack.com/v3` | 4 |
| 5xx / CB / rate-limit / bulkhead / format errors | Handler paths unchanged | 5 |
| Explicit env override to a custom base URL | Still wins over the yaml default | (implicit) |

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Bug in `defaultBadRequestError` / wrong code-message pair | Constants and handler match the intended BAD_REQUEST contract; changing them would break legitimate 4xx mapping (Unchanged #1). |
| Bug in `ContentStackServiceImpl` call construction | Relative paths use `/content_types/...` against a configured base; the only local default that diverges from every other env is the `/test` suffix. |
| Missing/wrong API keys causing 400 | Would not explain why only local defaults differ from develop/tst/prod with a literal `/test` path segment introduced in a Demo commit. |
| Preview URL wrong | Preview default is already `/v3`; reporter symptom fits CDN/Management clients. |

Stage 3 will falsify this hypothesis if restoring `/v3` does not remove the forced bad-default condition (or if a bug-condition check of the yaml defaults does not fail on current code).

## Proposed fix (approach only)

In `application-local.yaml`, change the two defaults:

- `https://cdn.contentstack.io/v3/test` → `https://cdn.contentstack.io/v3`
- `https://api.contentstack.io/v3/test` → `https://api.contentstack.io/v3`

No Java changes.

## Final scope fence

**Allowed to change:**

- `src/main/resources/application-local.yaml` — only the default string values of:
  - `com.tailoredbrands.platform.services.content-stack-service.base-url`
  - `com.tailoredbrands.platform.services.content-stack-entry-service.base-url`

**Not allowed without re-opening Gate 2:**

- Any `.java` source
- Other yaml/env files
- Preview service URL
- Error-code / exception-handler logic
