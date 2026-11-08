# Phase 4: rule scoring

Status: **not started**. It waits on feedback from real-library testing of
phases 1–3 (see [Testing feedback](#testing-feedback) below).

## Goal

Measure how often each rule is right, so that noisy phrases stay in review and
reliable ones get pre-checked automatically. The matcher already routes on
`scores.json` (`(tp+1)/(hits+2) ≥ autoThreshold` over at least `minHits`).
Nothing writes that file yet. This phase writes it.

## Inputs

1. **Organized scenes.** These count as hand-checked data. A scene's tag set is
   taken as correct.
2. **`decisions.jsonl`.** Accept and reject decisions from the Tagger review
   (phase 3). This covers scenes that aren't organized yet.

## What gets counted

Counts are kept per key `tagId|phrase|field` (the same key the matcher reads):

- **Organized scenes:** run the matcher in a *scoring mode* (below). For every
  candidate, add 1 to `hits`. Add 1 to `tp` if the scene has the tag or one of
  its descendants (a child tag implies its parent).
- **Decisions:** for each (scene, tag) pair, use only the latest verdict.
  `accept` adds 1 to both `hits` and `tp`; `reject` adds 1 to `hits`. If the
  scene is also organized, skip its decision so it isn't counted twice.

Each key is counted at most once per scene, even if the phrase matches twice in
the same field.

## Matcher change: scoring mode

`propose(scene, { scoring: true })` returns every candidate, with no filtering
for tags the scene already has, parent tags implied by its existing tags,
rejected pairs, or the drop-parent rule. Rule filters still apply: `exclude`,
`require_any`, `fields`, `ignore` and stoplist/entity masking. The output is a
flat list of `{tagId, phrase, field}`, with duplicates removed per scene.

## Where it runs: browser, not Python

DESIGN.md originally planned a Python `Score rules` task. That would mean
rewriting the matcher in Python and keeping two copies in step. Instead:

- A **Score rules** button (in the header, and later on the plugin page) runs in
  the browser. It loads organized scenes in pages of 500 through `findScenes`
  (`organized: true`, the same fields `run()` uses) and scores them with the
  same `matcher.js`.
- **Progress** shows in the header status ("Scoring 3,500 / 18,200…"), with a
  Stop button.
- **Backend op `saveScores`** takes `{scores, meta}` and writes `scores.json`
  as `{ meta, scores }`. `meta` holds:
  - `scoredAt`
  - `sceneCount` and `decisionCount`
  - `rulesHash`, a hash of the merged rules
  - `tagStamp`, the tag count plus the latest `updated_at`
- **Backend op `decisions`** returns the latest verdict per pair, so the browser
  can merge them in. Alternatively, `load` could return the full list.
- **Load:** `op_load` returns `scores.json`'s `scores`, as it does today, plus
  `meta`.

Rough cost: matching is about 0.3 ms per scene, so a 20k-scene library is
mostly GraphQL paging time, probably under a minute.

## Staleness

Learning a rule changes which phrases match, so old scores can go stale.

- If `meta.rulesHash` or `meta.tagStamp` doesn't match the current rules and
  tags, show "Scores are stale — rescore" in the header.
- Keep routing on the stale scores until a rescore. A new phrase simply has no
  score yet, so it goes to review.

## UI changes

- **Header:** a **Score rules** button, its progress and Stop button, and the
  stale-scores hint.
- **Chips:** the popover already shows `NN% of N`. Add a `·` marker when the
  score comes from fewer than `minHits` scenes.
- **No new pages.** The "noisiest rules" table and rules editor are phase 5.

## Known biases and open questions

- **Organized scenes may be missing tags.** A correct match on an organized
  scene that lacks the tag counts as a miss, so precision is underestimated.
  That errs toward review, which is the safer side. One option is to weight
  decisions above organized scenes.
- **Field-specific keys may spread data too thin.** Should a key with few hits
  fall back to the `tagId|phrase` total across fields? Decide after seeing real
  counts.
- **Should tags with `ignore_auto_tag` be scored?** Currently no, since the
  matcher doesn't index them.
- **Should scoring run automatically after N new decisions?** Probably not in
  this phase.

## Tests

- **Matcher scoring mode:** returns tags the scene already has and parent
  candidates; duplicates are removed per scene; rule filters still apply.
- **Count merging (pure JS):** an organized scene with and without the tag; an
  accept/reject sequence where the last verdict wins; a decision on an organized
  scene is skipped; a child tag counts toward its parent.
- **Backend:** `saveScores` writes atomically, and `load` returns `scores` and
  `meta`.
- **Mock-page run:** the progress bar moves, routing changes after scoring (for
  example, `home|title` at 12% stays in review and `pants off` at 95% becomes
  auto), and the stale hint appears after a learn action.

## Done when

- [ ] Scoring mode in `matcher.js`, with tests
- [ ] Count merging (organized scenes + decisions), with tests
- [ ] `saveScores` and `meta` in the backend, with tests
- [ ] Score rules button, progress, Stop, stale hint
- [ ] Verified on the real library: scores produced, and spot-checked routing on
      known-noisy tags (Home, Pants, Sweaty)
- [ ] README and DESIGN.md updated (Python task → in-browser scoring)

---

## Testing feedback

Notes from testing phases 1–3 on the real library. Add items here; anything
that changes this plan gets folded into the sections above before work starts.

- **PyYAML required on install** (fixed in 0.3.1): the rules file is now
  `rules.json`, read with the standard library. Plain JSON plus whole-line `//`
  comments.
- **Buttons didn't match Stash's** (fixed in 0.3.1): they are now default-size
  primary buttons like "Scrape by fragment" and "Scrape All". Dismiss stays
  secondary.
