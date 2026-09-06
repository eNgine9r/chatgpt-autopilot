import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ServicePackageTest(unittest.TestCase):
    def test_single_service_runs_single_supervisor(self):
        unit = (ROOT / "systemd/chatgpt-autopilot-browserless.service.template").read_text()
        self.assertEqual(unit.count("ExecStart="), 1)
        self.assertIn("-m src.browserless.supervisor", unit)
        self.assertNotIn("chromium", unit.lower())
        self.assertIn("127.0.0.1", unit)
        self.assertIn("UMask=0077", unit)

    def test_installer_stages_but_never_activates_service(self):
        script = (ROOT / "scripts/install-browserless-systemd.sh").read_text()
        forbidden = ("enable --now", "systemctl --user start", "systemctl --user restart")
        for token in forbidden:
            self.assertNotIn(token, script)
        self.assertIn("daemon-reload", script)
        self.assertIn('chmod 0700 "$APP_DIR/state-browserless"', script)
        self.assertIn('chmod 0600 "$APP_DIR/.env.local"', script)

    def test_private_browserless_files_are_gitignored(self):
        ignore = (ROOT / ".gitignore").read_text().splitlines()
        for expected in (".env.local", "config/browserless-ingress.json", "config/browserless-tools.json", "state-browserless/"):
            self.assertIn(expected, ignore)
