# Auto Tag Review

This is a WIP and is very experimental.

Proposes tags for scenes from their title, details and file path, and lets you
review them inline in the scene **Tagger** view (`Scenes → Tagger`).

Unlike substring auto-tagging, it:

- matches whole words only ("Sweaty" never matches "SweatPants");
- masks the scene's studio (and its parent), performers and groups before matching,
  so "Guys in SweatPants" as a studio doesn't propose `Pants`;
- never matches across punctuation or folder boundaries;
- supports a stoplist ("welcome home") and per-tag rules in `rules.json`;
- splits proposals into **auto** (pre-checked, green) and **review**
  (unchecked, amber, dashed). Single words and matches from details default to review.

## Use

In the Tagger view:

- **Auto-tag All / Auto-tag Selected** (header): proposes tags for every scene
  on the page, or only the checked ones.
- **Per scene**: click chips to toggle them. Hover a chip to see which phrase
  matched, in which field, and what was masked. **Save** adds the checked tags.
  When nothing is checked, **Dismiss all** rejects every proposal for the scene.
- **Save auto-tags** (header) adds all checked chips on the page.
- **↻** reloads tags and `rules.json` on the next run.

Tags are only ever **added** (`bulkSceneUpdate` in ADD mode). Nothing is removed.

### Teaching it

Saving records a decision for each chip:

- a checked chip is recorded as **accepted**;
- a chip you unchecked yourself is recorded as **rejected**;
- an amber chip you never touched records nothing.

A rejected (scene, tag) pair is never proposed again. The decisions go to
`decisions.jsonl`, which the scoring phase uses.

Each chip's hover popover also has rule actions. They apply right away and
re-match the scenes still on the page:

| Action | Effect (written to `learned.json`) |
|---|---|
| **Exclude context…** | Don't propose this tag when the field contains a phrase (prefilled, e.g. "Welcome Home") |
| **Stoplist…** | Mask a phrase before matching, for every tag |
| **Ignore "phrase"** | Stop matching this tag via that name, alias or phrase |
| **Always auto** | Pre-check this tag whenever that phrase matches |

`learned.json` is merged under `rules.json`: lists are combined, and anything
set in `rules.json` wins.

## Install

Copy this folder into Stash's `plugins` directory and reload plugins.
The backend needs only Python (standard library, no extra packages).
On first run, `rules.example.json` is copied to `rules.json`. Edit that file;
it is not overwritten by updates. It is plain JSON, plus whole-line `//`
comments.

## Rules

See `rules.example.json` and `DESIGN.md`. Per tag (keyed by tag name):

```jsonc
{
  "tags": {
    "Home": {
      "mode": "review",              // auto | review | never
      "match": ["at home"],          // extra phrases beyond name + aliases
      "exclude": ["welcome home"],   // skip if this phrase appears in the field
      "fields": ["title", "path"],   // title | details | path
      "ignore": ["house"],           // don't match this tag via these names/aliases
      "auto_phrases": ["at home"]    // pre-check when one of these matched
    },
    "Pants": { "require_any": { "words": ["off", "pulled"], "window": 3 } }
  }
}
```

Only whole-line `//` comments are allowed (the inline ones above are for
illustration).

## Development

```
node --test plugins/autoTagReview/test/matcher.test.js
python -m unittest discover -s plugins/autoTagReview/test -p "test_*.py"
```
