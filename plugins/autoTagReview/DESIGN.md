# autoTagReview — design

A single Stash plugin that proposes tags from scene text (title, details, path),
shows them inline in the **scene Tagger view** (`/scenes?disp=3`) for review, and
learns per-tag rules from what you accept or reject.

The problem with the current approach is that it matches substrings of the title
against every tag name and alias. "Welcome Home" → `Home`;
"Guys in SweatPants" (a studio) → `Pants`, `Sweaty`.

---

## 1. Architecture

| Part | Runs in | Responsibility |
|---|---|---|
| `autoTagReview.js` (+ `.css`) | Browser, via `ui.javascript` | Tag index, matcher, Tagger-view integration, review page, saving tags |
| `autoTagReview.py` | Stash plugin backend (`interface: raw`, `stashapi`) | Reads and writes rule/decision files; library-wide scoring task |
| `rules.json` | Plugin dir, edited by hand | Rules per tag and the phrase stoplist. The plugin never rewrites it |
| `learned.json` | Plugin dir, written by the backend | Excludes and auto-promotions that come from review decisions |
| `decisions.jsonl` | Plugin dir, append-only | `{scene, tag, phrase, field, verdict, ts}`: feeds scoring and stops a rejected tag being proposed again |
| `scores.json` | Plugin dir, written by the scoring task | Precision per (tag, phrase, field) |

Matching runs entirely in the browser, which is the fast path. Python runs only for
file I/O (through `runPluginOperation` on load and save) and for the batch scoring task.

---

## 2. Matching pipeline (per scene)

1. **Skip:** tags with `ignore_auto_tag`, tags the scene already has, and
   (scene, tag) pairs that were rejected before.
2. **Normalize** each field: NFKD → strip accents → split camelCase and
   letter/digit boundaries → `[._\-/]` to spaces → lowercase → tokenize.
   For the path, use the folder names and the file basename, and drop junk tokens
   (`1080p`, `x265`, `mp4`, …, configurable).
3. **Mask entities:** cut out the studio and its parent studio, performers, and
   groups (all with aliases), plus the stoplist from `rules.json`. Longest match
   goes first. Masked tokens become hard breaks, so no n-gram crosses them.
4. **Look up candidates:** each n-gram (n ≤ the longest indexed phrase) is a hash
   lookup in the tag index, using whole tokens only.
5. **Apply rules:** `exclude` phrases (anywhere in the same field),
   `require_any` context words (within N tokens), `fields`, and `mode`.
6. **Hierarchy:** if a child tag is proposed, drop its parent (configurable).
7. **Score and route:** each candidate → `auto` (pre-checked) or `review`
   (unchecked). The phrase and field that triggered it are always kept for display.

### Routing
- `mode: never` → dropped. `mode: auto` → auto. `mode: review` → review.
- No mode set → auto if smoothed precision `(tp+1)/(hits+2)` ≥ `autoThreshold`
  (default 0.8) with ≥ `minHits` (default 10), otherwise review.
- Default for single common words (not in `scores.json` yet): review.
- A match from `details` defaults to review.

### Performance budget (2k+ tags, plus aliases)
- **Tag index:** `findTags(per_page: -1) { id name aliases ignore_auto_tag parents { id } }`,
  run once. It's cached in IndexedDB, keyed by tag count and the latest
  `updated_at`, and checked against the server with one `per_page: 1` query.
- **Index shape:** `Map<normalizedPhrase, TagRef[]>`. Plural forms are added when
  the index is built, so a lookup stays a single hash hit.
- **Per scene:** about 50 tokens × maxN (about 5), roughly 250 lookups. A 500-scene
  page should take < 50 ms in total.
- **Scene context:** one batched `findScenes(ids)` per page (title, details,
  `files { path }`, studio with parent and aliases, performers with `alias_list`,
  groups, `tags { id }`). It never fetches one scene at a time.

---

## 3. Rules file (`rules.json`)

```jsonc
{
  "settings": { "autoThreshold": 0.8, "minHits": 10, "dropParentWhenChild": true },
  "stoplist": ["welcome home", "home alone"],
  "pathJunk": ["1080p", "2160p", "x265", "hevc"],
  "tags": {
    "Home": {
      "mode": "review",
      "match": ["at home"],
      "exclude": ["welcome home"],
      "fields": ["title", "path"]
    },
    "Pants": { "require_any": { "words": ["removed", "pulled", "off"], "window": 3 } }
  }
}
```

The rules file was YAML at first. It became JSON (with whole-line `//`
comments allowed) so the backend needs no packages beyond the Python
standard library.

`learned.json` uses the same per-tag shape and is merged over `rules.json` when
loaded. Anything set in `rules.json` takes precedence.

---

