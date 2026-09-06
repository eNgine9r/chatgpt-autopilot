import json
import tempfile
import unittest
from pathlib import Path

from src.browserless.import_legacy import import_legacy
from src.browserless.store import BrowserlessStore


class LegacyImportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = self.root / "projects.json"
        self.config.write_text(json.dumps({"projects":[
            {"id":"p1","enabled":False,"planVersion":"2026-09-04-v1","planAnchor":"ANCHOR"},
            {"id":"shadow","enabled":True,"backend":"codex"}
        ]}))
        self.a = self.root / "a" / "projects"; self.a.mkdir(parents=True)
        self.b = self.root / "b" / "projects"; self.b.mkdir(parents=True)
        (self.a/"p1.json").write_text(json.dumps({"updatedAt":100,"checkpoint":{"revision":1,"stage":"active"}}))
        (self.b/"p1.json").write_text(json.dumps({"updatedAt":200,"checkpoint":{"revision":2,"stage":"complete"}}))
        self.store = BrowserlessStore(str(self.root/"core.sqlite3"))

    def tearDown(self):
        self.store.close(); self.tmp.cleanup()

    def test_imports_newest_browser_checkpoint_without_events(self):
        result = import_legacy(self.store, self.config, [self.a.parent, self.b.parent])
        self.assertEqual([item["projectId"] for item in result], ["p1"])
        self.assertFalse(result[0]["legacyEnabled"])
        self.assertEqual(self.store.project("p1")["checkpoint"]["revision"], 2)
        self.assertEqual(self.store.counts()["events"], 0)
        self.assertEqual(self.store.counts()["jobs"], 0)

    def test_reimport_does_not_clobber_newer_browserless_checkpoint(self):
        import_legacy(self.store, self.config, [self.a.parent, self.b.parent])
        self.store.update_checkpoint("p1", {"revision":3,"stage":"active"})
        import_legacy(self.store, self.config, [self.a.parent, self.b.parent])
        self.assertEqual(self.store.project("p1")["checkpoint"]["revision"], 3)

    def test_requested_missing_project_fails_closed(self):
        with self.assertRaises(ValueError):
            import_legacy(self.store, self.config, [self.a.parent], ["missing"])
