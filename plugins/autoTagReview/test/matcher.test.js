// Run: node --test plugins/autoTagReview/test/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../matcher.js");

let nextId = 1;
function tag(name, extra) {
  return Object.assign(
    { id: String(nextId++), name: name, aliases: [], ignore_auto_tag: false, parents: [] },
    extra || {}
  );
}

const T = {
  home: tag("Home"),
  pants: tag("Pants"),
  sweaty: tag("Sweaty", { aliases: ["Sweating"] }),
  homeVideo: tag("Home Video"),
  stocking: tag("Stocking"),
  glasses: tag("Glasses"),
  library: tag("Library"),
  outdoor: tag("Outdoor"),
  beach: tag("Beach"),
  rose: tag("Rose"),
  cafe: tag("Cafe"),
  leather: tag("Leather"),
  blackLeather: tag("Black Leather"),
  clothing: tag("Clothing"),
  fourK: tag("4K"),
  ignored: tag("Ignored Tag", { ignore_auto_tag: true }),
};
T.jeans = tag("Jeans", { parents: [{ id: T.clothing.id }] });
const ALL = Object.values(T);

function names(res) {
  return res.proposals.map((p) => p.tagName).sort();
}
function find(res, name) {
  return res.proposals.find((p) => p.tagName === name);
}

// ------------------------------------------------------------- tokenizer

test("tokenize splits camelCase, keeps digits glued, strips accents/apostrophes", () => {
  const toks = M.tokenize("SweatPants 4K Café don't HTMLParser").map((t) => t && t.t);
  assert.deepEqual(toks, ["sweat", "pants", "4k", "cafe", "dont", "html", "parser"]);
});

test("tokenize inserts hard breaks at punctuation but not dotted filenames", () => {
  const toks = M.tokenize("Welcome Home, Video Night - Part.Two").map((t) => t && t.t);
  assert.deepEqual(toks, ["welcome", "home", null, "video", "night", null, "part", "two"]);
});

test("tokenize offsets point into the original string", () => {
  const s = "Guys in SweatPants";
  const toks = M.tokenize(s);
  const pants = toks.find((t) => t && t.t === "pants");
  assert.equal(s.slice(pants.start, pants.end), "Pants");
});

test("tokenizePath strips roots, extension, junk; folders are breaks", () => {
  const toks = M.tokenizePath("D:\\Library\\Outdoor\\Beach Day 1080p x265.mp4", {
    pathRoots: ["D:/Library"],
  }).map((t) => t && t.t);
  assert.deepEqual(toks, ["outdoor", null, "beach", "day"]);
});

// ------------------------------------------------------- reported cases

test("'Welcome Home' does not tag Home when stoplisted", () => {
  const m = M.createMatcher(ALL, { stoplist: ["Welcome Home"] });
  const res = m.propose({ id: "1", title: "Welcome Home" });
  assert.deepEqual(names(res), []);
  assert.equal(res.fields.title.masked[0].key, "welcome home");
});

test("'Welcome Home' does not tag Home with a per-tag exclude", () => {
  const m = M.createMatcher(ALL, { tags: { Home: { exclude: ["welcome home"] } } });
  assert.deepEqual(names(m.propose({ id: "1", title: "Welcome Home" })), []);
  assert.deepEqual(names(m.propose({ id: "2", title: "Fun At Home" })), ["Home"]);
});

test("bare single-word match only goes to review", () => {
  const m = M.createMatcher(ALL, {});
  const res = m.propose({ id: "1", title: "Welcome Home" });
  assert.equal(find(res, "Home").route, "review");
});

test("studio 'Guys in SweatPants' is masked: no Pants, no Sweaty", () => {
  const m = M.createMatcher(ALL, {});
  const res = m.propose({
    id: "1",
    title: "Guys in SweatPants - Gym Day",
    studio: { name: "Guys in SweatPants", aliases: [] },
  });
  assert.deepEqual(names(res), []);
  assert.equal(res.fields.title.masked[0].kind, "studio");
});

test("parent studio and studio aliases are masked too", () => {
  const m = M.createMatcher(ALL, {});
  const res = m.propose({
    id: "1",
    title: "GISP: Pants Off",
    studio: { name: "Sub Label", aliases: [], parent_studio: { name: "X", aliases: ["GISP Pants"] } },
  });
  assert.deepEqual(names(res), ["Pants"]); // "GISP" alone is not an alias; break after ':'
  const res2 = m.propose({
    id: "2",
    title: "GISP Pants Off",
    studio: { name: "Sub Label", aliases: [], parent_studio: { name: "X", aliases: ["GISP Pants"] } },
  });
  assert.deepEqual(names(res2), []);
});

