# Requirement-Intake Pipeline — Design Doc (draft for review)

## 0. Goal

Turn a single free-text requirement into fully implemented, cross-repo,
QA-ready changes — via a **repeatable pipeline of mandatory gated
stages**. Every story passes through every gate. **No gate is ever
skipped, regardless of assessed risk.** This is a hard rule, not a
default.

Grounded in decisions already made this session:
- EARS notation for requirements/acceptance criteria.
- Dependency-wave execution for multi-repo implementation.
- Steering files with inclusion modes (always / glob / manual) driving
  agent behavior per stage.
- The knowledge graph (Neo4j via `codegraph/api`) is the source of
  truth for "what exists and how it connects" — stages query it
  instead of guessing, and it auto-updates on every merge (already
  built and verified).

---

## 1. Pipeline stages

```
Requirement (free text)
      │
      ▼
┌─────────────────────────────────────────┐
│ STAGE 1 — Analyze & Decompose            │
│ query codeGraph → per-repo EARS stories  │
└─────────────────────────────────────────┘
      │
     GATE 1: user approves the story breakdown
      │
      ▼  (per story, can run in parallel across repos)
┌─────────────────────────────────────────┐
│ STAGE 2 — Plan + Clarifying Questions    │
│ design.md per story + open questions     │
└─────────────────────────────────────────┘
      │
     GATE 2: user approves plan / answers questions
      │
      ▼
┌─────────────────────────────────────────┐
│ STAGE 3 — Implement (dependency waves)   │
│ code changes on a story branch           │
└─────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│ STAGE 4 — Self-Critique                  │
│ critique.md: weaknesses, better options  │
└─────────────────────────────────────────┘
      │
     GATE 3: user approves implementation (or sends back to Stage 3)
      │
      ▼
┌─────────────────────────────────────────┐
│ STAGE 5 — Traceability Verification      │
│ line-by-line: EARS clause → code/test    │
└─────────────────────────────────────────┘
      │
     GATE 4: user signs off traceability matrix
      │
      ▼
┌─────────────────────────────────────────┐
│ STAGE 6 — QA Validation Checklist        │
│ qa-checklist.md, derived from EARS       │
└─────────────────────────────────────────┘
      │
     GATE 5: QA checklist accepted → story marked done
      │
      ▼
┌─────────────────────────────────────────┐
│ STAGE 7 — Merge                          │
│ story branch → repo's master             │
│ (existing GitHub Action fires graph      │
│  rebuild automatically — already built)  │
└─────────────────────────────────────────┘
```

No stage advances without its gate explicitly passing in this chat.
If a gate fails (user requests changes), the pipeline loops back to
the stage that produced the rejected artifact — it does not skip
forward.

---

## 2. Stage 1 — Analyze & Decompose

**Input:** a free-text requirement.

**What the agent does:**
1. Query `codegraph/api` (`/api/query`, `/api/graph`) for nodes/edges
   relevant to the requirement's keywords/entities — which repos,
   files, endpoints, components are actually implicated. This replaces
   guessing with grounding in the real current structure.
2. Identify which of the 4 repos (`shop-api`, `shop-web`, `graphify`,
   `codegraph`) need changes.
3. Write one **EARS-notation story** per affected repo.

**EARS format** (Easy Approach to Requirements Syntax):
```
WHEN <trigger/condition>
THE SYSTEM SHALL <observable response>
```
Example, for a hypothetical "add wishlist" requirement split across
repos:
```
Story: shop-api — Wishlist endpoints
  WHEN a client sends POST /api/wishlist with a valid product id
  THE SYSTEM SHALL persist the item and return 201 with the created record

  WHEN a client sends GET /api/wishlist
  THE SYSTEM SHALL return all wishlist items for that session

Story: shop-web — Wishlist UI
  WHEN a signed-in user clicks "Add to wishlist" on a product card
  THE SYSTEM SHALL call shop-api's wishlist endpoint and show a confirmation
```

**Output artifact:** `pipeline/<requirement-slug>/stories.md` —
requirement text, graph-query evidence used, and the full list of
per-repo EARS stories.

**GATE 1:** Present `stories.md` to the user. Proceed only on explicit
approval. If the user edits/rejects scope, revise and re-present —
never assume approval, never partially proceed on "obviously fine"
stories only.

---

## 3. Stage 2 — Plan + Clarifying Questions

Per approved story (can happen in parallel across independent stories):

**What the agent does:**
1. Read the actual affected files/modules (grounded, not assumed).
2. Draft a plan: approach, files to change, risks, alternatives
   considered, and any genuinely ambiguous decisions.
