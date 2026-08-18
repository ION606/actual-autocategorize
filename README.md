# actual-autocat

Categorizes uncategorized Actual Budget transactions with a local LLM through Ollama.

## How it decides

Three tiers, cheapest first:

1. Actual's own rules, already applied on import. Nothing to do here :)
2. Payee history: the same payee was categorized before, consistently. Looked up on the most specific key that has enough votes - full bank descriptor, then payee id, then payee name. Free, no LLM call.
3. Two-stage local LLM, only for payees with no usable history. Stage 1 picks the category *group* from a list of groups plus a preview of what is inside each, stage 2 picks the *category* within that group.

Both LLM stages use Ollama structured outputs with the valid names as a JSON Schema `enum`, so the model cannot invent a category, and both can answer `UNSURE` to abstain. Final confidence is the product of the two stages.

With `--learn`, a confident decision becomes a native Actual rule keyed on the payee id, so that payee never reaches the LLM again. Tier 3 shrinks over time.

## Setup

TypeScript run directly through `tsx`, so no build step for normal use.

```bash
npm install
cp .env.example .env
```

Fill in `ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD`, `ACTUAL_SYNC_ID` (Actual:
Settings > Advanced > Sync ID), and `ACTUAL_E2E_PASSWORD` if the file is
end-to-end encrypted.

Check the classifier and the tag guardrails without touching the budget:

```bash
npm run smoke
```

Typecheck (`strict`, `noUncheckedIndexedAccess`):

```bash
npm run typecheck
```

`npm run build` emits plain JS to `dist/`, worth doing for a cron entry so a
scheduled run skips the `tsx` startup cost.

## Use

Dry run, prints every decision and writes nothing:

```bash
npm start -- --days 30
```

First real run, with a backup:

```bash
npm start -- --apply --backup --days 30
```

Once calibrated, let it write rules too:

```bash
npm start -- --apply --learn --bank-sync --days 7
```

Output lands in `./out/`: `proposed-*.jsonl` or `applied-*.jsonl`, plus
`review-*.jsonl` for everything below the confidence threshold.

## Concurrency

Transactions are classified up to `--concurrency` at a time (default 3), but results are consumed in the original order, so console output, the new-tag budget and every write stay deterministic. A run at concurrency 3 produces byte-identical output to one at concurrency 1.

Only the model calls overlap. Writes back to Actual stay sequential.

One consequence: a worker that started before a new tag was coined will not have that tag in its enum, so a brand new tag becomes available to the model a few transactions later than it would at concurrency 1. Vetting still catches the near-duplicates either way.

Throughput depends on Ollama serving requests in parallel, which is controlled by `OLLAMA_NUM_PARALLEL` on the server, not by this tool.

## Tags

Off by default. `--tags` applies tags that already exist, `--new-tags`
additionally lets it coin new ones.

In Actual a tag is a `#hashtag` inside a transaction's notes; the tags table is just a registry holding color and description. So tagging means appending `#foo` to notes. The registry entry is written too when the installed API exposes `createTag`, and skipped otherwise.

The vocabulary is every registered tag plus every tag actually in use in the notes of the history window, ordered by usage.

Stage 3 runs after a category is accepted. Existing tags are enum-constrained, so the model cannot misspell one. A new tag is free text, so all constraints on it are enforced in code rather than in the prompt:

- must normalize to `[a-z0-9][a-z0-9-]{1,23}`
- needs its own, higher confidence (`--new-tag-threshold`, default 0.9)
- capped per run (`--max-new-tags`, default 3)
- snapped to an existing tag when it is a near-duplicate, singular/plural or one character away, so `grocery` becomes `groceries` instead of a second tag
- rejected when it merely restates the category or the payee

Every rejection is printed with its reason and lands in the run's JSONL, so a dry run shows exactly which vocabulary it wants before anything is written:

```bash
npm start -- --new-tags --days 30 --limit 30
```

## Calibration

Start with `--limit 30` and read the dry-run output. The default threshold of `0.8` is a starting point: raise `AUTOCAT_THRESHOLD` if you see confident
mistakes, lower it if too much lands in `review-*.jsonl`.

`AUTOCAT_HISTORY_MIN_COUNT` (3) and `AUTOCAT_HISTORY_MIN_SHARE` (0.8) control how much agreement the free history tier needs before it skips the LLM.

## What it will not touch

- Transactions that already have a category
- Transfers (`transfer_id` set, or a transfer payee)
- Splits. The API requires rewriting subtransactions through the parent, which upstream documents as unreliable. Split parents with uncategorized children are counted and reported, never modified.

Applied transactions get an audit note appended, e.g. `[autocat qwen2.5:14b 0.86]`.

## Scheduling

Runs are safe to repeat, since already-categorized transactions are never revisited. Use a systemd timer or cron plus a lockfile, because the process holds
the local budget cache.

```
0 */6 * * * cd /path/to/actual-autocat && flock -n .lock node dist/src/index.js --apply --learn --bank-sync --days 7 >> out/cron.log 2>&1
```

Run `npm run build` first so cron uses the compiled output.

## Notes on the API

Built against `@actual-app/api` 26.8.1. Two places where the published reference
does not match the package:

- `downloadBudget(syncId, { password })` is positional. The reference shows a single object argument, which stringifies to `[object Object]` as the sync id and fails with "Budget not found".
- The package has to be new enough for your server. An older package against a newer server fails at load with `out-of-sync-migrations`, because the budget carries migrations the package does not ship.

Entity types in `src/types.ts` are derived from the package's own function signatures rather than hand-written, so they follow whatever version is installed.
