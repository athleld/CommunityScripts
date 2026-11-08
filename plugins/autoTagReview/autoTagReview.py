"""autoTagReview backend.

Called from the UI through runPluginOperation(plugin_id: "autoTagReview",
args: {op: ...}). Raw plugin interface: reads one JSON object from stdin and
writes {"output": ..., "error": ...} to stdout. Standard library + PyYAML only.
"""
import json
import os
import shutil
import sys

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
RULES_FILE = os.path.join(PLUGIN_DIR, "rules.yaml")
RULES_EXAMPLE = os.path.join(PLUGIN_DIR, "rules.example.yaml")


def load_rules():
    if not os.path.exists(RULES_FILE) and os.path.exists(RULES_EXAMPLE):
        shutil.copyfile(RULES_EXAMPLE, RULES_FILE)
    if not os.path.exists(RULES_FILE):
        return {}
    try:
        import yaml
    except ImportError:
        raise RuntimeError(
            "PyYAML is required to read rules.yaml (pip install pyyaml)"
        )
    with open(RULES_FILE, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise RuntimeError("rules.yaml must contain a mapping at the top level")
    return data


def op_load(_args):
    return {"rules": load_rules(), "scores": {}, "rejected": []}


OPS = {"load": op_load}


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
