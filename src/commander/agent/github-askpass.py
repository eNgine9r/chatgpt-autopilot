#!/usr/bin/python3
import subprocess
import sys

prompt = sys.argv[1] if len(sys.argv) > 1 else ""
lower = prompt.lower()
if "github.com" not in lower:
    raise SystemExit(1)
if lower.startswith("username"):
    print("x-access-token")
    raise SystemExit(0)
if not lower.startswith("password"):
    raise SystemExit(1)
try:
    completed = subprocess.run(
        ["/usr/bin/gh", "auth", "token", "--hostname", "github.com"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=5,
        check=False,
    )
except (OSError, subprocess.TimeoutExpired):
    raise SystemExit(1)
token = completed.stdout.strip()
if completed.returncode != 0 or not token:
    raise SystemExit(1)
print(token)