test("'Sweaty' never matches the fragment 'sweat'", () => {
  const m = M.createMatcher(ALL, {});
  const res = m.propose({ id: "1", title: "SweatPants Fun" });
  assert.deepEqual(names(res), ["Pants"]);
});

test("aliases match whole tokens", () => {
  const m = M.createMatcher(ALL, {});
  assert.deepEqual(names(m.propose({ id: "1", title: "Sweating It Out" })), ["Sweaty"]);
});

// --------------------------------------------------------- inflection

test("plural of a singular tag matches; singular of a plural tag does not by default", () => {
  const m = M.createMatcher(ALL, {});
  assert.deepEqual(names(m.propose({ id: "1", title: "Red Stockings" })), ["Stocking"]);
  assert.deepEqual(names(m.propose({ id: "2", title: "Glass Table" })), []);
});

test("inflect: both enables singular forms", () => {
  const m = M.createMatcher(ALL, { tags: { Stocking: {}, Glasses: { inflect: "none" } } });
  assert.deepEqual(names(m.propose({ id: "1", title: "Glass Table" })), []);
  const m2 = M.createMatcher([tag("Stockings")], { tags: { Stockings: { inflect: "both" } } });
  assert.equal(m2.propose({ id: "1", title: "Red Stocking" }).proposals.length, 1);
});

// --------------------------------------------------------- multi-word

test("phrases never cross a hard break", () => {
  const m = M.createMatcher(ALL, {});
  const res = m.propose({ id: "1", title: "Welcome Home, Video Night" });
  assert.deepEqual(names(res), ["Home"]);
});

test("unscored multi-word phrase routes to auto", () => {
  const m = M.createMatcher(ALL, {});
  const res = m.propose({ id: "1", title: "Our Home Video" });
  assert.equal(find(res, "Home Video").route, "auto");
  assert.equal(find(res, "Home"), undefined, "shorter contained match dropped");
});

test("preferLongest drops a contained shorter match", () => {
  const m = M.createMatcher(ALL, {});
  assert.deepEqual(names(m.propose({ id: "1", title: "Black Leather Jacket" })), ["Black Leather"]);
  const m2 = M.createMatcher(ALL, { settings: { preferLongest: false } });
  assert.deepEqual(names(m2.propose({ id: "1", title: "Black Leather Jacket" })), [
    "Black Leather",
    "Leather",
  ]);
});

// -------------------------------------------------------------- rules

test("mode never / auto / review", () => {
  const m = M.createMatcher(ALL, {
    tags: { Home: { mode: "never" }, Pants: { mode: "auto" }, "Home Video": { mode: "review" } },
  });
  const res = m.propose({ id: "1", title: "Home, Pants, Home Video" });
  assert.equal(find(res, "Home"), undefined);
  assert.equal(find(res, "Pants").route, "auto");
  assert.equal(find(res, "Home Video").route, "review");
});

test("ignore drops a phrase for one tag; auto_phrases promotes one phrase", () => {
  const m = M.createMatcher(ALL, {
    tags: { Sweaty: { ignore: ["sweating"] }, Home: { auto_phrases: ["home"] } },
  });
  const res = m.propose({ id: "1", title: "Sweating at Home", details: "sweaty" });
  assert.equal(find(res, "Home").route, "auto");
  const sw = find(res, "Sweaty");
  assert.deepEqual(sw.evidence.map((e) => e.field), ["details"], "alias ignored, name still matches");
});

test("require_any needs a context word within the window", () => {
  const m = M.createMatcher(ALL, {
    tags: { Pants: { require_any: { words: ["off", "pulled"], window: 2 } } },
  });
  assert.deepEqual(names(m.propose({ id: "1", title: "Pants Off" })), ["Pants"]);
  assert.deepEqual(names(m.propose({ id: "2", title: "Nice Pants" })), []);
  assert.deepEqual(names(m.propose({ id: "3", title: "Pants are very much off" })), []);
});

test("fields restriction and details default to review", () => {
  const m = M.createMatcher(ALL, { tags: { Beach: { fields: ["title"] } } });
  const res = m.propose({ id: "1", title: "Day Out", details: "A Home Video at the beach" });
  assert.equal(find(res, "Beach"), undefined);
  assert.equal(find(res, "Home Video").route, "review");
});

