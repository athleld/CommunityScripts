// Rules are normally edited in Settings > Plugins > Default Data For Path and
// stored in the plugin setting "rules". This array is only used as a fallback
// when no rules have been saved from the UI.
var jsonData = [
  {
    name: "OPTIONAL NAME - NOT USED IN SCRIPT",
    paths: [
      "C:\\Users\\UserName\\Desktop\\NOTPORN\\Brazzers",
      "D:\\SecretStorage\\Porn\\Brazzers",
    ],
    studio: "Brazzers",
    tags: ["Default_Data_For_Path_Tagged"],
  },
];

function ok() {
  return {
    output: "ok",
  };
}

var PLUGIN_ID = "defaultDataForPath";
var LOG = "[DefaultDataForPath]: ";

// Per hook type: the GraphQL root field, the update mutation, and how to read
// the item's path. One request fetches the plugin config and the path together.
var ITEM_TYPES = {
  "Scene.Create.Post": {
    name: "scene",
    query: "findScene(id: $id) { files { path } }",
    field: "findScene",
    update: "sceneUpdate(input: $input) { id }",
    inputType: "SceneUpdateInput",
    path: function (item) {
      return item.files && item.files[0] ? item.files[0].path : null;
    },
  },
  "Image.Create.Post": {
    name: "image",
    query:
      "findImage(id: $id) { visual_files { ... on ImageFile { path } ... on VideoFile { path } } }",
    field: "findImage",
    update: "imageUpdate(input: $input) { id }",
    inputType: "ImageUpdateInput",
    path: function (item) {
      return item.visual_files && item.visual_files[0]
        ? item.visual_files[0].path
        : null;
    },
  },
  "Gallery.Create.Post": {
    name: "gallery",
    // Folder galleries have a folder; zip galleries have a file instead.
    query: "findGallery(id: $id) { folder { path } files { path } }",
    field: "findGallery",
    update: "galleryUpdate(input: $input) { id }",
    inputType: "GalleryUpdateInput",
    path: function (item) {
      if (item.folder) return item.folder.path;
      return item.files && item.files[0] ? item.files[0].path : null;
    },
  },
};

// What each lookup kind is called in GraphQL.
var KINDS = {
  tags: { find: "findTags", list: "tags", filter: "tag_filter", label: "TAG" },
  performers: {
    find: "findPerformers",
    list: "performers",
    filter: "performer_filter",
    label: "PERFORMER",
  },
  studios: {
    find: "findStudios",
    list: "studios",
    filter: "studio_filter",
    label: "STUDIO",
  },
};

