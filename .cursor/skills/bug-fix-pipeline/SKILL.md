---
name: bug-fix-pipeline
description: >-
  Runs this workspace's gated bug-fix pipeline: takes a pasted error
  message / stack trace (plus optional repo hints and extra details),
  locates the bug with the live codeGraph (falling back to searching the
  code itself if the graph has no match or is unreachable), forms a falsifiable root-cause
  hypothesis, proves it with a failing test and passing preservation tests
  BEFORE touching source, then applies a minimal in-scope fix and drives it
  through 4 mandatory approval gates (analysis, root cause, reproduce, fix)
  and opening a real GitHub PR. The pipeline NEVER merges the PR: it
  stops with the PR open for a human to review and merge. Use when the
  run's kind is "bug", or the user gives an error/bug report and asks to
  run it through the bug pipeline.
---

# Bug-fix Pipeline

Sibling of the `requirement-pipeline` skill. Same state machine, same
headless protocol, same PR-opening mechanics — different stages and
different evidence. Do not re-derive shared mechanics; read them from the
feature skill where referenced below.

**Repo paths.** The work repos live in `code-repos/` at the workspace root. Everywhere below, `<repo>` means `code-repos/<repo>`.

**Artifacts live in this workspace, never in the work repos.** Write
`bugfix.md`, `rootcause.md`, `repro.md` and `fix.md` to
`codegraph/pipeline/<slug>/<repo>/` (the *artifact dir*, next to
`state.json`). Do **not** create a `.pipeline/` folder in any work repo, do
not write `state-ref.json`, and do not commit or push any of these
documents. The dashboard reads them from the artifact dir. The only
files a story may change inside a work repo are the test files (Stage 3)
and the source fix (Stage 4).

**A bug run ends at an open PR. It never merges.** Do not run
`gh pr merge`, `gh api ... /merge`, enable auto-merge, or push to the base
branch — not at any stage, and not even if a later message asks you to.
Merging is a human action outside this pipeline. (The feature skill's
"Stage 7 — Merge" does **not** apply to bug runs.)

## Before anything else

1. Read `.cursor/rules/pipeline-gates.mdc` (the no-skip rule, cascade
   rules, and the **Headless mode** section — this run is almost always
   headless, `HEADLESS_MODE: true`) **and** `.cursor/rules/pipeline-bugfix.mdc`
   (the 4 bug gates and the bug-specific hard rules).
2. Read `.cursor/rules/pipeline-ears.mdc` — `bugfix.md` uses the same
   WHEN / THEN / SHALL phrasing.
3. Use the slug given in the prompt. `state.json` for this run already
   exists at `codegraph/pipeline/<slug>/state.json` with `agent_id` and
   `"kind": "bug"` — preserve both. Artifacts live under
   `codegraph/pipeline/<slug>/<repo>/` (the artifact dir) for every repo
   that gets a story. Nothing is written to the work repos except tests and
   the fix.
4. Story entries for a bug use **bug gate keys**:
   ```json
   "<repo-id>": {
     "stage": "1-analysis",
     "gates": {"1_analysis": null, "2_rootcause": null, "3_repro": null,
               "4_fix": null},
     "base_branch": null, "branch": null, "pr_url": null
   }
   ```
5. The input is an **intake block** with these parts (any except the error
   may be missing):
   - `Error / stack trace` — verbatim, the primary evidence.
   - `Title` — may be blank; if so, write a short one yourself and note it.
   - `Repo hints` — repos the reporter **selected**. Investigate these
     **first and thoroughly** (graph queries filtered to them, then file
     search + reading the code in their checkouts). If a credible cause is
     there, stay there: the story is for that repo, and other repos are
     only visited to map the blast radius. Widen to the other repos only
     when the selected repos hold no credible cause, and say so explicitly
     at Gate 1 (what was searched, why nothing matched). Record the search
     order under "Search order" in `bugfix.md`.
   - `Extra details` — free text (when it happens, what changed recently).

## Stage 1 — Analyze & Locate

1. **Extract signals** from the error text: file paths, line numbers,
   function/class names, HTTP routes and status codes, SQL/table names,
   error class + message, package names. Write them down in `bugfix.md`
   under "Signals".
