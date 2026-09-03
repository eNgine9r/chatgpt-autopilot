import path from "node:path";

export function buildChromiumEnvironment(config, baseEnv = {}) {
  return {
    ...baseEnv,
    DISPLAY: config.display,
    XDG_RUNTIME_DIR: config.xdgRuntimeDir,
    WAYLAND_DISPLAY: config.waylandDisplay,
    DBUS_SESSION_BUS_ADDRESS: config.dbusSessionBusAddress,
    ...(config.xauthority ? { XAUTHORITY: config.xauthority } : {})
  };
}

export function chromiumPlatformArgs(config) {
  if (config.chromiumOzonePlatform !== "wayland") {
    throw new Error("CHROMIUM_OZONE_PLATFORM must be wayland for the Raspberry Pi Autopilot runtime");
  }
  return [
    `--ozone-platform=${config.chromiumOzonePlatform}`,
    "--password-store=basic"
  ];
}

export function waylandSocketPath(config) {
  return path.join(config.xdgRuntimeDir, config.waylandDisplay);
}
