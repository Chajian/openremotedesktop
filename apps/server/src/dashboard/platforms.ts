// Static platform descriptions only. Views may import this without loading installers.
export const installerPlatforms = {
  win: {
    label: "Windows",
    installer: {route: "/install/windows.ps1", filename: "install-windows.ps1"},
    support: {route: "windows.cmd", filename: "OpenRemote-Support.cmd"},
  },
  mac: {
    label: "macOS",
    installer: {route: "/install/macos.sh", filename: "install-macos.sh"},
    support: {route: "macos.command", filename: "OpenRemote-Support.command"},
  },
  linux: {
    label: "Linux",
    installer: {route: "/install/linux.sh", filename: "install-linux.sh"},
    support: {route: "linux.sh", filename: "OpenRemote-Support.sh"},
  },
} as const;

export type InstallerOS = keyof typeof installerPlatforms;
export const installerOperatingSystems = Object.keys(installerPlatforms) as readonly InstallerOS[];