2. **Locate with the graph, don't guess.** Query the live graph the same
   way as `requirement-pipeline` Stage 1 (`$GRAPH_API_URL`, default
   `http://127.0.0.1:8000`; bearer token from `codegraph/web/.env`
   `VITE_API_TOKEN` if set, never print it), searching for
   each signal (`toLower(n.label) CONTAINS "<signal>"`). Then walk
   outward from the hit to get the **blast radius**: callers, importers,
   and API consumers of the suspect function/route (in *other* repos too —
   e.g. a `shop-api` route consumed by `shop-web`). If repo hints were
   given, query and search **only those repos first** (filter on
   `n.repo IN [...]`); widen only if they hold no credible cause. If the
   graph disagrees with the hints, report the disagreement.
   **The graph is a map, not the code.** It holds structure (files,
   functions, endpoints, `FETCHES` / `CALLS` / `IMPORTS_FROM` edges), not
   what the code does, and it is built from *pushed* code — it will not
   reflect uncommitted local changes. Use it to find *where to look*
   (which repo, file, endpoint, and who consumes it); then read the real
   files in the local checkout to find *what is wrong*. A node's
   `source_file` is a path on the machine that indexed it (e.g.
   `/opt/code-graph-wsp/shop-api/src/server.js`): map it to the local
   checkout by repo name + relative path (`<workspace>/shop-api/src/server.js`).

   **The graph is optional — fall back to searching the code yourself.**
   Run every graph query with a short timeout (`curl --max-time 10 ...`)
   so a dead graph can never stall the run. Treat any of these as "graph
   unavailable" and switch to the fallback below, **without stopping,
   asking, or failing the run**:
   - the query errors, times out, or returns a non-2xx / non-JSON response
     (Neo4j down, API unreachable, bad token);
   - the query succeeds but **no node matches any signal** (the graph may
     simply be stale or not know about the code).

   Fallback (same goal, different tools — use `grep` / `glob` / `read`):
   - Search **every repo checkout in the workspace** (the folders in
     `code-repos/`; `codegraph/api/repos.local.json` lists them when
     present) for each signal: file paths and function /
     class names from the stack trace, route strings (`/api/products`),
     table names, and the error message text. Start with the repo hints,
     if any.
   - Rebuild the **blast radius** by hand: for the suspect function,
     component or route, search for its callers and importers, and for
     route strings in the *other* repos' fetch / HTTP-client code
     (e.g. `grep -rn "/api/products"` in `shop-web` for a `shop-api`
     route). Follow one hop further through any wrapper you find (a
     component calling `api.getProducts()` → the fetch in `api.js`).
   - This is not a lesser mode: the code is the source of truth, so a
     fallback locate is at least as accurate as the graph — just slower
     and less exhaustive across many repos. Say so plainly in
     `bugfix.md`, and be more explicit about what you did **not**
     search.

   In `bugfix.md` → **Graph evidence**, always state which path was used:
   `Graph: used` (with the queries + hits), `Graph: no matching nodes —
   located by file search`, or `Graph: unavailable (<reason, e.g. timed
   out>) — located by file search`. For a fallback, list the exact
   search commands and hits instead of graph queries. Never invent graph
   results, and never block Gate 1 because the graph could not help.
