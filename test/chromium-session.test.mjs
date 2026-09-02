import test from "node:test";
import assert from "node:assert/strict";
import { buildChromiumEnvironment, chromiumPlatformArgs, waylandSocketPath } from "../src/chromium-session.mjs";

const config = {
  display: ":0",
  xauthority: "/home/pi/.Xauthority",
  xdgRuntimeDir: "/run/user/1000",
  waylandDisplay: "wayland-0",
  dbusSessionBusAddress: "unix:path=/run/user/1000/bus",
  chromiumOzonePlatform: "wayland"
};

test("Chromium inherits an explicit Wayland user session", () => {
  const env = buildChromiumEnvironment(config, { HOME: "/home/pi" });
  assert.equal(env.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.equal(env.WAYLAND_DISPLAY, "wayland-0");
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
  assert.equal(env.DISPLAY, ":0");
  assert.equal(env.XAUTHORITY, "/home/pi/.Xauthority");
  assert.equal(env.HOME, "/home/pi");
});

test("Chromium is pinned to Wayland and socket path is deterministic", () => {
  assert.deepEqual(chromiumPlatformArgs(config), ["--ozone-platform=wayland"]);
  assert.equal(waylandSocketPath(config), "/run/user/1000/wayland-0");
  assert.throws(() => chromiumPlatformArgs({ ...config, chromiumOzonePlatform: "x11" }), /must be wayland/);
});
