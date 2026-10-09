# NEXUS load-spike collector for btc-radar

**Status:** Source only, opt-in, not automatically installed. Does not change
BTC trading, Commander, or NEXUS configuration.

This read-only, unprivileged collector samples Linux `/proc` metadata every 15
seconds. If one-minute load average is >=3.0 for two samples, it writes one
small JSON record. While overloaded, it adds an observation every 120 seconds
and captures a recovery record once load falls below 75% of the threshold.
Each record includes CPU *deltas* (not cumulative CPU), top 10 CPU/RSS
processes, disk-sleep (`D`) tasks, safe systemd-unit basenames, memory/swap
availability and `/proc/pressure/{cpu,memory,io}`. This distinguishes CPU load
from disk I/O waits. Unprivileged processes outside the user may show incomplete
metadata; that is reported as missing rather than privileged access.

No process command lines, environments, credentials, URLs, browser histories,
file contents, packet contents, or hidden agent tokens are read or recorded.
Events are private JSON files (`0700` directory, `0600` files) under
`~/.local/state/nexus-load-spike`. Older than 48 hours or exceeding 10 MiB
combined are deleted on the next event write.

## Controlled opt-in user-level installation

Only after runtime authorization, place the script and unit in these paths:

- `~/.local/lib/nexus-load-spike/collector.py`
- `~/.config/systemd/user/chatgpt-autopilot-load-spike.service`

Create state directory `~/.local/state/nexus-load-spike` (mode 0700), then
run `systemctl --user daemon-reload`, `systemctl --user enable --now
chatgpt-autopilot-load-spike.service`, and check `systemctl --user is-active
chatgpt-autopilot-load-spike.service`. These operations affect **only** this
new collector, not existing services. They must not be attempted in read-only
sessions or via disallowed Commander paths. Do not use `sudo` or bypass policy.

Test without writing or daemon changes:
`python3 tools/load_spike/collector.py --once`.
Run tests with `python3 -m unittest discover -s tests/load_spike -v`.

Caveats: One-minute load average is not CPU percentage; disk sleeps can increase
load. RSS is per-process and can double count shared memory. `MemAvailable`
is the better measure of memory pressure than `MemFree`. First spike capture
uses a 15-second process delta, and short-lived processes that exit between
samples may be missed. Collector records are evidence, not automatic fixes.