function parseSetting(raw) {
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

// Rules saved from the UI editor (setting "rules"), or the jsonData array
// above when nothing has been saved. Also returns the name -> id map the
// editor saves (setting "ids") so names usually need no lookup at all.
function readConfig(plugins) {
  var cfg = (plugins || {})[PLUGIN_ID] || {};
  var rules = jsonData;
  var ids = { tags: {}, performers: {}, studios: {} };
  try {
    var saved = parseSetting(cfg.rules);
    if (saved && saved.length !== undefined) rules = saved;
    else if (saved) log.Error(LOG + "saved rules are not an array, using jsonData");
  } catch (e) {
    log.Error(LOG + "could not parse saved rules (" + e + "), using jsonData");
  }
  try {
    var savedIds = parseSetting(cfg.ids);
    if (savedIds) {
      for (var k in ids) if (savedIds[k]) ids[k] = savedIds[k];
    }
  } catch (e) {
    log.Warn(LOG + "could not parse saved ids (" + e + "), looking names up");
  }
  return { rules: rules, ids: ids };
}

// Resolve names to ids in at most two requests: one exact-name query for every
// name (via aliases), then one fuzzy q query for whatever is still missing, so
// aliases and loosely typed names still work. `wanted` is {kind: [names]}.
function lookupIds(wanted) {
  var found = { tags: {}, performers: {}, studios: {} };
  var pending = [];
  for (var kind in wanted) {
    for (var i = 0; i < wanted[kind].length; i++) {
      pending.push({ kind: kind, name: wanted[kind][i] });
    }
  }
  var passes = [
    function (k, v) {
      return k.filter + ": { name: { value: " + v + ", modifier: EQUALS } }, filter: { per_page: 1 }";
    },
    function (k, v) {
      return "filter: { q: " + v + ", per_page: 1 }";
    },
  ];
  for (var p = 0; p < passes.length && pending.length; p++) {
    var defs = [];
    var parts = [];
    var vars = {};
    for (var j = 0; j < pending.length; j++) {
      var k = KINDS[pending[j].kind];
      defs.push("$v" + j + ": String!");
      vars["v" + j] = pending[j].name;
      parts.push("q" + j + ": " + k.find + "(" + passes[p](k, "$v" + j) + ") { " + k.list + " { id } }");
    }
    var result = gql.Do("query (" + defs.join(", ") + ") { " + parts.join(" ") + " }", vars);
    var still = [];
    for (var j = 0; j < pending.length; j++) {
      var list = result["q" + j] ? result["q" + j][KINDS[pending[j].kind].list] : [];
      if (list && list[0]) found[pending[j].kind][pending[j].name] = list[0].id;
      else still.push(pending[j]);
    }
    pending = still;
  }
  for (var m = 0; m < pending.length; m++) {
    log.Error(KINDS[pending[m].kind].label + " " + pending[m].name + " DOES NOT EXIST IN STASH!");
  }
  return found;
}

// names -> ids, using the saved map first and one batched lookup for the rest.
// With useCache false every name is looked up fresh.
function resolveAll(names, cache, useCache) {
  var resolved = { tags: {}, performers: {}, studios: {} };
  var missing = {};
  var anyMissing = false;
  for (var kind in names) {
    missing[kind] = [];
    for (var i = 0; i < names[kind].length; i++) {
      var n = names[kind][i];
      if (useCache && cache[kind][n]) resolved[kind][n] = cache[kind][n];
      else {
        missing[kind].push(n);
        anyMissing = true;
      }
    }
  }
  if (anyMissing) {
    var looked = lookupIds(missing);
    for (var lk in looked) {
      for (var ln in looked[lk]) resolved[lk][ln] = looked[lk][ln];
    }
  }
  return resolved;
}

function idsFor(list, map) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var id = map[list[i]];
    // Two names (e.g. a name and its alias) can resolve to the same id.
    if (id && stringNotAlreadyPresent(id, out)) out.push(id);
  }
  return out;
}

function main() {
  var hookContext = input.Args.hookContext;
  var type = hookContext.type;
  var ID = hookContext.id;
  var itemType = ITEM_TYPES[type];

  if (!itemType || !ID) {
    return ok();
  }

  // Request 1: plugin config + the item's path.
  var first = gql.Do(
    "query ($id: ID!) { configuration { plugins } " + itemType.query + " }",
    { id: ID }
  );
  var item = first[itemType.field];
  var itemPath = item ? itemType.path(item) : null;
  if (!itemPath) {
    return ok();
  }

  var config = readConfig(first.configuration.plugins);
  jsonData = config.rules;
  var defaultData = getDefaultData(itemPath);

  // Collect names. Tags/performers accumulate; the last matching studio wins.
  var names = { tags: [], performers: [], studios: [] };
  for (var p = 0; p < defaultData.length; p++) {
    var d = defaultData[p];
    var lists = [
      [d.tags, names.tags],
      [d.performers, names.performers],
    ];
    for (var l = 0; l < lists.length; l++) {
      var src = lists[l][0] || [];
      for (var t = 0; t < src.length; t++) {
        if (stringNotAlreadyPresent(src[t], lists[l][1])) lists[l][1].push(src[t]);
      }
    }
    if (d.studio) names.studios = [d.studio];
  }

  if (!names.tags.length && !names.performers.length && !names.studios.length) {
    return ok(); // nothing matched: no write at all
  }

  // Request 2 (usually the last): the update. If it fails, a saved id may be
  // stale (item deleted since the rules were saved), so look every name up
  // fresh and retry once.
  var resolved = resolveAll(names, config.ids, true);
  try {
    applyData(itemType, ID, names, resolved);
  } catch (e) {
    log.Warn(LOG + "update failed (" + e + "), retrying with fresh lookups");
    resolved = resolveAll(names, config.ids, false);
    applyData(itemType, ID, names, resolved);
  }
  return ok();
}

