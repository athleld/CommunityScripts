"""Run: python -m unittest discover -s plugins/autoTagReview/test -p "test_*.py" """
import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "autoTagReview.py")


def call(data_dir, args):
    env = dict(os.environ, ATR_DATA_DIR=data_dir)
    p = subprocess.run(
        [sys.executable, "-I", SCRIPT],
        input=json.dumps({"args": args}),
        capture_output=True,
        text=True,
        env=env,
        check=True,
    )
    return json.loads(p.stdout)


class BackendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def write_rules(self, text):
        with open(os.path.join(self.dir, "rules.yaml"), "w", encoding="utf-8") as f:
            f.write(text)

    def test_load_seeds_rules_from_example(self):
        out = call(self.dir, {"op": "load"})
        self.assertIsNone(out["error"])
        self.assertIn("welcome home", out["output"]["rules"]["stoplist"])
        self.assertTrue(os.path.exists(os.path.join(self.dir, "rules.yaml")))
        self.assertEqual(out["output"]["rejected"], [])
        self.assertEqual(out["output"]["scores"], {})

    def test_unknown_op_reports_error(self):
        out = call(self.dir, {"op": "nope"})
        self.assertIn("unknown op", out["error"])

    def test_learn_merges_under_rules_yaml(self):
        self.write_rules("tags:\n  Home:\n    mode: review\n    exclude: [welcome home]\n")
        self.assertIsNone(call(self.dir, {"op": "learn", "action": "exclude", "tag": "home", "phrase": "Home Alone"})["error"])
        call(self.dir, {"op": "learn", "action": "exclude", "tag": "Home", "phrase": "welcome home"})
        call(self.dir, {"op": "learn", "action": "auto", "tag": "Pants", "phrase": "pants off"})
        call(self.dir, {"op": "learn", "action": "ignore", "tag": "Pants", "phrase": "trousers"})
        call(self.dir, {"op": "learn", "action": "stoplist", "phrase": "Home Run"})
        rules = call(self.dir, {"op": "load"})["output"]["rules"]
        self.assertEqual(rules["tags"]["Home"]["mode"], "review")
        self.assertEqual(rules["tags"]["Home"]["exclude"], ["welcome home", "home alone"])
        self.assertEqual(rules["tags"]["Pants"], {"auto_phrases": ["pants off"], "ignore": ["trousers"]})
        self.assertEqual(rules["stoplist"], ["home run"])
        with open(os.path.join(self.dir, "learned.json"), encoding="utf-8") as f:
            learned = json.load(f)
        self.assertEqual(sorted(learned["tags"]), ["Pants", "home"])  # first spelling kept, no dup

    def test_learn_validates(self):
        self.assertIn("phrase", call(self.dir, {"op": "learn", "action": "exclude", "tag": "X"})["error"])
        self.assertIn("unknown learn action", call(self.dir, {"op": "learn", "action": "zap", "tag": "X", "phrase": "y"})["error"])
        self.assertIn("tag name", call(self.dir, {"op": "learn", "action": "exclude", "phrase": "y"})["error"])

    def test_decisions_last_verdict_wins(self):
        out = call(self.dir, {"op": "decide", "decisions": [
            {"scene": "1", "tag": "10", "verdict": "reject", "phrase": "home", "field": "title"},
            {"scene": "2", "tag": "10", "verdict": "reject"},
            {"scene": "3", "tag": "11", "verdict": "accept"},
        ]})
        self.assertEqual(out["output"], {"count": 3})
        call(self.dir, {"op": "decide", "decisions": [{"scene": "2", "tag": "10", "verdict": "accept"}]})
        with open(os.path.join(self.dir, "decisions.jsonl"), "a", encoding="utf-8") as f:
            f.write('{"torn": ')  # partial line must not break load
        self.assertEqual(call(self.dir, {"op": "load"})["output"]["rejected"], ["1|10"])

    def test_decide_validates(self):
        self.assertIn("bad verdict", call(self.dir, {"op": "decide", "decisions": [{"scene": "1", "tag": "2", "verdict": "maybe"}]})["error"])
        self.assertFalse(os.path.exists(os.path.join(self.dir, "decisions.jsonl")))


if __name__ == "__main__":
    unittest.main()
