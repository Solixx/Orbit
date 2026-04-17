import { createHash } from "node:crypto";
import { normalize, resolve } from "node:path";

function canonicalizePath(inputPath: string): string {
  // Deterministic across runs on the same machine; also reduces Windows case drift.
  const resolved = resolve(inputPath);
  const normalized = normalize(resolved);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function projectIdFromPath(projectPath: string): string {
  const canonical = canonicalizePath(projectPath);
  const hex = createHash("sha256").update(canonical).digest("hex");
  // Short, stable, URL-safe-ish identifier. Collision risk is negligible for local usage.
  return `p_${hex.slice(0, 16)}`;
}

export function canonicalProjectPath(projectPath: string): string {
  return canonicalizePath(projectPath);
}
