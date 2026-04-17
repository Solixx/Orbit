import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Prefer node.exe + index.js (Cursor Agent layout) on Windows — no cmd.exe, argv passed safely. */
function resolveWindowsAgentNodeDirect(
  agentCmdPath: string,
  agentArgs: string[],
): { command: string; spawnArgs: string[] } | null {
  const root = dirname(agentCmdPath);
  const versionsDir = join(root, "versions");
  if (!existsSync(versionsDir)) return null;

  const versionDirs = readdirSync(versionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => /^\d{4}\.\d{1,2}\.\d{1,2}-[a-f0-9]+$/i.test(name))
    .sort((a, b) => compareAgentVersionDirs(a, b));

  const latest = versionDirs[versionDirs.length - 1];
  if (!latest) return null;

  const nodeExe = join(versionsDir, latest, "node.exe");
  const indexJs = join(versionsDir, latest, "index.js");
  if (!existsSync(nodeExe) || !existsSync(indexJs)) return null;

  return { command: nodeExe, spawnArgs: [indexJs, ...agentArgs] };
}

function compareAgentVersionDirs(a: string, b: string): number {
  return parseAgentVersionSortKey(a) - parseAgentVersionSortKey(b);
}

function parseAgentVersionSortKey(name: string): number {
  const datePart = name.split("-")[0] ?? "";
  const parts = datePart.split(".");
  if (parts.length !== 3) return 0;
  const [y, m, d] = parts;
  const month = (m ?? "").padStart(2, "0");
  const day = (d ?? "").padStart(2, "0");
  return Number.parseInt(`${y}${month}${day}`, 10) || 0;
}

export function augmentPathEnv(
  env: Record<string, string> & { PATH?: string },
): Record<string, string> {
  if (process.platform === "win32") return env;
  const localBin = join(homedir(), ".local", "bin");
  return { ...env, PATH: `${localBin}:${env.PATH ?? ""}` };
}

/**
 * Windows: spawn cannot exec .cmd directly (EINVAL). Prefer direct node.exe spawn (no shell).
 * Fallback: shell only for .cmd/.bat — Node quotes argv for cmd.exe /d /s /c (still avoid untrusted AGENT_BIN).
 */
export function resolveAgentSpawn(
  agentBin: string,
  agentArgs: string[],
): { command: string; spawnArgs: string[]; shell: boolean } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(agentBin)) {
    const direct = resolveWindowsAgentNodeDirect(agentBin, agentArgs);
    if (direct) {
      return { command: direct.command, spawnArgs: direct.spawnArgs, shell: false };
    }
    return { command: agentBin, spawnArgs: agentArgs, shell: true };
  }
  return { command: agentBin, spawnArgs: agentArgs, shell: false };
}