3. Ask clarifying questions **before** writing code, using the
   `AskQuestion` tool for discrete choices, plain text for open
   architecture questions (matches your established preference this
   session).

**Output artifact:** `pipeline/<requirement-slug>/<repo>/design.md`.

**GATE 2:** User approves the plan (after questions are answered).
Implementation does not start on a story until its own plan is
approved — other stories' Stage 2 work can proceed independently in
the meantime.

---

## 4. Stage 3 — Implementation (dependency-wave execution)

**Wave computation:** before implementing, build a dependency graph
between the approved stories themselves (not just tasks within one
story) — e.g. "shop-web's wishlist UI depends on shop-api's wishlist
endpoint existing" or "a shared graphify extractor change must land
before repos that rely on its new node type." Group stories into
waves:

```
Wave 1: stories with no dependencies on other stories in this
        requirement (run concurrently, e.g. via parallel subagent
        Tasks — one per repo/story)
Wave 2: stories depending only on Wave 1 (run concurrently once
        Wave 1's implementation — not full pipeline, just the code —
        is in place)
Wave N: ...
```

Each story is implemented on its own branch (`pipeline/<slug>/<repo>`),
never directly on `master`. Within a wave, independent stories run
concurrently; waves themselves run sequentially.

**Output:** actual diffs/commits on the story branch. No merge yet —
merge only happens after Stage 7's gate.

---

## 5. Stage 4 — Self-Critique

**What the agent does**, per implemented story:
1. Re-read the diff against the plan and the EARS story.
2. Explicitly list weaknesses, edge cases missed, or better approaches
   available (e.g. "this works but a cleaner approach would be X").
3. Optionally invoke the `bugbot` and/or `security-review` subagents
   for an independent second opinion on the diff.

**Output artifact:** `pipeline/<requirement-slug>/<repo>/critique.md`
— findings + what (if anything) was revised as a result before
presenting for approval.

**GATE 3:** User reviews the critique and the (possibly revised)
implementation, approves or sends specific stories back to Stage 3.

---

## 6. Stage 5 — Traceability Verification

**What the agent does:** build a matrix mapping **every single EARS
clause** from Stage 1 to the specific code (file/function/line) and/or
test that satisfies it, explicitly marking each as
Verified / Partially verified / Not verified.

```
| EARS clause                                   | Implemented in                     | Status     |
|------------------------------------------------|-------------------------------------|------------|
| WHEN POST /api/wishlist ... SHALL persist ...   | shop-api/src/routes/wishlist.js:14  | Verified   |
| WHEN GET /api/wishlist ... SHALL return ...     | shop-api/src/routes/wishlist.js:29  | Verified   |
```

Any clause not fully verified blocks the gate — it goes back to Stage
3, not forward with a caveat.

**Output artifact:**
`pipeline/<requirement-slug>/<repo>/traceability.md`.

**GATE 4:** User signs off the traceability matrix.

---

## 7. Stage 6 — QA Validation Checklist

**What the agent does:** turn each EARS clause into a concrete,
executable QA step — manual or scripted — that a QA person (or you)
can run to confirm the behavior, independent of reading the code.

```
[ ] POST /api/wishlist with a valid product id → expect 201 + record
    with matching product id, persisted (confirm via GET afterward)
[ ] POST /api/wishlist with an invalid/nonexistent product id →
    expect 4xx, no record created
[ ] Click "Add to wishlist" on any product card as a signed-in user →
    confirmation toast appears, item shows in /wishlist page
```

**Output artifact:**
`pipeline/<requirement-slug>/<repo>/qa-checklist.md`.

**GATE 5 (final):** Checklist accepted → story marked `done` in the
pipeline state file.

---

## 8. Stage 7 — Merge

Once every gate for a story has passed: merge the story branch into
that repo's `master`. This is the **only** stage that's already fully
built and proven this session — the existing GitHub Actions workflow
fires automatically, calls the (now single-flight, coalescing-safe)
`/api/graph/rebuild` endpoint, and the knowledge graph updates within
seconds. Nothing new needed here.

---

## 9. Cross-cutting mechanics

### 9.1 No-skip-gates enforcement

This is a **process rule**, not something Cursor can mechanically
lock — it has to be encoded as an explicit, always-applied steering
instruction the agent follows: *"Never advance to the next stage
without an explicit approval message from the user in this
conversation, regardless of how low-risk or obvious a story seems."*
This will be stated directly (and repeatedly, at each gate) in the
pipeline's own skill/rule file so it isn't quietly forgotten mid-run.

