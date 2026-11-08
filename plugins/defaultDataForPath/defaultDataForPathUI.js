/* =========================================================================
 * Default Data For Path - settings editor (Stash UI plugin)
 *
 * Adds a rule editor under this plugin's entry in Settings > Plugins.
 * Rules are saved as a JSON string in the plugin setting "rules", which the
 * backend hook (defaultDataForPath.js) reads on every scan.
 *
 * Folder picking uses Stash's own FolderSelect component (the one behind the
 * library folder picker) when the running Stash exposes it, and falls back to
 * a small browser built on the same `directory` GraphQL query otherwise.
 * ========================================================================= */
(function () {
  "use strict";

  var PLUGIN_ID = "defaultDataForPath";
  var api = window.PluginApi;
  if (!api) return;
  var React = api.React;
  var e = React.createElement;
  var B = api.libraries.Bootstrap;

  /* ---------- GraphQL ---------- */
  function gql(query, variables) {
    return fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ query: query, variables: variables || {} }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
        return j.data;
      });
  }

  function readPluginSettings() {
    return gql("{configuration{plugins}}").then(function (d) {
      return (d.configuration.plugins || {})[PLUGIN_ID] || {};
    });
  }

  // configurePlugin REPLACES the whole settings map: read-modify-write.
  function savePluginSettings(patch) {
    return readPluginSettings().then(function (cur) {
      var merged = Object.assign({}, cur, patch);
      return gql(
        "mutation($id:ID!,$in:Map!){configurePlugin(plugin_id:$id,input:$in)}",
        { id: PLUGIN_ID, in: merged }
      );
    });
  }

  function libraryPaths() {
    return gql("{configuration{general{stashes{path}}}}")
      .then(function (d) {
        return (d.configuration.general.stashes || []).map(function (s) { return s.path; });
      })
      .catch(function () { return []; });
  }

  /* ---------- rule model ---------- */
  var uid = 0;
  function newKey() { return "r" + ++uid; }

  // Rules are stored by name (what the hook looks up), but the pickers work
  // with objects. In the form, tags/performers are arrays of {id, name} and
  // studio is {id, name} or null. id is null when the name isn't in Stash
  // (renamed or deleted); those are kept and shown as warnings.
  var KINDS = {
    tags: { find: "findTags", list: "tags", filter: "tag_filter" },
    performers: { find: "findPerformers", list: "performers", filter: "performer_filter" },
    studios: { find: "findStudios", list: "studios", filter: "studio_filter" },
  };

  function collectNames(rules, acc) {
    rules.forEach(function (r) {
      (r.tags || []).forEach(function (n) { acc.tags[n] = true; });
      (r.performers || []).forEach(function (n) { acc.performers[n] = true; });
      if (r.studio) acc.studios[r.studio] = true;
      collectNames(r.children || [], acc);
    });
    return acc;
  }

  // One request: an exact-name lookup per distinct name, via query aliases.
  // Returns { tags: {name: {id, name}}, performers: {...}, studios: {...} }.
  function resolveNames(rules) {
    var names = collectNames(rules, { tags: {}, performers: {}, studios: {} });
    var parts = [], vars = {}, defs = [], keys = [];
    Object.keys(KINDS).forEach(function (kind) {
      Object.keys(names[kind]).forEach(function (n) {
        var i = keys.length, k = KINDS[kind];
        keys.push({ kind: kind, name: n });
        defs.push("$v" + i + ":String!");
        vars["v" + i] = n;
        parts.push("q" + i + ":" + k.find + "(" + k.filter + ":{name:{value:$v" + i +
          ",modifier:EQUALS}},filter:{per_page:1}){" + k.list + "{id name}}");
      });
    });
    var out = { tags: {}, performers: {}, studios: {} };
    if (!keys.length) return Promise.resolve(out);
    return gql("query(" + defs.join(",") + "){" + parts.join(" ") + "}", vars).then(function (d) {
      keys.forEach(function (key, i) {
        var hit = d["q" + i] && d["q" + i][KINDS[key.kind].list][0];
        if (hit) out[key.kind][key.name] = { id: hit.id, name: hit.name };
      });
      return out;
    });
  }

  function lookupItem(map, name) {
    return map[name] || { id: null, name: name };
  }

  // Internal form: every rule gets a React key and normalised arrays.
  function toForm(rule, found) {
    found = found || { tags: {}, performers: {}, studios: {} };
    return {
      _key: newKey(),
      name: rule.name || "",
      paths: (rule.paths || []).slice(),
      studio: rule.studio ? lookupItem(found.studios, rule.studio) : null,
      tags: (rule.tags || []).map(function (n) { return lookupItem(found.tags, n); }),
      performers: (rule.performers || []).map(function (n) { return lookupItem(found.performers, n); }),
      children: (rule.children || []).map(function (c) { return toForm(c, found); }),
    };
  }

  // Stored rules -> form rules, with names resolved against Stash.
  function loadForm(rules) {
    return resolveNames(rules)
      .catch(function () { return null; })
      .then(function (found) { return rules.map(function (r) { return toForm(r, found); }); });
  }

  function itemNames(items) {
    return items.map(function (x) { return x.name; }).filter(Boolean);
  }

  // Stored form: drop empty fields so the JSON stays readable.
  function fromForm(f) {
    var out = {};
    if (f.name.trim()) out.name = f.name.trim();
    var paths = f.paths.map(function (p) { return p.trim(); }).filter(Boolean);
    // An explicit "" path means "match everything"; keep it if it was the only one.
    if (paths.length) out.paths = paths;
    else if (f.paths.length) out.paths = [""];
    if (f.studio && f.studio.name) out.studio = f.studio.name;
    var tags = itemNames(f.tags);
    if (tags.length) out.tags = tags;
    var performers = itemNames(f.performers);
    if (performers.length) out.performers = performers;
    if (f.children.length) out.children = f.children.map(fromForm);
    return out;
  }

  function emptyRule() {
    return toForm({ paths: [] });
  }

  /* ---------- tag / performer / studio pickers ---------- */

  function pickItems(items) {
    return (items || []).map(function (x) { return { id: x.id, name: x.name }; });
  }

  // Comma-separated text box, used only if this Stash build doesn't expose
  // the picker components.
  function NamesInput(props) {
    var t = React.useState(itemNames(props.items).join(", "));
    var text = t[0], setText = t[1];
    return e(B.Form.Control, {
      className: "text-input", value: text,
      placeholder: props.multi ? "Comma separated" : "",
      onChange: function (ev) {
        var v = ev.currentTarget.value;
        setText(v);
        var names = props.multi ? v.split(",") : [v];
        props.onChange(names.map(function (n) { return n.trim(); }).filter(Boolean)
          .map(function (n) { return { id: null, name: n }; }));
      },
    });
  }

  // A Stash picker (TagSelect / PerformerSelect / StudioSelect) for the items
  // that exist, plus warning badges for stored names Stash no longer has.
  function EntityPicker(props) {
    var Select = api.components && api.components[props.component];
    var items = props.items;
    if (!Select) {
      return e(NamesInput, { items: items, multi: props.multi, onChange: props.onChange });
    }
    var found = items.filter(function (x) { return x.id; });
    var missing = items.filter(function (x) { return !x.id; });
    return e("div", null,
      e(Select, {
        isMulti: props.multi,
        isClearable: !props.multi,
        values: found,
        menuPortalTarget: document.body,
        onSelect: function (sel) {
          var picked = pickItems(sel);
          props.onChange(props.multi ? picked.concat(missing) : picked.slice(0, 1));
        },
      }),
      missing.length ? e("div", { className: "mt-1" },
        missing.map(function (m) {
          return e("span", { key: m.name, className: "badge badge-warning mr-1", title: "Not found in Stash; the hook will skip it" },
            m.name + " (not found) ",
            e("a", {
              href: "#", className: "text-dark", onClick: function (ev) {
                ev.preventDefault();
                props.onChange(items.filter(function (x) { return x !== m; }));
              },
            }, "×"));
        })) : null
    );
  }

  function parseRules(raw) {
    if (!raw) return [];
    var v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(v)) throw new Error("Rules JSON must be an array");
    return v;
  }

  /* ---------- folder picker ---------- */

  // Fallback browser, used only if this Stash build doesn't expose FolderSelect.
  function FallbackFolderSelect(props) {
    var st = React.useState({ dirs: [], parent: null, error: null });
    var data = st[0], setData = st[1];
    var path = props.currentDirectory;

    React.useEffect(function () {
      var live = true;
      gql("query($p:String){directory(path:$p){path parent directories}}", { p: path || null })
        .then(function (d) {
          if (live) setData({ dirs: d.directory.directories || [], parent: d.directory.parent, error: null });
        })
        .catch(function (err) {
          if (live) setData({ dirs: [], parent: null, error: err.message });
        });
      return function () { live = false; };
    }, [path]);

    var roots = !path ? props.defaultDirectories || [] : [];
    var entries = roots.concat(data.dirs);
    return e("div", null,
      e(B.Form.Control, {
        className: "text-input",
        value: path,
        placeholder: "Type a path or pick below",
        onChange: function (ev) { props.onChangeDirectory(ev.currentTarget.value); },
      }),
      data.error && path ? e("div", { className: "text-danger small mt-1" }, data.error) : null,
      e("ul", { className: "folder-list list-unstyled mt-2", style: { maxHeight: "50vh", overflowY: "auto" } },
        data.parent ? e("li", { key: "..", className: "folder-list-parent" },
          e(B.Button, { variant: "link", onClick: function () { props.onChangeDirectory(data.parent); } }, "..")) : null,
        entries.map(function (d) {
          return e("li", { key: d, className: "folder-list-item" },
            e(B.Button, { variant: "link", onClick: function () { props.onChangeDirectory(d); } }, d));
        })
      )
    );
  }

  function FolderPickerModal(props) {
    var cur = React.useState(props.initial || "");
    var dir = cur[0], setDir = cur[1];
    var Picker = (api.components && api.components.FolderSelect) || FallbackFolderSelect;

    return e(B.Modal, { show: true, onHide: props.onCancel, size: "lg" },
      e(B.Modal.Header, { closeButton: true }, e(B.Modal.Title, null, "Select folder")),
      e(B.Modal.Body, null,
        e(Picker, {
          currentDirectory: dir,
          onChangeDirectory: setDir,
          defaultDirectories: props.libraryPaths,
          collapsible: false,
        }),
        e("div", { className: "small text-muted mt-2" },
          "Files whose path contains this folder (case-insensitive) will match, including all subfolders.")
      ),
      e(B.Modal.Footer, null,
        e(B.Button, { variant: "secondary", onClick: props.onCancel }, "Cancel"),
        e(B.Button, { variant: "primary", disabled: !dir, onClick: function () { props.onSelect(dir); } }, "Use this folder")
      )
    );
  }

  /* ---------- rule editor ---------- */

  function RuleEditor(props) {
    var rule = props.rule;
    var pick = React.useState(null); // index being picked, or "new"
    var picking = pick[0], setPicking = pick[1];
    var open = React.useState(!rule.name);
    var expanded = open[0], setExpanded = open[1];

    function set(field, value) {
      var next = Object.assign({}, rule);
      next[field] = value;
      props.onChange(next);
    }
    function setPath(i, v) {
      var paths = rule.paths.slice();
      if (i === "new") paths.push(v); else paths[i] = v;
      set("paths", paths);
    }
    function removePath(i) {
      var paths = rule.paths.slice();
      paths.splice(i, 1);
      set("paths", paths);
    }
    function setChild(i, child) {
      var children = rule.children.slice();
      children[i] = child;
      set("children", children);
    }
    function removeChild(i) {
      var children = rule.children.slice();
      children.splice(i, 1);
      set("children", children);
    }

    var summary = [];
    if (rule.paths.length) summary.push(rule.paths.length + " path" + (rule.paths.length > 1 ? "s" : ""));
    else summary.push("no paths (inherits to children)");
    if (rule.studio) summary.push("studio: " + rule.studio.name);
    if (rule.tags.length) summary.push("tags: " + itemNames(rule.tags).join(", "));
    if (rule.performers.length) summary.push("performers: " + itemNames(rule.performers).join(", "));
    if (rule.children.length) summary.push(rule.children.length + " child rule" + (rule.children.length > 1 ? "s" : ""));

    var header = e("div", { className: "d-flex align-items-center", style: { gap: "0.5rem" } },
      e(B.Button, { variant: "link", className: "p-0 text-left flex-grow-1", onClick: function () { setExpanded(!expanded); } },
        e("strong", null, (expanded ? "▾ " : "▸ ") + (rule.name || "(unnamed rule)")),
        e("span", { className: "text-muted small ml-2" }, summary.join(" · "))
      ),
      props.onMoveUp ? e(B.Button, { size: "sm", variant: "secondary", title: "Move up", onClick: props.onMoveUp }, "↑") : null,
      props.onMoveDown ? e(B.Button, { size: "sm", variant: "secondary", title: "Move down", onClick: props.onMoveDown }, "↓") : null,
      e(B.Button, { size: "sm", variant: "danger", onClick: props.onRemove }, "Remove")
    );

    if (!expanded) {
      return e(B.Card, { className: "mb-2", style: { marginLeft: props.depth ? "1.5rem" : 0 } },
        e(B.Card.Body, { className: "py-2" }, header));
    }

    function field(label, input, help) {
      return e(B.Form.Group, { className: "mb-2" },
        e(B.Form.Label, { className: "mb-1" }, label),
        input,
        help ? e(B.Form.Text, { className: "text-muted" }, help) : null
      );
    }

    return e(B.Card, { className: "mb-2", style: { marginLeft: props.depth ? "1.5rem" : 0 } },
      e(B.Card.Body, { className: "py-2" },
        header,
        e("div", { className: "mt-2" },
          field("Name", e(B.Form.Control, {
            className: "text-input", value: rule.name, placeholder: "Optional, for your own organisation",
            onChange: function (ev) { set("name", ev.currentTarget.value); },
          })),
          field("Paths",
            e("div", null,
              rule.paths.map(function (p, i) {
                return e(B.InputGroup, { key: i, className: "mb-1" },
                  e(B.Form.Control, {
                    className: "text-input", value: p,
                    placeholder: "(empty = match every file)",
                    onChange: function (ev) { setPath(i, ev.currentTarget.value); },
                  }),
                  e(B.InputGroup.Append, null,
                    e(B.Button, { variant: "secondary", onClick: function () { setPicking(i); } }, "Browse…"),
                    e(B.Button, { variant: "danger", onClick: function () { removePath(i); } }, "×")
                  )
                );
              }),
              e(B.Button, { size: "sm", variant: "secondary", onClick: function () { setPicking("new"); } }, "Add folder…"),
              e(B.Button, { size: "sm", variant: "link", onClick: function () { setPath("new", ""); } }, "Add path manually")
            ),
            "Leave empty to make this a grouping rule: its studio/tags/performers are passed down to its child rules."
          ),
          field("Studio", e(EntityPicker, {
            component: "StudioSelect", multi: false,
            items: rule.studio ? [rule.studio] : [],
            onChange: function (items) { set("studio", items[0] || null); },
          })),
          field("Tags", e(EntityPicker, {
            component: "TagSelect", multi: true, items: rule.tags,
            onChange: function (items) { set("tags", items); },
          })),
          field("Performers", e(EntityPicker, {
            component: "PerformerSelect", multi: true, items: rule.performers,
            onChange: function (items) { set("performers", items); },
          })),
          rule.children.map(function (c, i) {
            return e(RuleEditor, {
              key: c._key, rule: c, depth: props.depth + 1, libraryPaths: props.libraryPaths,
              onChange: function (next) { setChild(i, next); },
              onRemove: function () { removeChild(i); },
            });
          }),
          e(B.Button, {
            size: "sm", variant: "secondary", style: { marginLeft: "1.5rem" },
            onClick: function () { set("children", rule.children.concat([emptyRule()])); },
          }, "Add child rule")
        )
      ),
      picking !== null ? e(FolderPickerModal, {
        initial: picking === "new" ? "" : rule.paths[picking],
        libraryPaths: props.libraryPaths,
        onCancel: function () { setPicking(null); },
        onSelect: function (dir) { setPath(picking, dir); setPicking(null); },
      }) : null
    );
  }

  function RulesEditor() {
    var s = React.useState(null);
    var rules = s[0], setRules = s[1];
    var lp = React.useState([]);
    var libs = lp[0], setLibs = lp[1];
    var st = React.useState({ dirty: false, saving: false, msg: null, err: null });
    var status = st[0], setStatus = st[1];
    var rj = React.useState(null); // raw JSON text while the JSON view is open
    var rawText = rj[0], setRawText = rj[1];

    React.useEffect(function () {
      libraryPaths().then(setLibs);
      readPluginSettings()
        .then(function (cfg) {
          var stored;
          try { stored = parseRules(cfg.rules); }
          catch (err) { setRules([]); setStatus({ dirty: false, saving: false, msg: null, err: "Stored rules are invalid: " + err.message }); return; }
          return loadForm(stored).then(setRules);
        })
        .catch(function (err) { setRules([]); setStatus({ dirty: false, saving: false, msg: null, err: err.message }); });
    }, []);

    if (rules === null) return e("div", { className: "text-muted" }, "Loading rules…");

    function update(next) {
      setRules(next);
      setStatus({ dirty: true, saving: false, msg: null, err: null });
    }
    function move(i, d) {
      var next = rules.slice();
      var t = next[i]; next[i] = next[i + d]; next[i + d] = t;
      update(next);
    }
    function save() {
      var payload;
      if (rawText !== null) {
        try { payload = parseRules(rawText); }
        catch (err) { setStatus(Object.assign({}, status, { err: "Invalid JSON: " + err.message })); return; }
        loadForm(payload).then(function (forms) { setRules(forms); setRawText(null); });
      } else {
        payload = rules.map(fromForm);
      }
      setStatus({ dirty: true, saving: true, msg: null, err: null });
      savePluginSettings({ rules: JSON.stringify(payload) })
        .then(function () { setStatus({ dirty: false, saving: false, msg: "Saved.", err: null }); })
        .catch(function (err) { setStatus({ dirty: true, saving: false, msg: null, err: err.message }); });
    }
    function toggleRaw() {
      if (rawText === null) {
        setRawText(JSON.stringify(rules.map(fromForm), null, 2));
        return;
      }
      try {
        var parsed = parseRules(rawText);
        loadForm(parsed).then(function (forms) {
          setRules(forms);
          setRawText(null);
          setStatus({ dirty: true, saving: false, msg: null, err: null });
        });
      } catch (err) {
        setStatus(Object.assign({}, status, { err: "Invalid JSON: " + err.message }));
      }
    }

    var body = rawText !== null
      ? e(B.Form.Control, {
          as: "textarea", className: "text-input", rows: 18, value: rawText,
          style: { fontFamily: "monospace" },
          onChange: function (ev) { setRawText(ev.currentTarget.value); setStatus({ dirty: true, saving: false, msg: null, err: null }); },
        })
      : e("div", null,
          rules.length ? null : e("div", { className: "text-muted mb-2" },
            "No rules yet. Until rules are saved here, the plugin uses the jsonData array inside defaultDataForPath.js."),
          rules.map(function (r, i) {
            return e(RuleEditor, {
              key: r._key, rule: r, depth: 0, libraryPaths: libs,
              onChange: function (next) { var a = rules.slice(); a[i] = next; update(a); },
              onRemove: function () { var a = rules.slice(); a.splice(i, 1); update(a); },
              onMoveUp: i > 0 ? function () { move(i, -1); } : null,
              onMoveDown: i < rules.length - 1 ? function () { move(i, 1); } : null,
            });
          }),
          e(B.Button, { variant: "secondary", onClick: function () { update(rules.concat([emptyRule()])); } }, "Add rule")
        );

    return e("div", { className: "setting-group ddfp-editor", style: { padding: "1rem" } },
      e("h3", null, "Path rules"),
      e("p", { className: "text-muted small" },
        "New scenes, images and galleries whose path contains a rule's folder get that rule's studio, tags and performers. " +
        "Pick tags, performers and the studio from your Stash library; names that no longer exist are flagged."),
      body,
      e("div", { className: "d-flex align-items-center mt-3", style: { gap: "0.5rem" } },
        e(B.Button, { variant: "primary", disabled: !status.dirty || status.saving, onClick: save },
          status.saving ? "Saving…" : "Save rules"),
        e(B.Button, { variant: "secondary", onClick: toggleRaw }, rawText === null ? "Edit as JSON" : "Back to editor"),
        status.dirty && !status.saving ? e("span", { className: "text-warning small" }, "Unsaved changes") : null,
        status.msg ? e("span", { className: "text-success small" }, status.msg) : null,
        status.err ? e("span", { className: "text-danger small" }, status.err) : null
      )
    );
  }

  /* ---------- mount under this plugin's settings entry ---------- */
  api.patch.instead("PluginSettings", function (props) {
    var args = Array.prototype.slice.call(arguments);
    var next = args.pop();
    var original = next.apply(this, args);
    if (!props || props.pluginID !== PLUGIN_ID) return original;
    return e(React.Fragment, null, original, e(RulesEditor));
  });
})();
