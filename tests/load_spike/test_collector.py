import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path

P = Path(__file__).resolve().parents[2] / "tools" / "load_spike" / "collector.py"
spec = importlib.util.spec_from_file_location("collector", P)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class TestCollector(unittest.TestCase):
    def test_stat_with_spaced_comm(self):
        # Fields 3..24: state, ppid, ... utime(14), stime(15), start(22), rss(24)
        f = ["S", "12"] + ["0"] * 20
        f[11], f[12], f[19], f[21] = "100", "25", "678", "6"
        parsed = collector.parse_stat("444 (worker (node)) " + " ".join(f))
        self.assertEqual((parsed["pid"], parsed["ppid"]), (444, 12))
        self.assertEqual(parsed["cpu_ticks"], 125)
        self.assertEqual(parsed["start_ticks"], 678)
        self.assertEqual(parsed["rss_pages"], 6)

    def test_stat_rejects_truncated(self):
        with self.assertRaises((ValueError, IndexError)):
            collector.parse_stat("43 (bad) S")

    def test_unit_basename_only(self):
        raw = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/nexus-ha-worker.service\n"
        self.assertEqual(collector.systemd_unit(raw), "nexus-ha-worker.service")
        self.assertNotIn("/", collector.systemd_unit(raw))

    def test_unit_ignores_untrusted_name(self):
        self.assertIsNone(collector.systemd_unit("0::/run/bad unit;rm.service"))

    def test_mem_info(self):
        m = collector.mem_info("MemTotal: 400 kB\nMemAvailable: 170 kB\nSwapFree: 500 kB\n")
        self.assertEqual(m["MemAvailableKiB"], 170)

    def test_psi(self):
        obj = collector.psi("some avg10=12.50 avg60=0.03 avg300=0 total=22\nfull avg10=1.0\n")
        self.assertEqual(obj["some"]["avg10"], 12.5)
        self.assertEqual(obj["full"]["avg10"], 1.0)
        self.assertNotIn("total", obj["some"])

    def test_cpu_deltas(self):
        old = {(1, 11): {"cpu_ticks": 100}}
        new = {(1, 11): {"cpu_ticks": 200, "pid": 1, "ppid": 0,
                         "comm": "node", "state": "D", "service": "example.service", "rssKiB": 50}}
        r = collector.top_processes(old, new, seconds=2.0, ticks=100)
        self.assertEqual(r["topCpu"][0]["cpuPct"], 50.0)
        self.assertEqual(r["diskSleepCount"], 1)

    def test_pid_reuse_not_counted(self):
        old = {(1, 11): {"cpu_ticks": 100}}
        new = {(1, 22): {"cpu_ticks": 200, "pid": 1, "ppid": 0,
                         "comm": "node", "state": "R", "service": None, "rssKiB": 50}}
        self.assertEqual(collector.top_processes(old, new, 2.0, 100)["topCpu"][0]["cpuPct"], 0.0)

    def test_save_events_are_private(self):
        with tempfile.TemporaryDirectory() as path:
            p = collector.save_event(Path(path) / "state", "spike_start", {"load1": 3.5})
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            self.assertEqual(p.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(json.loads(p.read_text())["reason"], "spike_start")

    def test_prune_expired(self):
        with tempfile.TemporaryDirectory() as path:
            d = Path(path)
            old = d / "spike-old.json"
            old.write_text("{}")
            os.utime(old, (time.time() - 49 * 3600, time.time() - 49 * 3600))
            collector.prune(d, time.time())
            self.assertFalse(old.exists())

    def test_prune_budget(self):
        with tempfile.TemporaryDirectory() as path:
            d = Path(path)
            for i in range(3):
                p = d / f"spike-{i}.json"
                p.write_text("a" * 40)
                os.utime(p, (time.time() - 30 + i, time.time() - 30 + i))
            collector.prune(d, time.time(), max_bytes=85)
            self.assertEqual(len(list(d.glob("spike-*.json"))), 2)

    def test_loadavg_parser(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            (root / "loadavg").write_text("3.4 2.5 1.0 1/250 123")
            self.assertEqual(collector.current_load(root), (3.4, 2.5, 1.0))


if __name__ == "__main__":
    unittest.main()
