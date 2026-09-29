---
name: requirement-pipeline
description: >-
  Runs this workspace's gated, multi-repo requirement-intake pipeline: takes
  a free-text requirement, analyzes it against the live codeGraph, splits it
  into per-repo EARS-notation stories, and drives each one through 5
  mandatory approval gates (story approval, plan approval, implementation
  approval, traceability sign-off, QA checklist acceptance) before opening
  and merging a real GitHub PR per story. Use when the user gives a new
  feature or requirement and asks to run it through the pipeline, or
  explicitly says "requirement pipeline", "run the pipeline for...", or
  similar.
---

# Requirement Pipeline

Full design rationale: [`codegraph/pipeline/DESIGN.md`](../../../codegraph/pipeline/DESIGN.md).
This file is the step-by-step operating procedure; read the design doc if
you need the *why* behind any of this.

**Repo paths.** The work repos live in `code-repos/` at the workspace root. Everywhere below, `<repo>` means `code-repos/<repo>`.

**Artifacts live in this workspace, never in the work repos.** Every
document this pipeline writes (`requirement.md`, `stories.md`,
`design.md`, `critique.md`, `traceability.md`, `qa-checklist.md`) goes to
`codegraph/pipeline/<slug>/<repo>/` — the *artifact dir*, next to
`state.json`. Do **not** create a `.pipeline/` folder in any work repo, do
not write `state-ref.json`, and do not commit these documents on story
branches. A story branch contains code and tests only.

## Before anything else

1. Read `.cursor/rules/pipeline-gates.mdc` now. Its rule is absolute:
   **every story passes every gate below, no exceptions, ever.** If this
   run was started via the Cursor SDK rather than an interactive chat
   (the initial prompt will say `HEADLESS_MODE: true`), also follow that
   file's "Headless mode" section for every gate instead of `AskQuestion`.
2. Read `.cursor/rules/pipeline-ears.mdc` now — you'll need it in Stage 1.
3. Pick a short kebab-case slug for the requirement (e.g. `wishlist`,
   `product-reviews`) — if the requirement has a real ticket number, use
   that instead of a made-up slug. Artifacts for this run live under
   `codegraph/pipeline/<slug>/<repo>/` (one artifact dir per repo the
   requirement touches), next to `state.json` (see next step).
