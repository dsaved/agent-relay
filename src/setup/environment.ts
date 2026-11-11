/** Requirement #2's "detect operating system and runtime dependencies" — plain, read-only checks of this process's own `process.platform`/`process.version`, nothing spawned. */
export interface EnvironmentCheck {
  platform: NodeJS.Platform;
  isMacOS: boolean;
  nodeVersion: string;
  nodeMajor: number;
  requiredNodeMajor: number;
  nodeVersionSupported: boolean;
  detail: string;
}

export function checkEnvironment(requiredNodeMajor = 22, platform: NodeJS.Platform = process.platform, nodeVersion: string = process.version): EnvironmentCheck {
  const isMacOS = platform === "darwin";
  const nodeMajor = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
  const nodeVersionSupported = Number.isFinite(nodeMajor) && nodeMajor >= requiredNodeMajor;

  const notes: string[] = [`platform: ${platform}${isMacOS ? "" : " (launchd activation is macOS-only; daemon start/stop/status still work)"}`];
  notes.push(nodeVersionSupported ? `node ${nodeVersion} satisfies the required >=${requiredNodeMajor}` : `node ${nodeVersion} is older than the required >=${requiredNodeMajor}`);

  return { platform, isMacOS, nodeVersion, nodeMajor, requiredNodeMajor, nodeVersionSupported, detail: notes.join("; ") };
}