3. Decide which repo(s) actually need a change (usually one).    Create
   the artifact dir `codegraph/pipeline/<slug>/<repo>/` for each and add a
   story entry per repo.
   **Pick the base branch per repo — do not just use whatever is checked
   out.** The base branch is the branch where the bug actually exists,
   because the story branch is cut from it and the PR targets it:
   - Default: the repo's default branch (`git symbolic-ref --short
     refs/remotes/origin/HEAD`).
   - If the bug is **not** present on the default branch (e.g. it was
     introduced on a feature/demo branch that is not merged), the base is
     that branch — it must exist on `origin`, and the reporter's extra
     details, `git branch -a` and `git log` on the suspect file usually
     show which one.
   - **Prove it:** run `git show origin/<base>:<path>` (or `git grep`) on
     the suspect line at that ref and record the output in `bugfix.md`;
     also state whether the same line is present or absent on the default
     branch. If the bug is on the default branch, the default branch is the
     base.
   - Record `base_branch` in the story's `state.json` entry. If it is not
     the default branch, say so in **Open questions** so the reviewer
     confirms it at Gate 1.
4. Write `codegraph/pipeline/<slug>/<repo>/bugfix.md` (one copy per
   affected repo's artifact dir, same content):
   - **Signals** (from step 1) and **Graph evidence** (queries + hits, or
     the file-search fallback — see step 2 — labelled as such).
   - **Current behavior** — WHEN <condition> THEN the system <wrong thing>.
   - **Expected behavior** — WHEN <condition> THEN the system SHALL <right thing>.
   - **Unchanged behavior** — WHEN <nearby condition> THEN the system
     SHALL CONTINUE TO <existing correct behavior>. Derive these from the
     blast radius: everything that touches the suspect code and must not
     change. This list drives the preservation tests in Stage 3.
   - **Candidate location** and a **provisional scope fence** (files /
     functions).
   - **Base branch** — the branch, and the proof from step 3 that the bug
     exists at that ref.
   - **Open questions**, if the report is genuinely ambiguous.

**GATE 1 (`1_analysis`)**: present `bugfix.md`. Headless: write
`pending_gate` and end the turn.

## Stage 2 — Root cause (no code changes)

1. Read the actual code at the candidate location and trace the failing
   path end to end. Read what calls into it and what it calls.
2. Write `codegraph/pipeline/<slug>/<repo>/rootcause.md`:
   - **Hypothesis** — one plain sentence naming the faulty line/logic and
     *why* it produces the observed error.
   - **Evidence** — `file:line` references and the trace that connects
     input → fault → symptom. Quote the relevant lines.
   - **Bug condition C** — a precise predicate for inputs/states that
     trigger the bug.
   - **Postcondition P** — what must be true for inputs satisfying C after
     the fix.
   - **Preservation** — for inputs *not* satisfying C, behavior must be
     identical to today (`¬C ⇒ F'(x) = F(x)`); list which Unchanged
     clauses from `bugfix.md` this covers.
   - **Alternatives considered** — other hypotheses and why they were
     rejected (or that they remain possible and how Stage 3 will
     distinguish them).
   - **Proposed fix** (approach only, no code) and the **final scope
     fence**.
3. This document is the human checkpoint: the reviewer is checking your
   reasoning, not just your conclusion.

**GATE 2 (`2_rootcause`)**: present `rootcause.md`. Headless: write
`pending_gate` and end the turn.

## Stage 3 — Reproduce & baseline (still no source changes)

Branch: `pipeline/<slug>/<repo>` (create it now), cut from
`origin/<base_branch>` (`git fetch origin && git checkout -b
pipeline/<slug>/<repo> origin/<base_branch>`) — never from whatever branch
happens to be checked out. Only **test files** may change in the work repo
in this stage (`repro.md` goes to the artifact dir, not the repo).

1. **Detect the test setup** from `<repo>/package.json` `scripts.test`:
   - `shop-web`: Vitest + React Testing Library (`npm test`); tests live
     beside sources as `*.test.js(x)`; import `describe/it/expect/vi`
     explicitly from `vitest`.
   - `shop-api`: Node built-in runner (`npm test`); tests in `test/*.test.js`
     using `buildApp({ logger: false })` from `src/server` and Fastify
     `inject()` with `process.env.DB_PATH = ':memory:'` set **before**
     requiring the app.
   - Any other repo: use whatever its `test` script runs; if none exists,
     go to step 5.
2. **Bug-condition test(s)** — encode C and P: one or more tests that
   FAIL on the current code, for the reason predicted in `rootcause.md`.
3. **Preservation tests** — encode the Unchanged clauses: tests that PASS
   on the current code. Prefer several representative cases over one.
4. **Run the suite on the unfixed code and record real output** in
   `codegraph/pipeline/<slug>/<repo>/repro.md`: the exact command, which tests failed and the failure
   message (it must match the hypothesis — if it fails for a *different*
   reason, the hypothesis is wrong: return to Stage 2), which passed, and
   confirmation that `git diff --stat -- ':!*.test.*'` shows
   **no non-test source changes**. Commit the tests (only) on the branch.