4. **`state.json` lives in exactly one place:**
   `codegraph/pipeline/<slug>/state.json` — not duplicated, ever. This
   is the single source of truth for run status; create it there:
   ```json
   {
     "requirement": "<verbatim requirement text>",
     "slug": "<slug>",
     "stories": {
       "<repo-id>": {
         "stage": "1-analysis",
         "gates": {"1_stories": null, "2_plan": null, "3_impl": null,
                    "4_traceability": null, "5_qa": null},
         "branch": null, "pr_url": null
       }
     }
   }
   ```
   Commit it directly to `main` of this monorepo (`rp278/code-graph-mono`; no PR — it's not
   repo-specific code, there's nothing for a PR to review). Update this
   one file as stages/gates complete; that's what makes a run resumable
   in a later chat session, even days later — see "Resuming a run"
   below.
5. `requirement.md` and `stories.md` are shared reference copies —
   write identical copies into every affected repo's artifact dir
   (`codegraph/pipeline/<slug>/<repo>/`) once Stage 1 determines which
   repos are affected. `design.md`, `critique.md`, `traceability.md`,
   `qa-checklist.md` are per-repo, each written to that repo's artifact
   dir only. None of them is committed to a work repo.

## Stage 1 — Analyze & Decompose

1. Query the live graph for grounding — don't guess at what exists.
   The graph API is `$GRAPH_API_URL` (default: the local codegraph API,
   `http://127.0.0.1:8000`). If `codegraph/web/.env` sets `VITE_API_TOKEN`,
   send it as a bearer token (never print it); if it is empty or the file
   is missing, send no auth header. Always use a short timeout:
   ```bash
   GRAPH_API_URL=${GRAPH_API_URL:-http://127.0.0.1:8000}
   TOKEN=$(grep -s '^VITE_API_TOKEN=' codegraph/web/.env | cut -d= -f2- | tr -d '\r"')
   curl -s --max-time 10 ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
     "$GRAPH_API_URL/api/query" -X POST \
     -H "Content-Type: application/json" \
     -d '{"cypher":"MATCH (n:Node) WHERE toLower(n.label) CONTAINS \"<keyword>\" RETURN n LIMIT 20"}'
   ```
   **The graph is optional — fall back to searching the code yourself.**
   If the query errors, times out, returns a non-2xx / non-JSON response
   (graph database down, API unreachable, bad token), or returns **no
   matching nodes**, do NOT stop, ask, or fail the run. Instead use
   `grep` / `glob` / `read` over the repo checkouts in the workspace (the
   folders in `code-repos/`;
   `codegraph/api/repos.local.json` lists them when present) to find what
   already exists for each keyword — routes, components, functions, and who
   calls them (follow one hop through wrappers, and search the *other*
   repos for a route string to find its consumers). The code is the source
   of truth, so this is as accurate as the graph, just less exhaustive
   across many repos. In `stories.md` → graph evidence, state which path
   was used (`Graph: used`, `Graph: no matching nodes — located by file
   search`, or `Graph: unavailable (<reason>) — located by file search`),
   list the actual queries/search commands and hits, and never invent
   graph results.
2. From the query results, determine which of the 4 repos are actually
   affected (usually a subset — not every requirement touches all 4).
   Once known, create `codegraph/pipeline/<slug>/<repo>/` for each of them.
3. Write one EARS-notation story per affected repo, following
   `pipeline-ears.mdc`.
4. Save `stories.md` (requirement text, the graph evidence used, and
   the full per-repo story list) as `codegraph/pipeline/<slug>/<repo>/stories.md`
   — an identical copy per affected repo. Same for `requirement.md`.

**GATE 1**: Present `stories.md`. Ask for explicit approval (AskQuestion:
approve / revise scope). Do not proceed until approved.

## Stage 2 — Plan + Clarifying Questions

Per approved story (independent stories can be planned in parallel):

1. Read the actual files that will be touched.
2. Draft `codegraph/pipeline/<slug>/<repo>/design.md` (that repo's artifact dir only):
   approach, files to change, risks, alternatives considered.
3. Ask any genuinely ambiguous questions before writing code — AskQuestion
   for discrete choices, prose for open architecture questions.

**GATE 2** (per story): present `design.md` + answered questions, get
explicit approval before implementation starts on that story.

## Stage 3 — Implement (dependency waves)

- If more than one story was approved, read `.cursor/rules/pipeline-waves.mdc`
  and compute waves before starting.
- Each story is implemented on its own branch: `pipeline/<slug>/<repo>`.
- Within a wave, dispatch one `Task` subagent per story, in parallel, in
  the same turn — not sequential.
- Don't start the next wave until the current wave's code changes exist.

## Stage 4 — Self-Critique + open the PR

Per story, once implemented:

1. Re-read the diff against `design.md` and the EARS story. List
   weaknesses, missed edge cases, better alternatives explicitly in
   `codegraph/pipeline/<slug>/<repo>/critique.md`. Revise the diff first if
   the critique surfaces something worth fixing before review. Commit only
   the code diff on the story branch; the critique stays in the artifact
   dir and is used as the PR body.
2. Optionally invoke `bugbot` and/or `security-review` subagents on the
   diff for a second opinion; fold relevant findings into `critique.md`.
3. Push the branch and open a PR (per `DESIGN.md` §10.1 — **for
   visibility/CI/history only, not a gate**; see §10.1a) using the
   pattern proven this session — pull the write-scoped token from the
   keychain without ever printing it:
   ```bash
   bash -c '
   export GH_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n "s/^password=//p")
   # <owner>/<repo> and <base> come from the work repo itself, not from this monorepo:
   #   git -C <repo> remote get-url origin        -> owner/repo
   #   git -C <repo> symbolic-ref --short refs/remotes/origin/HEAD  -> base branch
   gh pr create --repo <owner>/<repo> --base <base> --head pipeline/<slug>/<repo> \
     --title "<story title>" --body-file codegraph/pipeline/<slug>/<repo>/critique.md
   unset GH_TOKEN
   '
   ```
   Note: `gh pr edit`/`gh pr view` can fail with a `read:org` GraphQL
   scope error on a fine-grained PAT that otherwise has everything
   needed — if so, use `gh api -X PATCH repos/<owner>/<repo>/pulls/<n>`
   (REST, not GraphQL) instead. `gh pr create`/`gh pr comment`/`gh pr
   merge` are unaffected.
4. Record the PR URL in `codegraph/pipeline/<slug>/state.json` (the one
   canonical copy) and commit that change directly to `main` of `rp278/code-graph-mono`.

**GATE 3**: present the diff + `critique.md` (+ PR link, for reference)
in chat. Get explicit approval before moving to traceability. Approval
is chat-only — the PR's state (open/reviewed/checks) has no bearing on
whether this gate passes.

## Stage 5 — Traceability Verification

1. Build a matrix: every EARS clause from `stories.md` → the exact
   file/function/line that implements it → Verified / Not verified.
2. Save as `codegraph/pipeline/<slug>/<repo>/traceability.md`.
3. Post it as a PR comment too (same `GH_TOKEN` pattern, `gh pr comment`).
4. Any clause not fully verified → back to Stage 3, not forward with a
   caveat.

**GATE 4**: present the matrix in chat, get explicit sign-off there
(the PR comment is for the record, not the approval mechanism).

## Stage 6 — QA Validation Checklist

1. Turn each EARS clause into a concrete, executable QA step (see example
   in `pipeline-ears.mdc`/`DESIGN.md` §7).
2. Save as `codegraph/pipeline/<slug>/<repo>/qa-checklist.md`, post as a PR comment.

**GATE 5** (final): present the checklist, get explicit acceptance. Only
now set that story's status to `"done"` in `codegraph/pipeline/<slug>/state.json`.

## Stage 7 — Merge

Once Gate 5 has passed for a story, merge its PR:
```bash
bash -c '
export GH_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n "s/^password=//p")
gh pr merge <number> --repo <owner>/<repo> --squash
unset GH_TOKEN
'
```
Confirm the merge landed. Do NOT call the API's `/api/graph/rebuild` (it runs
`git pull --ff-only` in the real work repos); the user refreshes the graph
themselves with the graphify command in `.cursor/rules/codegraph.md`.

## Resuming a run (same story, days later, new chat session)

State lives in exactly one place, so resuming is always the same 3 steps:

1. **Find the slug.** If you don't already know it, check
   `codegraph/pipeline/` for the requirement-slug folder(s), or ask.
2. **Read `codegraph/pipeline/<slug>/state.json`.** This alone tells you,
   per story: which stage it's at, which gates are approved/pending, its
   branch name, and its PR URL. Do not restart a completed stage or
   re-ask an already-passed gate — trust this file.
3. **Pull up that story's own artifacts** from `codegraph/pipeline/<slug>/<repo>/`
   for the repo the story belongs to (`requirement.md`, `stories.md`,
   and whichever of `design.md`/`critique.md`/`traceability.md`/
   `qa-checklist.md` exist so far) to get the actual content of what was
   already decided — `state.json` tells you *where* you are, these files
   tell you *what* was agreed.

Then continue from the first stage that doesn't have an `"approved"` gate
yet. Example: `state.json` shows `shop-api` at `"stage": "4-traceability"`
with gates 1-3 approved and 4-5 still `null` → read `codegraph/pipeline/
<slug>/shop-api/critique.md` to recall the implementation, then move straight to
Stage 5 (build the traceability matrix) and present Gate 4 — don't
re-present Gates 1-3, don't re-implement.

If a repo's branch was pushed but you're unsure the working tree still
has those changes locally (e.g. new machine, fresh clone): `git fetch`
and check out the story branch named in `state.json` (`branch` field)
before doing anything else — the code lives there, not in the artifact dir.