## 4. Tagger view integration

The Tagger (`SceneTagger.tsx` / `TaggerScene.tsx`) has **no `PatchComponent`
points**, so v1 uses a DOM adapter. All the DOM-specific code lives in one module,
so it can later be swapped for real patch points (see §7).

- **Detection:** a route listener plus a `MutationObserver` on `.tagger-container`.
- **Header:** add **Auto-tag All / Auto-tag Selected** next to the Scrape button in
  `.tagger-container-header`. The label follows the selection, the same way Scrape does.
  - *All* = every visible `.search-item` (the currently viewed page).
  - *Selected* = rows whose `.search-item-check` is checked.
  - **Save all reviewed** applies the checked chips across all rows.
- **Rows:** each `.search-item` gets a React root (`ReactDOMClient.createRoot`)
  mounted under it. The scene ID comes from the row's `/scenes/{id}` link.
  Proposal state is kept in a module-level store keyed by scene ID, so it
  survives the Tagger re-rendering its rows.
- **Row panel:**
  - **Chips:** green = auto (checked), amber = review (unchecked), grey = already rejected (hidden by default).
  - **Hover:** shows the field, with the matched span highlighted and masked spans greyed out, plus the precision and hit count.
  - **Chip actions:** ✓ accept · ✗ reject · ✗ + *exclude phrase for this tag* · ★ *always auto for this phrase*.
  - **Save** (per row) applies the checked chips.
- **Saving:** `bulkSceneUpdate` with `tag_ids: { mode: ADD }` through the app's
  Apollo client (`PluginApi.utils.StashService`), so the Tagger's own data
  refreshes and nothing it holds is overwritten. Checked chips are logged to
  `decisions.jsonl` as accepted. Unchecked chips are logged as rejected only if
  the user unchecked them explicitly, or pressed **Dismiss all**. Amber chips
  that were never touched record nothing, so a page-wide save can't
  mass-reject review chips nobody looked at.
- **Rule actions** (`ignore` and `auto_phrases` were added to the rule schema in
  phase 3): Exclude context… / Stoplist… (a prompt prefilled with the previous
  word plus the match) / Ignore phrase / Always auto. Each one writes
  `learned.json` and re-matches the rows still under review, keeping the
  user's chip choices.
- **Coexisting with Scrape:** the plugin's panel and Stash's scrape results sit side
  by side. Saving a scrape result in merge mode keeps tags the plugin added.

## 5. Plugin page (`/plugin/autoTagReview`)

A route registered with `PluginApi.register.route`, linked from the plugin
settings and from a link in the Tagger header.

- **Rules:** a per-tag editor for `learned.json` (mode, match, exclude, require_any,
  fields), plus a read-only view of what `rules.json` contributes.
- **Noisiest rules:** a table of (tag, phrase, field) by hits and precision, sorted
  lowest-precision-first, with one-click *exclude* / *never* / *auto*.
- **Bulk review:** proposals grouped by tag → phrase → scenes across any saved
  filter or the whole library, for big clean-ups outside the Tagger.
- **Test box:** paste a title and see the tokens, masks, and candidates with the
  reason for each one.

## 6. Backend tasks and operations

- **Operations** (`runPluginOperation`): `load` returns the merged rules, scores,
  and the rejected (scene, tag) set. `decide` appends decisions and may update
  `learned.json`. `saveRules` writes `learned.json`.
- **Tasks:** `Score rules` makes a paged pass over organized scenes and the
  decision log and writes `scores.json` (with progress). `Export learned rules`
  merges `learned.json` into a copy of `rules.json` for hand-editing.

## 7. Upstream follow-up (optional)

Add patch points to the Stash fork (`forks/stash`) and send them upstream:
`SceneTagger.HeaderButtons` (a `PatchContainerComponent`) and `TaggerScene.Extra`
(children rendered under each row, receiving `scene`). Once they ship, the DOM
adapter becomes a fallback.

---

## Build phases

1. **Matcher core:** a pure JS module with node unit tests, using the reported
   false positives as fixtures. Includes the tag index, normalization, masking,
   n-gram lookup, and rules.
2. **Tagger adapter:** header buttons, row panels, the proposal store, and save
   via `bulkSceneUpdate`. Rules come only from `rules.json` at this point.
3. **Backend storage:** `load` / `decide` / `saveRules`, the reject/exclude/
   promote chip actions, and suppressing tags that were rejected.
4. **Scoring:** the `Score rules` task and threshold-based auto routing.
5. **Plugin page:** rules editor, noisiest rules, test box, and later bulk review.
6. **Upstream patch points** (optional).

## Not in scope for v1
StashDB tag mapping, run-on-scan hooks, the LLM/embedding stage, and image and
gallery tagging.