### 9.2 Steering files (inclusion modes)

Proposed new files under `.cursor/rules/`:

| File | Inclusion mode | Purpose |
|---|---|---|
| `pipeline-gates.md` | `alwaysApply: true` | The no-skip-gate rule + stage order, applies for the whole pipeline session |
| `pipeline-ears.md` | `alwaysApply: true` | EARS syntax + examples, used during Stage 1 |
| `pipeline-waves.md` | manual (referenced explicitly during Stage 3 planning) | How to compute/execute dependency waves |
| `shop-api-conventions.md` | glob: `shop-api/**` | Repo-specific conventions, auto-included only when touching that repo |
| `shop-web-conventions.md` | glob: `shop-web/**` | Same, for shop-web |

### 9.3 Pipeline state (resumable across sessions)

`pipeline/<requirement-slug>/state.json` tracks, per story: current
stage, gate pass/fail history, branch name, artifact paths. Lets a
pipeline run pause after any gate and resume later (new chat session)
without re-deriving state from scratch.

### 9.4 Folder layout

Rules and the orchestrating skill live at the workspace root (they span
all 4 repos). Per-run artifacts live inside `codegraph`, per decision #2
in §10, since the pipeline is already built on top of `codegraph/api`'s
graph queries:

```
code-graph-wsp/                           (workspace root)
  .cursor/
    rules/
      codegraph.md              (existing)
      pipeline-gates.mdc        (new — built)
      pipeline-ears.mdc         (new — built)
      pipeline-waves.mdc        (new — built)
    skills/
      requirement-pipeline/
        SKILL.md                (new — orchestrates all 7 stages)
  codegraph/                               (repo: pipeline artifacts live here)
    pipeline/
      DESIGN.md                 (this file)
      <requirement-slug>/
        requirement.md          (original prompt + graph evidence)
        stories.md                                                    [GATE 1]
        state.json
        shop-api/
          design.md                                                   [GATE 2]
          critique.md                                                  [GATE 3]
          traceability.md                                              [GATE 4]
          qa-checklist.md                                              [GATE 5]
        shop-web/
          ...same shape...
```

---

## 10. Decisions (locked in)

1. **Branch/PR mechanics — PR for visibility only, gate is chat-only**
   (revised — see §10.1a). Each story is still implemented on its own
   branch and opened as a real GitHub PR against that repo's `master`,
   with the critique/traceability/QA docs posted to it. But **the PR is
   no longer part of the gate mechanism** — it's kept purely for
   visibility, CI, and history. All 5 gates are approved in chat only;
   an open, unreviewed, or even CI-red PR does not block a gate, and a
   gate passing in chat does not require any GitHub-side action on the
   PR. Gate 7 (merge) is still the literal PR merge (simplest way to
   fire the existing GitHub Action → rebuild), performed once Gate 5 has
   passed in chat — not because the PR itself was "approved" on GitHub.
   This still needs a GitHub credential with **write** access (branches
   + PRs), a step up from the VM's deliberately read-only rebuild
   credential; see §11.

### 10.1a Amendment: PR approval gate removed

Originally, gates 3 and 4 were meant to be "companion checks" — chat
approval *and* PR review, neither a substitute for the other (see the
now-superseded rule 5 previously in `pipeline-gates.mdc`). This was
removed: PRs are opened for visibility only, and no gate depends on any
GitHub-side PR state (open/reviewed/approved/checks). Only the chat
approval matters for advancing past a gate.
2. **Artifact location — inside the `codegraph` repo.**
   `pipeline/<requirement-slug>/...` is committed to `codegraph`,
   versioned alongside the graph tooling it's built on top of (it
   already depends on `codegraph/api` for Stage 1's graph queries).
3. **Wave concurrency — true parallel subagent `Task` calls.**
   Independent stories within a wave are dispatched as separate
   parallel subagent tasks (one per story), not run one-at-a-time.
   Waves themselves remain sequential (a wave doesn't start until the
   previous wave's stories are implemented).

## 11. Credential requirement introduced by decision #1

Every GitHub write so far this session (pushing directly to `master`)
used credentials already cached in the local git credential
helper/keychain on this Mac — sufficient for `git push`. Opening PRs
via the GitHub API additionally needs a token with `pull_requests:
write` (classic PAT: `repo` scope, or fine-grained: "Pull requests:
Read and write" + "Contents: Read and write") and the `gh` CLI (or
equivalent API calls) available locally. This is separate from — and
should stay separate from — the VM's fine-grained, read-only,
rebuild-only PAT; that one must not gain write scope.
