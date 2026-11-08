"""autoTagReview backend.

Called from the UI through runPluginOperation(plugin_id: "autoTagReview",
args: {op: ...}). Raw plugin interface: reads one JSON object from stdin and
writes {"output": ..., "error": ...} to stdout. Standard library only.

Files (in the plugin dir, or $ATR_DATA_DIR for tests):
  rules.json       hand-edited, never written here (seeded from the example;
                   whole-line // comments allowed)
  learned.json     rules learned from review actions, merged under rules.json
  decisions.jsonl  append-only accept/reject log per (scene, tag)
  scores.json      precision per "tagId|phrase|field" (written by scoring)
"""
import copy
import json
import os
import shutil
import sys
import time

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("ATR_DATA_DIR") or PLUGIN_DIR
RULES_FILE = os.path.join(DATA_DIR, "rules.json")
RULES_EXAMPLE = os.path.join(PLUGIN_DIR, "rules.example.json")
LEARNED_FILE = os.path.join(DATA_DIR, "learned.json")
DECISIONS_FILE = os.path.join(DATA_DIR, "decisions.jsonl")
SCORES_FILE = os.path.join(DATA_DIR, "scores.json")

LIST_KEYS = ("match", "exclude", "ignore", "auto_phrases")
LEARN_ACTIONS = {"exclude": "exclude", "ignore": "ignore", "auto": "auto_phrases"}
VERDICTS = ("accept", "reject")


# ----------------------------------------------------------------- files


def strip_line_comments(text):
    """Allow whole-line // comments in rules.json. Lines are blanked rather
    than removed so JSON error line numbers still match the file."""
    return "\n".join(
        "" if line.lstrip().startswith("//") else line for line in text.split("\n")
    )


def load_rules():
    if not os.path.exists(RULES_FILE) and os.path.exists(RULES_EXAMPLE):
        shutil.copyfile(RULES_EXAMPLE, RULES_FILE)
    if not os.path.exists(RULES_FILE):
        return {}
    with open(RULES_FILE, "r", encoding="utf-8-sig") as f:
        text = strip_line_comments(f.read())
    if not text.strip():
        return {}
    try:
        data = json.loads(text)
    except ValueError as e:
        raise RuntimeError("rules.json is not valid JSON: %s" % e)
    if not isinstance(data, dict):
        raise RuntimeError("rules.json must contain an object at the top level")
    return data


def read_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
    os.replace(tmp, path)


def read_learned():
    data = read_json(LEARNED_FILE, {})
    data.setdefault("stoplist", [])
    data.setdefault("tags", {})
    return data


def read_decisions():
    out = []
    if not os.path.exists(DECISIONS_FILE):
        return out
    with open(DECISIONS_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                continue  # tolerate a torn last line
    return out


# ----------------------------------------------------------------- merge


def union(a, b):
    seen = set()
    out = []
    for x in list(a or []) + list(b or []):
        k = str(x).strip().lower()
        if k and k not in seen:
            seen.add(k)
            out.append(x)
    return out


def merge_rules(rules, learned):
    """learned.json under rules.json: lists are unioned, scalars from
    rules.json win."""
    merged = copy.deepcopy(rules) if rules else {}
    merged["stoplist"] = union(merged.get("stoplist"), learned.get("stoplist"))
    tags = merged.get("tags") or {}
    by_lower = {str(k).lower(): k for k in tags}
    for name, lrule in (learned.get("tags") or {}).items():
        key = by_lower.get(str(name).lower())
        if key is None:
            tags[name] = copy.deepcopy(lrule)
            by_lower[str(name).lower()] = name
            continue
        rule = tags[key] or {}
        for k, v in lrule.items():
            if k in LIST_KEYS:
                rule[k] = union(rule.get(k), v)
            elif k not in rule:
                rule[k] = v
        tags[key] = rule
    merged["tags"] = tags
    return merged


def rejected_pairs(decisions):
    last = {}
    for d in decisions:
        last["%s|%s" % (d.get("scene"), d.get("tag"))] = d.get("verdict")
    return sorted(k for k, v in last.items() if v == "reject")


# ------------------------------------------------------------------- ops


def op_load(_args):
    return {
        "rules": merge_rules(load_rules(), read_learned()),
        "scores": read_json(SCORES_FILE, {}),
        "rejected": rejected_pairs(read_decisions()),
    }


def op_decide(args):
    decisions = args.get("decisions") or []
    now = int(time.time())
    lines = []
    for d in decisions:
        if d.get("verdict") not in VERDICTS:
            raise RuntimeError("bad verdict: %r" % (d.get("verdict"),))
        if not d.get("scene") or not d.get("tag"):
            raise RuntimeError("decision needs scene and tag")
        rec = {
            "ts": now,
            "scene": str(d["scene"]),
            "tag": str(d["tag"]),
            "tagName": d.get("tagName"),
            "phrase": d.get("phrase"),
            "field": d.get("field"),
            "route": d.get("route"),
            "verdict": d["verdict"],
        }
        lines.append(json.dumps(rec, sort_keys=True))
    if lines:
        with open(DECISIONS_FILE, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    return {"count": len(lines)}


def op_learn(args):
    action = args.get("action")
    phrase = str(args.get("phrase") or "").strip().lower()
    if not phrase:
        raise RuntimeError("learn needs a phrase")
    learned = read_learned()
    if action == "stoplist":
        learned["stoplist"] = union(learned["stoplist"], [phrase])
        write_json(LEARNED_FILE, learned)
        return {"stoplist": learned["stoplist"]}
    if action not in LEARN_ACTIONS:
        raise RuntimeError("unknown learn action: %r" % (action,))
    tag = str(args.get("tag") or "").strip()
    if not tag:
        raise RuntimeError("learn needs a tag name")
    tags = learned["tags"]
    key = next((k for k in tags if k.lower() == tag.lower()), tag)
    rule = tags.setdefault(key, {})
    field = LEARN_ACTIONS[action]
    rule[field] = union(rule.get(field), [phrase])
    write_json(LEARNED_FILE, learned)
    return {"tag": key, "rule": rule}


OPS = {"load": op_load, "decide": op_decide, "learn": op_learn}


def main():
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    args = payload.get("args") or {}
    op = args.get("op") or args.get("mode")
    out = {"output": None, "error": None}
    try:
        if op not in OPS:
            raise RuntimeError("unknown op: %r" % (op,))
        out["output"] = OPS[op](args)
    except Exception as e:  # report to the UI instead of a bare traceback
        out["error"] = str(e)
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
