import tempfile
import unittest
from pathlib import Path

from src.browserless.bootstrap import enqueue_checkpoint_bootstraps
from src.browserless.store import BrowserlessStore


def checkpoint(next_action="continue", stage="active"):
    return {"goal":"g","completed":[],"currentTask":"task","decisions":[],"evidence":[],"blockers":[],
            "nextAction":next_action,"doNotRepeat":[],"planVersion":"2026-09-04-v1","stage":stage,"githubPr":0,"revision":7}


class BootstrapTest(unittest.TestCase):
    def test_active_checkpoint_bootstraps_exactly_once_across_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=str(Path(tmp)/"core.sqlite3")
            store=BrowserlessStore(path); store.register_project("p1","2026-09-04-v1","anchor",checkpoint())
            self.assertTrue(enqueue_checkpoint_bootstraps(store)[0]["inserted"])
            self.assertFalse(enqueue_checkpoint_bootstraps(store)[0]["inserted"])
            self.assertEqual(store.counts()["events"],1); store.close()
            store=BrowserlessStore(path)
            self.assertFalse(enqueue_checkpoint_bootstraps(store)[0]["inserted"])
            self.assertEqual(store.counts()["events"],1); store.close()

    def test_changed_checkpoint_creates_new_resume_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            store=BrowserlessStore(str(Path(tmp)/"core.sqlite3")); store.register_project("p1","2026-09-04-v1","anchor",checkpoint("a"))
            enqueue_checkpoint_bootstraps(store); store.update_checkpoint("p1",checkpoint("b"))
            self.assertTrue(enqueue_checkpoint_bootstraps(store)[0]["inserted"])
            self.assertEqual(store.counts()["events"],2); store.close()


    def test_revision_only_change_does_not_create_new_resume_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            store=BrowserlessStore(str(Path(tmp)/"core.sqlite3")); cp=checkpoint("a"); store.register_project("p1","2026-09-04-v1","anchor",cp)
            enqueue_checkpoint_bootstraps(store); cp2=dict(cp); cp2["revision"]=99; store.update_checkpoint("p1",cp2)
            self.assertFalse(enqueue_checkpoint_bootstraps(store)[0]["inserted"])
            self.assertEqual(store.counts()["events"],1); store.close()

    def test_complete_checkpoint_does_not_bootstrap(self):
        with tempfile.TemporaryDirectory() as tmp:
            store=BrowserlessStore(str(Path(tmp)/"core.sqlite3")); store.register_project("p1","2026-09-04-v1","anchor",checkpoint(stage="complete"))
            self.assertEqual(enqueue_checkpoint_bootstraps(store),[])
            self.assertEqual(store.counts()["events"],0); store.close()
