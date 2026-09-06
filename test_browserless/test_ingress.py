import tempfile
import unittest
from pathlib import Path

from src.browserless.ingress import canonical_material, ingest_observation
from src.browserless.store import BrowserlessStore


class IngressTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "core.sqlite3")
        self.store = BrowserlessStore(self.db)
        self.store.register_project("p1", "2026-09-04-v1", "anchor", {})

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_same_material_creates_exactly_one_event_despite_volatile_noise(self):
        first = {"material":{"status":"success","head":"abc","observedAt":1}, "summary":"first", "metadata":{"poll":1}}
        second = {"material":{"head":"abc","status":"success","observedAt":999}, "summary":"different wording", "metadata":{"poll":2}}
        a = ingest_observation(self.store, "p1", "github", "ci:abc", first)
        b = ingest_observation(self.store, "p1", "github", "ci:abc", second)
        self.assertTrue(a["changed"])
        self.assertFalse(b["changed"])
        self.assertEqual(self.store.counts()["observations"], 1)
        self.assertEqual(self.store.counts()["events"], 1)
        self.store.ensure_jobs()
        self.assertEqual(self.store.counts()["jobs"], 1)

    def test_material_change_creates_new_revision_and_event(self):
        ingest_observation(self.store, "p1", "runtime", "service:api", {"material":{"state":"starting"}})
        result = ingest_observation(self.store, "p1", "runtime", "service:api", {"material":{"state":"healthy"}})
        self.assertTrue(result["changed"])
        self.assertEqual(result["revision"], 2)
        self.assertEqual(self.store.counts()["events"], 2)
        self.assertEqual(self.store.observation("p1", "runtime", "service:api")["material"]["state"], "healthy")

    def test_restart_preserves_deduplication(self):
        document = {"material":{"merged":True,"sha":"deadbeef"}}
        ingest_observation(self.store, "p1", "github", "pr:12", document)
        self.store.close()
        self.store = BrowserlessStore(self.db)
        result = ingest_observation(self.store, "p1", "github", "pr:12", document)
        self.assertFalse(result["changed"])
        self.assertEqual(self.store.counts()["events"], 1)

    def test_list_order_and_volatile_fields_do_not_change_hash(self):
        a, ah = canonical_material({"checks":["lint","test"],"checked_at":1,"nested":{"updatedAt":2,"state":"ok"}})
        b, bh = canonical_material({"checks":["test","lint"],"checked_at":99,"nested":{"updatedAt":8,"state":"ok"}})
        self.assertEqual(ah, bh)
        self.assertEqual(a, b)

    def test_unknown_project_source_or_bad_subject_fail_closed(self):
        with self.assertRaises(KeyError):
            ingest_observation(self.store, "missing", "github", "ci:x", {"material":{}})
        with self.assertRaises(ValueError):
            ingest_observation(self.store, "p1", "web", "ci:x", {"material":{}})
        with self.assertRaises(ValueError):
            ingest_observation(self.store, "p1", "github", "bad subject with spaces", {"material":{}})

    def test_material_must_be_bounded_object(self):
        with self.assertRaises(ValueError):
            canonical_material(["not", "object"])
        material, digest = canonical_material({"x":"a" * 40000})
        self.assertEqual(len(material["x"]), 2000)
        self.assertEqual(len(digest), 64)