function applyData(itemType, ID, names, resolved) {
  var tagIds = idsFor(names.tags, resolved.tags);
  var performerIds = idsFor(names.performers, resolved.performers);
  var studioIds = idsFor(names.studios, resolved.studios);
  if (!tagIds.length && !performerIds.length && !studioIds.length) {
    return;
  }

  var updateInput = { id: ID };
  if (tagIds.length) updateInput.tag_ids = tagIds;
  if (performerIds.length) updateInput.performer_ids = performerIds;
  if (studioIds.length) updateInput.studio_id = studioIds[0];

  gql.Do(
    "mutation ($input: " + itemType.inputType + "!) { " + itemType.update + " }",
    { input: updateInput }
  );

  var added = [
    ["tag", names.tags, resolved.tags],
    ["performer", names.performers, resolved.performers],
    ["studio", names.studios, resolved.studios],
  ];
  for (var a = 0; a < added.length; a++) {
    for (var i = 0; i < added[a][1].length; i++) {
      if (added[a][2][added[a][1][i]]) {
        log.Info(LOG + "Added " + added[a][0] + " " + added[a][1][i] + " to " + itemType.name + " " + ID);
      }
    }
  }
}

function stringNotAlreadyPresent(text, itemArray) {
  for (var i = 0; i < itemArray.length; i++) {
    if (itemArray[i] === text) {
      return false;
    }
  }
  return true;
}

function addAllData(
  obj,
  lowerItemPath,
  defaultData,
  pTags,
  pPerformers,
  pStudio
) {
  if (obj) {
    if (obj.paths) {
      var paths = obj.paths;
      if (containsPath(paths, lowerItemPath)) {
        // inject data from parent if avail
        if (pTags) {
          if (!obj.tags) {
            obj.tags = [];
          }
          obj.tags = obj.tags.concat(pTags);
        }
        if (pPerformers) {
          if (!obj.performers) {
            obj.performers = [];
          }
          obj.performers = obj.performers.concat(pPerformers);
        }
        if (pStudio) {
          obj.studio = pStudio;
        }
        defaultData.push(obj);
      }
    } else {
      // add defaults to children
      if (obj.tags) {
        if (!pTags) {
          pTags = obj.tags;
        } else {
          pTags = pTags.concat(obj.tags);
        }
      }
      if (obj.performers) {
        if (!pPerformers) {
          pPerformers = obj.performers;
        } else {
          pPerformers = pPerformers.concat(obj.performers);
        }
      }
      if (obj.studio) {
        pStudio = obj.studio;
      }
    }
    if (obj.children) {
      for (var o = 0; o < obj.children.length; o++) {
        defaultData = addAllData(
          obj.children[o],
          lowerItemPath,
          defaultData,
          pTags,
          pPerformers,
          pStudio
        );
      }
    }
  }
  return defaultData;
}

function getDefaultData(itemPath) {
  var defaultData = [];
  var lowerItemPath = itemPath.toLowerCase();
  for (var i = 0; i < jsonData.length; i++) {
    var obj = jsonData[i];
    defaultData = addAllData(obj, lowerItemPath, defaultData, null, null, null);
  }

  return defaultData;
}

function containsPath(paths, inputPath) {
  for (var p = 0; p < paths.length; p++) {
    var path = paths[p].toLowerCase() + "";
    if (stringContains(inputPath, path)) {
      log.Info("[DefaultDataForPath]: " + inputPath + " MATCH " + path);
      return true;
    }
  }
  return false;
}

function stringContains(value, searchFor) {
  var v = (value || "").toLowerCase();
  var v2 = searchFor;
  if (v2) {
    v2 = v2.toLowerCase();
  }
  return v.indexOf(v2) > -1;
}

main();
