/*
 * autoTagReview UI: Tagger view integration (phase 2).
 *
 * The scene Tagger (/scenes?disp=3) has no PatchComponent points, so this
 * file adapts to its DOM: header buttons are mounted into
 * .tagger-container-header and one panel per .search-item row. All DOM
 * knowledge lives in the "DOM adapter" section so it can be swapped for real
 * patch points later. Matching is done by window.AutoTagMatcher (matcher.js).
 */
(function () {
  "use strict";

  var api = window.PluginApi;
  var M = window.AutoTagMatcher;
  if (!api || !M) {
    console.warn("[autoTagReview] PluginApi or AutoTagMatcher missing");
    return;
  }
  var React = api.React;
  var h = React.createElement;
  var Bootstrap = api.libraries.Bootstrap;
  var Button = Bootstrap.Button;
  var createRoot = api.ReactDOMClient && api.ReactDOMClient.createRoot;

  var PLUGIN_ID = "autoTagReview";
  var SCENE_CHUNK = 100;
  var CACHE_KEY = "tags-v1";

  // ------------------------------------------------------------- GraphQL

  function gql(query, variables) {
    return fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ query: query, variables: variables || {} }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j.errors && j.errors.length) {
          throw new Error(
            j.errors
              .map(function (e) {
                return e.message;
              })
              .join("; ")
          );
        }
        return j.data;
      });
  }

  var TAG_STAMP_Q =
    'query { findTags(filter: { per_page: 1, sort: "updated_at", direction: DESC }) { count tags { updated_at } } }';
  var TAGS_Q =
    "query { findTags(filter: { per_page: -1 }) { tags { id name aliases ignore_auto_tag parents { id } } } }";
  var ROOTS_Q = "query { configuration { general { stashes { path } } } }";
  var RUN_OP_M =
    "mutation ($args: Map) { runPluginOperation(plugin_id: \"" + PLUGIN_ID + "\", args: $args) }";
  var SCENES_Q =
    "query ($ids: [ID!]) { findScenes(ids: $ids, filter: { per_page: -1 }) { scenes {" +
    " id title details files { path }" +
    " studio { name aliases parent_studio { name aliases parent_studio { name aliases } } }" +
    " performers { name alias_list }" +
    " groups { group { name aliases } }" +
    " tags { id } } } }";
  var BULK_ADD_M =
    "mutation ($ids: [ID!], $tags: [ID!]) { bulkSceneUpdate(input: { ids: $ids, tag_ids: { ids: $tags, mode: ADD } }) { id } }";

  // ----------------------------------------------------- IndexedDB cache

  function idb() {
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open("autoTagReview", 1);
        req.onupgradeneeded = function () {
          req.result.createObjectStore("kv");
        };
        req.onsuccess = function () {
          resolve(req.result);
        };
        req.onerror = function () {
          resolve(null);
        };
      } catch (e) {
        resolve(null);
      }
    });
  }
  function idbGet(key) {
    return idb().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var r = db.transaction("kv").objectStore("kv").get(key);
          r.onsuccess = function () {
            resolve(r.result || null);
          };
          r.onerror = function () {
            resolve(null);
          };
        } catch (e) {
          resolve(null);
        }
      });
    });
  }
  function idbSet(key, val) {
    return idb().then(function (db) {
      if (!db) return;
      try {
        db.transaction("kv", "readwrite").objectStore("kv").put(val, key);
      } catch (e) {
        /* cache is best-effort */
      }
    });
  }

  // -------------------------------------------------------------- engine

  function loadTags() {
    return gql(TAG_STAMP_Q).then(function (d) {
      var f = d.findTags;
      var stamp = f.count + "|" + (f.tags[0] ? f.tags[0].updated_at : "");
      return idbGet(CACHE_KEY).then(function (cached) {
        if (cached && cached.stamp === stamp) return cached.tags;
        return gql(TAGS_Q).then(function (d2) {
          var tags = d2.findTags.tags;
          idbSet(CACHE_KEY, { stamp: stamp, tags: tags });
          return tags;
        });
      });
    });
  }

  function loadBackend() {
    return gql(RUN_OP_M, { args: { op: "load" } }).then(function (d) {
      var out = d.runPluginOperation;
      if (out && out.output !== undefined && out.rules === undefined) out = out.output;
      if (out && out.error) throw new Error(out.error);
      return out || {};
    });
  }

  function loadRoots() {
    return gql(ROOTS_Q)
      .then(function (d) {
        return d.configuration.general.stashes.map(function (s) {
          return s.path;
        });
      })
      .catch(function () {
        return [];
      });
  }

  var enginePromise = null;
  function ensureEngine() {
    if (!enginePromise) {
      enginePromise = Promise.all([loadTags(), loadBackend(), loadRoots()])
        .then(function (r) {
          var tags = r[0];
          var be = r[1];
          var t0 = performance.now();
          var matcher = M.createMatcher(tags, be.rules || {}, be.scores || {}, {
            pathRoots: r[2],
          });
          console.debug(
            "[autoTagReview] index built in " + (performance.now() - t0).toFixed(0) + "ms",
            matcher.stats
          );
          return {
            matcher: matcher,
            rejected: new Set(be.rejected || []),
            tagCount: tags.length,
          };
        })
        .catch(function (e) {
          enginePromise = null;
          throw e;
        });
    }
    return enginePromise;
  }

  // --------------------------------------------------------------- store

  var store = {
    state: { status: "idle", msg: "", rows: {}, selected: 0 },
    subs: new Set(),
    set: function (patch) {
      store.state = Object.assign({}, store.state, patch);
      store.subs.forEach(function (f) {
        f();
      });
    },
    setRows: function (patches) {
      var rows = Object.assign({}, store.state.rows);
      Object.keys(patches).forEach(function (id) {
        rows[id] = Object.assign({}, rows[id] || {}, patches[id]);
      });
      store.set({ rows: rows });
    },
    subscribe: function (f) {
      store.subs.add(f);
      return function () {
        store.subs.delete(f);
      };
    },
  };
  function useStore() {
    return React.useSyncExternalStore(store.subscribe, function () {
      return store.state;
    });
  }

  function toMatcherScene(s) {
    return {
      id: s.id,
      title: s.title,
      details: s.details,
      path: s.files && s.files[0] ? s.files[0].path : "",
      studio: s.studio,
      performers: s.performers,
      groups: s.groups,
      tagIds: (s.tags || []).map(function (t) {
        return t.id;
      }),
    };
  }

  function run(ids) {
    if (!ids.length) return Promise.resolve();
    store.set({ status: "loading", msg: "Loading tags and rules…" });
    var pending = {};
    ids.forEach(function (id) {
      pending[id] = { status: "loading", error: null };
    });
    store.setRows(pending);
    return ensureEngine()
      .then(function (eng) {
        store.set({ msg: "Matching " + ids.length + " scene(s)…" });
        var chunks = [];
        for (var i = 0; i < ids.length; i += SCENE_CHUNK) chunks.push(ids.slice(i, i + SCENE_CHUNK));
        var total = 0;
        return chunks
          .reduce(function (p, chunk) {
            return p.then(function () {
              return gql(SCENES_Q, { ids: chunk }).then(function (d) {
                var patches = {};
                d.findScenes.scenes.forEach(function (s) {
                  var res = eng.matcher.propose(toMatcherScene(s), { rejected: eng.rejected });
                  var checked = {};
                  res.proposals.forEach(function (p) {
                    checked[p.tagId] = p.route === "auto";
                  });
                  total += res.proposals.length;
                  patches[s.id] = {
                    status: "ready",
                    proposals: res.proposals,
                    fields: res.fields,
                    checked: checked,
                    added: null,
                    error: null,
                  };
                });
                store.setRows(patches);
              });
            });
          }, Promise.resolve())
          .then(function () {
            store.set({
              status: "ready",
              msg: total + " proposal(s) across " + ids.length + " scene(s) · " + eng.tagCount + " tags",
            });
          });
      })
      .catch(function (e) {
        var failed = {};
        ids.forEach(function (id) {
          failed[id] = { status: "error", error: e.message };
        });
        store.setRows(failed);
        store.set({ status: "error", msg: e.message });
      });
  }

  function checkedTagIds(row) {
    return (row.proposals || [])
      .filter(function (p) {
        return row.checked && row.checked[p.tagId];
      })
      .map(function (p) {
        return p.tagId;
      });
  }

  function refreshSceneQueries() {
    try {
      var client = api.utils.StashService.getClient();
      return client.refetchQueries({ include: ["FindScenes"] });
    } catch (e) {
      return Promise.resolve();
    }
  }

  // Save checked chips for the given scenes; scenes needing identical tag
  // sets are grouped into one bulkSceneUpdate (ADD mode never removes tags).
  function save(ids) {
    var rows = store.state.rows;
    var groups = new Map();
    var saving = {};
    ids.forEach(function (id) {
      var row = rows[id];
      if (!row || row.status !== "ready") return;
      var tagIds = checkedTagIds(row).sort();
      saving[id] = { status: tagIds.length ? "saving" : "saved", added: tagIds.length ? null : [] };
      if (!tagIds.length) return;
      var key = tagIds.join(",");
      if (!groups.has(key)) groups.set(key, { tagIds: tagIds, ids: [] });
      groups.get(key).ids.push(id);
    });
    store.setRows(saving);
    var jobs = Array.from(groups.values()).map(function (g) {
      return gql(BULK_ADD_M, { ids: g.ids, tags: g.tagIds })
        .then(function () {
          var done = {};
          g.ids.forEach(function (id) {
            var row = store.state.rows[id];
            done[id] = {
              status: "saved",
              added: row.proposals
                .filter(function (p) {
                  return g.tagIds.indexOf(p.tagId) >= 0;
                })
                .map(function (p) {
                  return p.tagName;
                }),
            };
          });
          store.setRows(done);
        })
        .catch(function (e) {
          var failed = {};
          g.ids.forEach(function (id) {
            failed[id] = { status: "ready", error: "Save failed: " + e.message };
          });
          store.setRows(failed);
        });
    });
    return Promise.all(jobs).then(function () {
      if (jobs.length) return refreshSceneQueries();
    });
  }

  // ------------------------------------------------------------ DOM adapter

  function sceneIdOf(item) {
    var a = item.querySelector("a.scene-link") || item.querySelector('a[href*="/scenes/"]');
    var m = a && /\/scenes\/(\d+)/.exec(a.getAttribute("href") || "");
    return m ? m[1] : null;
  }
  function taggerItems() {
    return Array.prototype.slice.call(
      document.querySelectorAll(".tagger-container .search-item")
    );
  }
  function visibleIds() {
    return taggerItems().map(sceneIdOf).filter(Boolean);
  }
  function selectedIds() {
    return taggerItems()
      .filter(function (it) {
        var cb = it.querySelector("input.search-item-check");
        return cb && cb.checked;
      })
      .map(sceneIdOf)
      .filter(Boolean);
  }
  function targetIds() {
    var sel = selectedIds();
    return sel.length ? sel : visibleIds();
  }

  // --------------------------------------------------------------- views

  function pct(x) {
    return Math.round(x * 100) + "%";
  }

  function Highlight(props) {
    var text = props.text;
    var ev = props.ev;
    var lo = 0;
    var hi = text.length;
    if (text.length > 160) {
      lo = Math.max(0, ev.start - 70);
      hi = Math.min(text.length, ev.end + 70);
    }
    var spans = (props.masked || [])
      .map(function (m) {
        return { start: m.start, end: m.end, cls: "atr-mask", title: "masked " + m.kind };
      })
      .concat([{ start: ev.start, end: ev.end, cls: "atr-hit" }])
      .filter(function (s) {
        return s.end > lo && s.start < hi;
      })
      .sort(function (a, b) {
        return a.start - b.start;
      });
    var out = [];
    var pos = lo;
    if (lo > 0) out.push("…");
    spans.forEach(function (s, i) {
      var st = Math.max(s.start, pos);
      if (st > pos) out.push(text.slice(pos, st));
      if (s.end > st) {
        out.push(h("span", { key: i, className: s.cls, title: s.title }, text.slice(st, Math.min(s.end, hi))));
      }
      pos = Math.max(pos, Math.min(s.end, hi));
    });
    if (pos < hi) out.push(text.slice(pos, hi));
    if (hi < text.length) out.push("…");
    return h("div", { className: "atr-ev-text" }, out);
  }

  function Evidence(props) {
    var ev = props.ev;
    var field = props.fields[ev.field] || { text: "", masked: [] };
    var meta =
      ev.field +
      ' · "' +
      ev.phrase +
      '" via ' +
      ev.source +
      (ev.variant ? " (inflected)" : "") +
      " · " +
      (ev.precision != null ? pct(ev.precision) + " of " + ev.hits : "unscored");
    return h(
      "div",
      { className: "atr-ev" },
      h("div", { className: "atr-ev-meta" }, meta),
      h(Highlight, { text: field.text, masked: field.masked, ev: ev })
    );
  }

  function Chip(props) {
    var p = props.p;
    var on = props.on;
    var disabled = props.disabled;
    return h(
      "span",
      {
        className:
          "atr-chip atr-" + p.route + (on ? " is-on" : "") + (disabled ? " is-disabled" : ""),
        role: "checkbox",
        "aria-checked": on,
        tabIndex: 0,
        onClick: disabled ? undefined : props.onToggle,
        onKeyDown: function (e) {
          if (!disabled && (e.key === " " || e.key === "Enter")) {
            e.preventDefault();
            props.onToggle();
          }
        },
      },
      h("span", { className: "atr-chip-box" }, on ? "✓" : ""),
      p.tagName,
      h(
        "div",
        { className: "atr-pop" },
        p.evidence.map(function (ev, i) {
          return h(Evidence, { key: i, ev: ev, fields: props.fields });
        })
      )
    );
  }

  function Row(props) {
    var state = useStore();
    var id = props.sceneId;
    var row = state.rows[id];

    var runBtn = h(
      Button,
      {
        size: "sm",
        variant: "secondary",
        className: "atr-run",
        disabled: row && (row.status === "loading" || row.status === "saving"),
        onClick: function () {
          run([id]);
        },
      },
      row && row.status !== "idle" ? "Re-run auto-tag" : "Auto-tag"
    );

    if (!row) return h("div", { className: "atr-panel atr-empty" }, runBtn);
    if (row.status === "loading") {
      return h("div", { className: "atr-panel" }, h("span", { className: "atr-muted" }, "Auto-tagging…"));
    }
    if (row.status === "error" && !row.proposals) {
      return h("div", { className: "atr-panel" }, h("span", { className: "text-danger" }, row.error), runBtn);
    }

    var proposals = row.proposals || [];
    var saved = row.status === "saved";
    var nChecked = checkedTagIds(row).length;

    var body;
    if (saved) {
      body = h(
        "span",
        { className: "atr-saved" },
        row.added && row.added.length ? "✓ Added: " + row.added.join(", ") : "Nothing added"
      );
    } else if (!proposals.length) {
      body = h("span", { className: "atr-muted" }, "No tags proposed");
    } else {
      body = h(
        "div",
        { className: "atr-chips" },
        proposals.map(function (p) {
          return h(Chip, {
            key: p.tagId,
            p: p,
            fields: row.fields,
            on: !!row.checked[p.tagId],
            disabled: row.status === "saving",
            onToggle: function () {
              var checked = Object.assign({}, store.state.rows[id].checked);
              checked[p.tagId] = !checked[p.tagId];
              var patch = {};
              patch[id] = { checked: checked };
              store.setRows(patch);
            },
          });
        })
      );
    }

    return h(
      "div",
      { className: "atr-panel" },
      h("span", { className: "atr-label" }, "Auto-tag"),
      body,
      row.error ? h("span", { className: "text-danger ml-2" }, row.error) : null,
      h(
        "div",
        { className: "atr-actions" },
        !saved && proposals.length
          ? h(
              Button,
              {
                size: "sm",
                variant: "primary",
                disabled: row.status === "saving" || !nChecked,
                onClick: function () {
                  save([id]);
                },
              },
              row.status === "saving" ? "Saving…" : "Save (" + nChecked + ")"
            )
          : null,
        runBtn
      )
    );
  }

  function Header() {
    var state = useStore();
    var busy = state.status === "loading";
    var rows = state.rows;
    var visible = visibleIds();
    var pendingTags = 0;
    var pendingScenes = 0;
    visible.forEach(function (id) {
      var r = rows[id];
      if (r && r.status === "ready") {
        var n = checkedTagIds(r).length;
        if (n) {
          pendingTags += n;
          pendingScenes++;
        }
      }
    });
    var sel = state.selected;
    return h(
      "div",
      { className: "atr-header-inner" },
      state.msg
        ? h(
            "span",
            { className: "atr-status" + (state.status === "error" ? " text-danger" : ""), title: state.msg },
            state.msg
          )
        : null,
      h(
        Button,
        {
          variant: "secondary",
          disabled: busy,
          onClick: function () {
            run(targetIds());
          },
        },
        busy ? "Auto-tagging…" : sel ? "Auto-tag Selected" : "Auto-tag All"
      ),
      pendingScenes
        ? h(
            Button,
            {
              variant: "primary",
              className: "ml-1",
              disabled: busy,
              onClick: function () {
                save(visible);
              },
              title: "Add all checked auto-tag chips on this page",
            },
            "Save auto-tags (" + pendingTags + " in " + pendingScenes + ")"
          )
        : null,
      h(
        Button,
        {
          variant: "minimal",
          className: "ml-1 atr-reload",
          disabled: busy,
          title: "Reload tags and rules.yaml",
          onClick: function () {
            enginePromise = null;
            idbSet(CACHE_KEY, null);
            store.set({ msg: "Tags and rules will reload on next run" });
          },
        },
        "↻"
      )
    );
  }

  // ------------------------------------------------------------- mounting

  var mounts = new Map();
  function mount(el, node) {
    var root = createRoot(el);
    root.render(node);
    mounts.set(el, root);
  }

  function updateSelection() {
    var n = selectedIds().length;
    if (n !== store.state.selected) store.set({ selected: n });
  }

  function sync() {
    if (document.querySelector(".tagger-container")) {
      var header = document.querySelector(".tagger-container-header");
      if (header && !header.querySelector(".atr-header")) {
        var host =
          header.querySelector(".d-flex.justify-content-between > .d-flex") || header;
        var el = document.createElement("div");
        el.className = "atr-header";
        host.insertBefore(el, host.firstChild);
        mount(el, h(Header));
      }
      taggerItems().forEach(function (item) {
        var id = sceneIdOf(item);
        if (!id) return;
        var cur = item.querySelector(":scope > .atr-row");
        if (cur && cur.dataset.scene !== id) {
          var old = mounts.get(cur);
          mounts.delete(cur);
          cur.remove();
          if (old) setTimeout(function () { old.unmount(); });
          cur = null;
        }
        if (!cur) {
          var rowEl = document.createElement("div");
          rowEl.className = "atr-row";
          rowEl.dataset.scene = id;
          item.appendChild(rowEl);
          mount(rowEl, h(Row, { sceneId: id }));
        }
      });
      updateSelection();
    }
    mounts.forEach(function (root, el) {
      if (!el.isConnected) {
        mounts.delete(el);
        setTimeout(function () { root.unmount(); });
      }
    });
  }

  if (!createRoot) {
    console.warn("[autoTagReview] ReactDOMClient.createRoot unavailable; UI disabled");
    return;
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      sync();
    });
  }
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  // Checkbox state changes don't mutate the DOM tree; watch input events.
  document.addEventListener(
    "click",
    function () {
      setTimeout(updateSelection, 0);
    },
    true
  );
  document.addEventListener("change", function () {
    setTimeout(updateSelection, 0);
  }, true);
  schedule();

  // Debug/console access.
  window.AutoTagReview = { run: run, save: save, store: store, ensureEngine: ensureEngine };
})();