5. **If a test genuinely cannot express the bug** (race, timing, perf,
   environment-only, no test setup), do not fake one. `repro.md` must
   state the reason, give numbered manual repro steps, and record what
   was observed when following them. Still write preservation tests if any
   are feasible.

**GATE 3 (`3_repro`)**: present `repro.md`. The reviewer approves on the
evidence "failing test on unfixed code + passing preservation tests, no
source changes" (or the stated manual-repro alternative). Headless: write
`pending_gate` and end the turn.

## Stage 4 — Fix

1. Apply the **smallest** change that satisfies the postcondition, strictly
   inside the scope fence. No refactors, no drive-by cleanups.
2. Run the full suite plus `npm run lint` (if the repo has it) and the
   build if the repo has one. Required outcome: the bug-condition tests now
   PASS, every preservation test still PASSES, no previously-passing test
   broke. Do not edit or weaken a test to make it pass; if a test itself
   is wrong, say so in `fix.md` and treat it as a Gate 3 reset.
3. Scope check: list `git diff --stat origin/<base_branch>...HEAD` (the
   base branch from `state.json`, not `develop`/`main` by default) and
   confirm every changed non-test file is inside the fence. **The
   non-test source diff against that base must be non-empty.** If it is
   empty, the fix does nothing relative to the branch the PR targets
   (usually because the bug is not on that base): stop, do not open the
   PR, and return to Stage 1 to correct `base_branch` (Gate 1 reset).
4. Write `codegraph/pipeline/<slug>/<repo>/fix.md`: what changed and why, before /
   after test results, scope check, weaknesses and edge cases (the
   self-critique), and a **traceability table** mapping each Expected and
   Unchanged clause from `bugfix.md` to the test(s) and code that cover it.
5. Commit the code fix on the story branch (source + tests only, no
   pipeline documents), push, and open the PR using the `gh` pattern in
   `requirement-pipeline` Stage 4 step 3 (PR body = the artifact-dir
   `fix.md`, passed with `--body-file codegraph/pipeline/<slug>/<repo>/fix.md`),
   **but with `--base <base_branch>` from
   `state.json`** instead of the repo's default branch. Record `pr_url` and
   `branch` in `state.json`.

**GATE 4 (`4_fix`)**: present the diff **against `<base_branch>`** + `fix.md`,
and state the PR's base branch (it must equal `base_branch`). PR state is not a gate
(see `pipeline-gates.mdc` rule 5). Headless: write `pending_gate` and end
the turn.

Once Gate 4 is approved the run is complete, and the PR stays **open**
(there is no separate QA-checklist or hand-off stage):

1. Leave the PR untouched: do not merge, close, or enable auto-merge.
2. In `state.json`, keep `pr_url` and `branch`, set `merge_status` to
   `"not_merged"` (the pipeline does not merge), and set the story's
   `stage` to `"done"`.
3. End the turn with the PR URL and one line saying it is ready for a
   human to review and merge.

## Resuming

Identical to `requirement-pipeline` "Resuming a run": read
`codegraph/pipeline/<slug>/state.json`, trust its gate statuses, read the
story's own artifacts (`bugfix.md`, `rootcause.md`, `repro.md`, `fix.md`)
for content, and continue from the first gate that is
not `"approved"`. If the branch is not checked out locally, fetch and
check out the `branch` recorded in `state.json`.

A **revise** message means: redo the artifact of that gate, re-run
whatever evidence it depends on, and present a fresh `pending_gate`.
The reviewer's feedback in it is **binding**: investigate what it names
(a different repo, file or cause included) before rewriting, put a
`## Revision` section at the top of the document quoting the feedback
verbatim and listing what changed because of it, reset later gates, and
write the new `pending_gate` with a different `presented_at` and a summary
of how the feedback was addressed. Never just re-present the same content.
A **requirement changed** message (e.g. new details about the bug) follows
the cascade rule: reset the earliest gate whose artifact it invalidates —
new symptoms usually invalidate `2_rootcause` and everything after it.
