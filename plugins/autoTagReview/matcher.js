/*
 * autoTagReview matcher core.
 *
 * Pure, dependency-free. Loaded in the browser as a plain script (exposes
 * window.AutoTagMatcher) and in node via require() for tests.
 *
 * Pipeline per scene field: tokenize (with hard breaks) -> mask entities and
 * stoplist -> whole-token n-gram lookup -> per-tag rules -> route auto/review.
 * See DESIGN.md.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AutoTagMatcher = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MAX_N_CAP = 8;

  var DEFAULT_SETTINGS = {
    autoThreshold: 0.8,
    minHits: 10,
    dropParentWhenChild: true,
    preferLongest: true,
    maskPerformerFirstNames: true,
    autoMultiWordUnscored: true,
  };

  var DEFAULT_PATH_JUNK = [
    "4k", "8k", "uhd", "fhd", "hd", "sd", "hdr",
    "x264", "x265", "h264", "h265", "hevc", "avc", "av1", "vp9", "aac",
    "mp4", "mkv", "avi", "wmv", "mov", "m4v", "webm", "flv", "ts",
    "web", "webdl", "webrip", "xxx",
  ];
  var JUNK_PATTERNS = [/^\d{3,4}p$/, /^\d{2,3}fps$/, /^\d+$/];

  var WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;
  var HARD_BREAK_CHARS = /[,;:!?()[\]{}|"“”«»–—/\\&+]/;
  var SPACED_SEP = /[.\-_]\s|\s[.\-_]/;

  // ---------------------------------------------------------------- tokenize

  function normWord(s) {
    return s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/['’]/g, "")
      .toLowerCase();
  }

  // Split a raw word on camelCase boundaries, keeping offsets.
  // "SweatPants" -> Sweat|Pants, "HTMLParser" -> HTML|Parser.
  var CAMEL_RE = /\p{Lu}?\p{Ll}+|\p{Lu}+(?![\p{Ll}])|\p{Lu}|[\p{N}]+|[^\p{L}\p{N}]+|./gu;
  var INNER_UPPER = /.\p{Lu}/u;

  function camelSplit(word, offset, out) {
    // Fast path: no interior capital means no camelCase boundary.
    if (!INNER_UPPER.test(word)) {
      var w = normWord(word);
      if (w) out.push({ t: w, start: offset, end: offset + word.length });
      return;
    }
    var re = CAMEL_RE;
    var parts = [];
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(word)) !== null) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      parts.push({ s: m[0], i: m.index });
    }
    // Re-join pieces that are not a lower->Upper or ACRONYM->Word boundary:
    // digits stay glued to neighbours ("4k", "3some", "1080p"); apostrophes glue.
    var merged = [];
    for (var k = 0; k < parts.length; k++) {
      var p = parts[k];
      var prev = merged[merged.length - 1];
      var startsUpper = /^\p{Lu}/u.test(p.s);
      var glue =
        prev &&
        (/^[\p{N}'’]/u.test(p.s) ||
          /[\p{N}'’]$/u.test(prev.s) ||
          !startsUpper);
      if (glue) {
        prev.s += p.s;
      } else {
        merged.push({ s: p.s, i: p.i });
      }
    }
    for (var j = 0; j < merged.length; j++) {
      var t = normWord(merged[j].s);
      if (t) {
        out.push({
          t: t,
          start: offset + merged[j].i,
          end: offset + merged[j].i + merged[j].s.length,
        });
      }
    }
  }

  function isBreakGap(gap) {
    return HARD_BREAK_CHARS.test(gap) || SPACED_SEP.test(gap);
  }

  /**
   * Tokenize free text. Returns an array of {t,start,end} tokens and `null`
   * hard breaks. Offsets index into the original string.
   */
  function tokenize(text) {
    var out = [];
    if (!text) return out;
    var last = 0;
    var m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text)) !== null) {
      if (out.length && isBreakGap(text.slice(last, m.index))) {
        if (out[out.length - 1] !== null) out.push(null);
      }
      camelSplit(m[0], m.index, out);
      last = m.index + m[0].length;
    }
    return out;
  }

  function isJunk(t, junkSet) {
    if (junkSet.has(t)) return true;
    for (var i = 0; i < JUNK_PATTERNS.length; i++) {
      if (JUNK_PATTERNS[i].test(t)) return true;
    }
    return false;
  }

  /**
   * Tokenize a file path: strips configured library roots and the extension,
   * makes every folder boundary a hard break and drops junk tokens.
   * Offsets index into the original path string.
   */
  function tokenizePath(path, opts) {
    opts = opts || {};
    var out = [];
    if (!path) return out;
    var junkSet = opts.junkSet || new Set(DEFAULT_PATH_JUNK);
    var p = path.replace(/\\/g, "/");
    var skip = 0;
    var roots = (opts.pathRoots || [])
      .map(function (r) {
        return r.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
      })
      .sort(function (a, b) {
        return b.length - a.length;
      });
    for (var r = 0; r < roots.length; r++) {
      if (p.toLowerCase().indexOf(roots[r].toLowerCase()) === 0) {
        skip = roots[r].length;
        break;
      }
    }
    if (!skip) {
      var drive = /^[a-zA-Z]:\//.exec(p);
      if (drive) skip = drive[0].length;
    }
    var rest = p.slice(skip);
    var segs = rest.split("/");
    var pos = skip;
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s];
      var segText = seg;
      if (s === segs.length - 1) {
        var dot = seg.lastIndexOf(".");
        if (dot > 0) segText = seg.slice(0, dot);
      }
      if (out.length && out[out.length - 1] !== null) out.push(null);
      var toks = tokenize(segText);
      for (var k = 0; k < toks.length; k++) {
        var tk = toks[k];
        if (tk === null || isJunk(tk.t, junkSet)) {
          if (out.length && out[out.length - 1] !== null) out.push(null);
          continue;
        }
        out.push({ t: tk.t, start: tk.start + pos, end: tk.end + pos });
      }
      pos += seg.length + 1;
    }
    while (out.length && out[out.length - 1] === null) out.pop();
    return out;
  }

  /** Normalize a phrase (tag name, alias, rule phrase) to its index key. */
  function normalizePhrase(s) {
    return tokenize(s)
      .filter(function (t) {
        return t !== null;
      })
      .map(function (t) {
        return t.t;
      })
      .join(" ");
  }

  function pluralize(word) {
    if (/(s|x|z|ch|sh)$/.test(word)) return word + "es";
    if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + "ies";
    return word + "s";
  }

  function singularize(word) {
    if (/[^aeiou]ies$/.test(word)) return word.slice(0, -3) + "y";
    if (/(ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
    if (/[^s]s$/.test(word)) return word.slice(0, -1);
    return null;
  }

  // ---------------------------------------------------------- phrase sets

  function PhraseSet() {
    this.map = new Map(); // key -> payload[]
    this.prefixes = new Set();
    this.maxN = 0;
  }
  PhraseSet.prototype.add = function (key, payload) {
    if (!key) return;
    var parts = key.split(" ");
    if (parts.length > MAX_N_CAP) return;
    var list = this.map.get(key);
    if (!list) this.map.set(key, (list = []));
    list.push(payload);
    var acc = "";
    for (var i = 0; i < parts.length; i++) {
      acc = i ? acc + " " + parts[i] : parts[i];
      this.prefixes.add(acc);
    }
    if (parts.length > this.maxN) this.maxN = parts.length;
  };

  /**
   * Find all occurrences of set phrases in a token list. Never crosses a
   * null break. Returns [{start,end,key,payloads}] with token indexes.
   */
  function findAll(tokens, set) {
    var hits = [];
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i] === null) continue;
      var key = "";
      for (var n = 0; n < set.maxN && i + n < tokens.length; n++) {
        var tk = tokens[i + n];
        if (tk === null) break;
        key = n ? key + " " + tk.t : tk.t;
        if (!set.prefixes.has(key)) break;
        var p = set.map.get(key);
        if (p) hits.push({ start: i, end: i + n + 1, key: key, payloads: p });
      }
    }
    return hits;
  }

  function containsPhrase(tokens, phraseKey) {
    var s = new PhraseSet();
    s.add(phraseKey, true);
    return findAll(tokens, s).length > 0;
  }

  /**
   * Replace tokens covered by any phrase in the given sets with null breaks,
   * longest match first. Returns {tokens, masked:[{start,end,key}]}.
   */
  function maskTokens(tokens, sets) {
    var hits = [];
    for (var s = 0; s < sets.length; s++) {
      if (sets[s]) hits = hits.concat(findAll(tokens, sets[s]));
    }
    hits.sort(function (a, b) {
      return b.end - b.start - (a.end - a.start) || a.start - b.start;
    });
    var out = tokens.slice();
    var masked = [];
    for (var h = 0; h < hits.length; h++) {
      var hit = hits[h];
      var free = true;
      for (var i = hit.start; i < hit.end; i++) {
        if (out[i] === null) {
          free = false;
          break;
        }
      }
      if (!free) continue;
      masked.push({
        start: tokens[hit.start].start,
        end: tokens[hit.end - 1].end,
        key: hit.key,
        kind: hit.payloads[0],
      });
      for (var j = hit.start; j < hit.end; j++) out[j] = null;
    }
    masked.sort(function (a, b) {
      return a.start - b.start;
    });
    return { tokens: out, masked: masked };
  }

  // ---------------------------------------------------------------- rules

  function compileRule(raw) {
    raw = raw || {};
    var rule = {
      mode: raw.mode || null,
      match: (raw.match || []).map(normalizePhrase).filter(Boolean),
      exclude: (raw.exclude || []).map(normalizePhrase).filter(Boolean),
      fields: raw.fields ? new Set(raw.fields) : null,
      ignore: new Set((raw.ignore || []).map(normalizePhrase).filter(Boolean)),
      autoPhrases: new Set((raw.auto_phrases || []).map(normalizePhrase).filter(Boolean)),
      inflect: raw.inflect || "plural", // plural | both | none
      requireAny: null,
    };
    if (raw.require_any) {
      var ra = Array.isArray(raw.require_any)
        ? { words: raw.require_any }
        : raw.require_any;
      rule.requireAny = {
        words: new Set((ra.words || []).map(normalizePhrase).filter(Boolean)),
        window: ra.window == null ? 3 : ra.window,
      };
    }
    return rule;
  }

  // ---------------------------------------------------------------- matcher

  /**
   * Build a matcher.
   *  tags:   [{id, name, aliases[], ignore_auto_tag, parents:[{id}]}]
   *  rules:  {settings, stoplist[], pathJunk[], tags:{<name>: rule}}
   *  scores: {"<tagId>|<phrase>|<field>": {hits, tp}}
   *  opts:   {pathRoots[]}
   */
  function createMatcher(tags, rules, scores, opts) {
    rules = rules || {};
    scores = scores || {};
    opts = opts || {};
    var settings = Object.assign({}, DEFAULT_SETTINGS, rules.settings || {});

    var rulesByName = new Map();
    var rawTagRules = rules.tags || {};
    Object.keys(rawTagRules).forEach(function (name) {
      rulesByName.set(name.toLowerCase(), compileRule(rawTagRules[name]));
    });

    var tagById = new Map();
    var ruleById = new Map();
    var index = new PhraseSet();
    var parentsById = new Map();

    function addPhrase(tag, key, source, rule) {
      if (!key) return;
      index.add(key, { tagId: tag.id, phrase: key, source: source });
      var parts = key.split(" ");
      var last = parts[parts.length - 1];
      var head = parts.slice(0, -1);
      var forms = [];
      if (/\p{L}{3,}$/u.test(last)) {
        if (rule.inflect === "plural" || rule.inflect === "both") {
          forms.push(pluralize(last));
        }
        if (rule.inflect === "both") {
          var sing = singularize(last);
          if (sing) forms.push(sing);
        }
      }
      forms.forEach(function (f) {
        index.add(head.concat([f]).join(" "), {
          tagId: tag.id,
          phrase: key,
          source: source,
          variant: true,
        });
      });
    }

    (tags || []).forEach(function (tag) {
      tagById.set(tag.id, tag);
      parentsById.set(
        tag.id,
        (tag.parents || []).map(function (p) {
          return p.id;
        })
      );
      if (tag.ignore_auto_tag) return;
      var rule =
        rulesByName.get(String(tag.name).toLowerCase()) || compileRule(null);
      ruleById.set(tag.id, rule);
      if (rule.mode === "never") return;
      var seen = new Set();
      var add = function (text, source) {
        var key = source === "rule" ? text : normalizePhrase(text);
        if (!key || seen.has(key) || rule.ignore.has(key)) return;
        seen.add(key);
        addPhrase(tag, key, source, rule);
      };
      add(tag.name, "name");
      (tag.aliases || []).forEach(function (a) {
        add(a, "alias");
      });
      rule.match.forEach(function (k) {
        add(k, "rule");
      });
    });

    var stoplist = new PhraseSet();
    (rules.stoplist || []).forEach(function (s) {
      stoplist.add(normalizePhrase(s), "stoplist");
    });

    var junkSet = new Set(DEFAULT_PATH_JUNK);
    (rules.pathJunk || []).forEach(function (j) {
      junkSet.add(normWord(j));
    });

    function ancestors(tagId) {
      var out = new Set();
      var stack = (parentsById.get(tagId) || []).slice();
      while (stack.length) {
        var id = stack.pop();
        if (out.has(id)) continue;
        out.add(id);
        (parentsById.get(id) || []).forEach(function (p) {
          stack.push(p);
        });
      }
      return out;
    }

    function entitySet(scene) {
      var set = new PhraseSet();
      var addAll = function (names, kind) {
        names.forEach(function (n) {
          if (n) set.add(normalizePhrase(n), kind);
        });
      };
      var st = scene.studio;
      while (st) {
        addAll([st.name].concat(st.aliases || []), "studio");
        st = st.parent_studio || st.parent || null;
      }
      (scene.performers || []).forEach(function (p) {
        var names = [p.name].concat(p.alias_list || p.aliases || []);
        addAll(names, "performer");
        if (settings.maskPerformerFirstNames) {
          names.forEach(function (n) {
            var key = normalizePhrase(n || "");
            if (key.indexOf(" ") > 0) set.add(key.split(" ")[0], "performer");
          });
        }
      });
      (scene.groups || scene.movies || []).forEach(function (g) {
        var grp = g.group || g.movie || g;
        addAll([grp.name].concat(grp.aliases ? [grp.aliases] : []), "group");
      });
      return set;
    }

    function scoreFor(tagId, phrase, field) {
      return scores[tagId + "|" + phrase + "|" + field] || null;
    }

    function route(tagId, phrase, field, rule) {
      var sc = scoreFor(tagId, phrase, field);
      var precision = sc ? (sc.tp + 1) / (sc.hits + 2) : null;
      var info = { precision: precision, hits: sc ? sc.hits : 0 };
      if (rule.mode === "never") return null;
      if (rule.mode === "auto" || rule.autoPhrases.has(phrase)) {
        return Object.assign({ route: "auto" }, info);
      }
      if (rule.mode === "review") return Object.assign({ route: "review" }, info);
      if (field === "details") return Object.assign({ route: "review" }, info);
      if (sc) {
        var ok =
          sc.hits >= settings.minHits && precision >= settings.autoThreshold;
        return Object.assign({ route: ok ? "auto" : "review" }, info);
      }
      var multi = phrase.indexOf(" ") > 0;
      return Object.assign(
        { route: multi && settings.autoMultiWordUnscored ? "auto" : "review" },
        info
      );
    }

    function requireAnyOk(rawTokens, hit, ra) {
      var lo = Math.max(0, hit.start - ra.window);
      var hi = Math.min(rawTokens.length, hit.end + ra.window);
      for (var i = lo; i < hi; i++) {
        if (i >= hit.start && i < hit.end) continue;
        var tk = rawTokens[i];
        if (tk && ra.words.has(tk.t)) return true;
      }
      return false;
    }

    function analyzeField(field, rawTokens, sceneEntities) {
      var m = maskTokens(rawTokens, [sceneEntities, stoplist]);
      var hits = findAll(m.tokens, index);
      if (settings.preferLongest) {
        hits = hits.filter(function (h) {
          return !hits.some(function (o) {
            return (
              o !== h &&
              o.start <= h.start &&
              o.end >= h.end &&
              o.end - o.start > h.end - h.start
            );
          });
        });
      }
      var cands = [];
      hits.forEach(function (h) {
        h.payloads.forEach(function (pl) {
          var rule = ruleById.get(pl.tagId);
          if (!rule) return;
          if (rule.fields && !rule.fields.has(field)) return;
          for (var e = 0; e < rule.exclude.length; e++) {
            if (containsPhrase(rawTokens, rule.exclude[e])) return;
          }
          if (rule.requireAny && !requireAnyOk(rawTokens, h, rule.requireAny)) {
            return;
          }
          var r = route(pl.tagId, pl.phrase, field, rule);
          if (!r) return;
          cands.push({
            tagId: pl.tagId,
            field: field,
            phrase: pl.phrase,
            source: pl.source,
            variant: !!pl.variant,
            start: rawTokens[h.start].start,
            end: rawTokens[h.end - 1].end,
            route: r.route,
            precision: r.precision,
            hits: r.hits,
          });
        });
      });
      return { masked: m.masked, candidates: cands };
    }

    /**
     * Propose tags for one scene.
     *  scene: {id, title, details, path, studio, performers, groups, tagIds[]}
     *  opts:  {rejected: Set<"sceneId|tagId">}
     * Returns {proposals:[...], fields:{title|details|path: {text, masked}}}
     */
    function propose(scene, popts) {
      popts = popts || {};
      var rejected = popts.rejected || new Set();
      var has = new Set((scene.tagIds || []).map(String));
      var entities = entitySet(scene);

      var fieldTexts = {
        title: scene.title || "",
        details: scene.details || "",
        path: scene.path || "",
      };
      var fieldsOut = {};
      var all = [];
      Object.keys(fieldTexts).forEach(function (field) {
        var text = fieldTexts[field];
        if (!text) return;
        var toks =
          field === "path"
            ? tokenizePath(text, { pathRoots: opts.pathRoots, junkSet: junkSet })
            : tokenize(text);
        var res = analyzeField(field, toks, entities);
        fieldsOut[field] = { text: text, masked: res.masked };
        all = all.concat(res.candidates);
      });

      // Implied by tags the scene already has.
      var implied = new Set();
      has.forEach(function (id) {
        ancestors(id).forEach(function (a) {
          implied.add(String(a));
        });
      });

      var byTag = new Map();
      all.forEach(function (c) {
        var id = String(c.tagId);
        if (has.has(id) || implied.has(id)) return;
        if (rejected.has(scene.id + "|" + id)) return;
        var p = byTag.get(id);
        if (!p) {
          var tag = tagById.get(c.tagId);
          p = { tagId: c.tagId, tagName: tag ? tag.name : id, route: c.route, evidence: [] };
          byTag.set(id, p);
        }
        if (c.route === "auto") p.route = "auto";
        p.evidence.push(c);
      });

      if (settings.dropParentWhenChild) {
        var drop = new Set();
        byTag.forEach(function (p) {
          ancestors(p.tagId).forEach(function (a) {
            drop.add(String(a));
          });
        });
        drop.forEach(function (id) {
          byTag.delete(id);
        });
      }

      var proposals = Array.from(byTag.values()).sort(function (a, b) {
        if (a.route !== b.route) return a.route === "auto" ? -1 : 1;
        return a.tagName.localeCompare(b.tagName);
      });
      return { proposals: proposals, fields: fieldsOut };
    }

    return {
      propose: propose,
      settings: settings,
      stats: { phrases: index.map.size, maxN: index.maxN, tags: tagById.size },
    };
  }

  return {
    createMatcher: createMatcher,
    tokenize: tokenize,
    tokenizePath: tokenizePath,
    normalizePhrase: normalizePhrase,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_PATH_JUNK: DEFAULT_PATH_JUNK,
  };
});