test("scores route by smoothed precision and minHits", () => {
  const scores = {};
  scores[T.home.id + "|home|title"] = { hits: 50, tp: 6 };
  scores[T.pants.id + "|pants|title"] = { hits: 40, tp: 38 };
  scores[T.beach.id + "|beach|title"] = { hits: 3, tp: 3 };
  const m = M.createMatcher(ALL, {}, scores);
  const res = m.propose({ id: "1", title: "Home Pants Beach" });
  assert.equal(find(res, "Home").route, "review");
  assert.equal(find(res, "Pants").route, "auto");
  assert.ok(find(res, "Pants").evidence[0].precision > 0.9);
  assert.equal(find(res, "Beach").route, "review", "below minHits");
});

// ---------------------------------------------------- scene filtering

test("skips tags already on scene, their ancestors, rejected pairs, ignore_auto_tag", () => {
  const m = M.createMatcher(ALL, {});
  const res = m.propose(
    { id: "9", title: "Jeans Clothing Pants Beach Ignored Tag", tagIds: [T.jeans.id] },
    { rejected: new Set(["9|" + T.beach.id]) }
  );
  assert.deepEqual(names(res), ["Pants"]);
});

test("dropParentWhenChild removes a proposed ancestor", () => {
  const m = M.createMatcher(ALL, {});
  assert.deepEqual(names(m.propose({ id: "1", title: "Jeans and Clothing" })), ["Jeans"]);
});

test("performer names and first names are masked", () => {
  const m = M.createMatcher(ALL, {});
  const scene = { id: "1", title: "Rose Gets Wet", performers: [{ name: "Rose Black", alias_list: [] }] };
  assert.deepEqual(names(m.propose(scene)), []);
  const m2 = M.createMatcher(ALL, { settings: { maskPerformerFirstNames: false } });
  assert.deepEqual(names(m2.propose(scene)), ["Rose"]);
});

test("path field: roots and junk are ignored, folders match", () => {
  const m = M.createMatcher(ALL, {}, {}, { pathRoots: ["D:/Library"] });
  const res = m.propose({ id: "1", path: "D:/Library/Outdoor/Beach Day 4K.mp4" });
  assert.deepEqual(names(res), ["Beach", "Outdoor"]);
});

test("accents normalize on both sides; evidence offsets highlight original text", () => {
  const m = M.createMatcher(ALL, {});
  const title = "Morning at the Café";
  const res = m.propose({ id: "1", title });
  const ev = find(res, "Cafe").evidence[0];
  assert.equal(title.slice(ev.start, ev.end), "Café");
  assert.equal(ev.field, "title");
});

test("tag with digits indexes as one token", () => {
  const m = M.createMatcher(ALL, {});
  assert.deepEqual(names(m.propose({ id: "1", title: "Shot in 4K" })), ["4K"]);
});

// --------------------------------------------------------- performance

test("performance: 3000 tags x 3 aliases, 500 scenes", () => {
  const words = [];
  for (let i = 0; i < 4000; i++) words.push("w" + i.toString(36) + "x");
  const tags = [];
  for (let i = 0; i < 3000; i++) {
    tags.push({
      id: "p" + i,
      name: words[i] + (i % 3 ? "" : " " + words[(i * 7) % 4000]),
      aliases: [words[(i * 3) % 4000] + " alias", words[(i * 5) % 4000], "Alt " + words[i]],
      parents: [],
    });
  }
  const t0 = performance.now();
  const m = M.createMatcher(tags, { stoplist: ["welcome home"] });
  const t1 = performance.now();
  let total = 0;
  for (let s = 0; s < 500; s++) {
    const title = Array.from({ length: 12 }, (_, k) => words[(s * 13 + k * 31) % 4000]).join(" ");
    const res = m.propose({
      id: String(s),
      title,
      details: title + " " + title,
      path: "D:/Lib/Some Folder/" + title + ".mp4",
      studio: { name: "Studio " + s },
      performers: [{ name: "First Last" }],
    });
    total += res.proposals.length;
  }
  const t2 = performance.now();
  assert.ok(total > 0);
  // Generous bounds so CI noise does not flake; typical is far lower.
  assert.ok(t1 - t0 < 1000, `build took ${(t1 - t0).toFixed(1)}ms`);
  assert.ok(t2 - t1 < 1500, `500 scenes took ${(t2 - t1).toFixed(1)}ms`);
  console.log(
    `  index: ${m.stats.phrases} phrases, build ${(t1 - t0).toFixed(1)}ms, ` +
      `500 scenes ${(t2 - t1).toFixed(1)}ms`
  );
});
