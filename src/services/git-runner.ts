import { execFile } from "node:child_process";

interface GitResult {
  stdout: string;
  stderr: string;
}

function gitRaw(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr.trim() || stdout.trim() || err.message;
        reject(new Error(msg));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await gitRaw(args, cwd);
  return stdout;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface GitFileEntry {
  path: string;
  status: string; // M, A, D, R, ?, U
}

export interface GitStatus {
  branch: string;
  remote: string | null;
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
}

export interface GitCommitInfo {
  hash: string;
  short: string;
  message: string;
  author: string;
  date: string;
}

// ── Status ───────────────────────────────────────────────────────────────────

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const raw = await git(["status", "--porcelain=v1", "-b", "--ahead-behind"], cwd);
  const lines = raw.split("\n").filter(Boolean);

  let branch = "";
  let remote: string | null = null;
  let ahead = 0;
  let behind = 0;
  const staged: GitFileEntry[] = [];
  const unstaged: GitFileEntry[] = [];
  const untracked: GitFileEntry[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const branchLine = line.slice(3);
      const dotDot = branchLine.indexOf("...");
      branch = dotDot >= 0 ? branchLine.slice(0, dotDot) : (branchLine.split(" ")[0] ?? "");

      if (dotDot >= 0) {
        const afterDots = branchLine.slice(dotDot + 3);
        remote = afterDots.split(/\s/)[0] ?? null;
      }

      const aheadMatch = /ahead (\d+)/.exec(branchLine);
      const behindMatch = /behind (\d+)/.exec(branchLine);
      if (aheadMatch?.[1]) ahead = parseInt(aheadMatch[1], 10);
      if (behindMatch?.[1]) behind = parseInt(behindMatch[1], 10);
      continue;
    }

    const x = line[0]; // index (staged) status
    const y = line[1]; // worktree (unstaged) status
    let filePath = line.slice(3);

    // Renamed files show as "old -> new"
    const renameIdx = filePath.indexOf(" -> ");
    if (renameIdx >= 0) filePath = filePath.slice(renameIdx + 4);

    if (x === "?" && y === "?") {
      untracked.push({ path: filePath, status: "?" });
    } else {
      if (x && x !== " " && x !== "?") {
        staged.push({ path: filePath, status: x });
      }
      if (y && y !== " " && y !== "?") {
        unstaged.push({ path: filePath, status: y });
      }
    }
  }

  return { branch, remote, ahead, behind, staged, unstaged, untracked };
}

// ── Diff ─────────────────────────────────────────────────────────────────────

export async function gitDiff(cwd: string, file?: string, staged?: boolean): Promise<string> {
  const args = ["diff"];
  if (staged) args.push("--cached");
  if (file) args.push("--", file);
  return git(args, cwd);
}

export async function gitShowNewFile(cwd: string, file: string): Promise<string> {
  try {
    const { stdout } = await gitRaw(["diff", "--no-index", "--", "/dev/null", file], cwd);
    return stdout;
  } catch (err) {
    if (err instanceof Error && err.message) {
      const msg = err.message;
      if (msg.includes("diff --git") || msg.includes("@@")) {
        return msg;
      }
    }
    throw err;
  }
}

// ── Stage / Unstage ──────────────────────────────────────────────────────────

export async function gitStage(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await git(["add", "--", ...files], cwd);
}

export async function gitUnstage(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await git(["restore", "--staged", "--", ...files], cwd);
}

// ── Commit ───────────────────────────────────────────────────────────────────

export async function gitCommit(
  cwd: string,
  message: string,
): Promise<{ hash: string; summary: string }> {
  const out = await git(["commit", "-m", message], cwd);
  const hashMatch = /\[[\w/.-]+ ([a-f0-9]+)\]/.exec(out);
  return {
    hash: hashMatch?.[1] ?? "",
    summary: out.split("\n")[0] ?? "",
  };
}

// ── Branches ─────────────────────────────────────────────────────────────────

export interface GitBranch {
  name: string;
  current: boolean;
}

export async function gitBranches(cwd: string): Promise<GitBranch[]> {
  const raw = await git(["branch", "--list", "--no-color"], cwd);
  return raw
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.includes("HEAD detached"))
    .map((line) => {
      const current = line.startsWith("* ");
      const name = line.replace(/^\*?\s+/, "").trim();
      return { name, current };
    });
}

export async function gitCheckout(cwd: string, branch: string): Promise<string> {
  const { stdout, stderr } = await gitRaw(["checkout", branch], cwd);
  return stderr.trim() || stdout.trim();
}

export async function gitCreateBranch(
  cwd: string,
  name: string,
  startPoint?: string,
): Promise<string> {
  const args = ["checkout", "-b", name];
  if (startPoint) args.push(startPoint);
  const { stdout, stderr } = await gitRaw(args, cwd);
  return stderr.trim() || stdout.trim();
}

export async function gitMerge(
  cwd: string,
  branch: string,
): Promise<{ success: boolean; output: string }> {
  try {
    const out = await git(["merge", branch], cwd);
    return { success: true, output: out.trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isConflict = msg.includes("CONFLICT") || msg.includes("Automatic merge failed");
    if (isConflict) {
      return { success: false, output: msg };
    }
    throw err;
  }
}

export async function gitMergeAbort(cwd: string): Promise<void> {
  await git(["merge", "--abort"], cwd);
}

// ── Discard (restore unstaged changes) ───────────────────────────────────────

export async function gitDiscard(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await git(["checkout", "--", ...files], cwd);
}

export async function gitDiscardAll(cwd: string): Promise<void> {
  await git(["checkout", "--", "."], cwd);
}

// ── Reset (undo commits) ────────────────────────────────────────────────────

export type ResetMode = "soft" | "mixed" | "hard";

export async function gitReset(cwd: string, mode: ResetMode, target = "HEAD~1"): Promise<string> {
  const { stdout, stderr } = await gitRaw(["reset", `--${mode}`, target], cwd);
  return stderr.trim() || stdout.trim();
}

// ── Delete branch ───────────────────────────────────────────────────────────

export async function gitDeleteBranch(cwd: string, name: string, force = false): Promise<string> {
  const flag = force ? "-D" : "-d";
  const { stdout, stderr } = await gitRaw(["branch", flag, name], cwd);
  return stderr.trim() || stdout.trim();
}

// ── Stash ────────────────────────────────────────────────────────────────────

export interface GitStashEntry {
  index: number;
  message: string;
}

export async function gitStash(cwd: string, message?: string): Promise<string> {
  const args = ["stash", "push"];
  if (message) args.push("-m", message);
  const { stdout, stderr } = await gitRaw(args, cwd);
  return stdout.trim() || stderr.trim();
}

export async function gitStashPop(cwd: string, index = 0): Promise<string> {
  const { stdout, stderr } = await gitRaw(["stash", "pop", `stash@{${index}}`], cwd);
  return stdout.trim() || stderr.trim();
}

export async function gitStashList(cwd: string): Promise<GitStashEntry[]> {
  const raw = await git(["stash", "list", "--format=%gd|%s"], cwd);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const pipeIdx = line.indexOf("|");
      const ref = pipeIdx >= 0 ? line.slice(0, pipeIdx) : line;
      const message = pipeIdx >= 0 ? line.slice(pipeIdx + 1) : "";
      const idxMatch = /\{(\d+)\}/.exec(ref);
      return {
        index: idxMatch?.[1] ? parseInt(idxMatch[1], 10) : 0,
        message,
      };
    });
}

export async function gitStashDrop(cwd: string, index = 0): Promise<void> {
  await git(["stash", "drop", `stash@{${index}}`], cwd);
}

// ── Push / Fetch ─────────────────────────────────────────────────────────────

export async function gitPush(
  cwd: string,
  force = false,
): Promise<{ success: boolean; output: string }> {
  try {
    const args = ["push"];
    if (force) args.push("--force-with-lease");
    const { stdout, stderr } = await gitRaw(args, cwd);
    return { success: true, output: stderr.trim() || stdout.trim() || "Pushed successfully" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const needsUpstream = msg.includes("no upstream") || msg.includes("--set-upstream");
    if (needsUpstream) {
      try {
        const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
        const { stdout, stderr } = await gitRaw(["push", "-u", "origin", branch], cwd);
        return {
          success: true,
          output: stderr.trim() || stdout.trim() || "Pushed and set upstream",
        };
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        return { success: false, output: retryMsg };
      }
    }
    return { success: false, output: msg };
  }
}

export async function gitFetch(cwd: string): Promise<string> {
  const { stdout, stderr } = await gitRaw(["fetch", "--all", "--prune"], cwd);
  return stderr.trim() || stdout.trim() || "Fetched";
}

// ── Log ──────────────────────────────────────────────────────────────────────

export async function gitLog(cwd: string, count = 20): Promise<GitCommitInfo[]> {
  const SEP = "\x1f";
  const fmt = [`%H`, `%h`, `%s`, `%an`, `%ar`].join(SEP);
  const raw = await git(["log", `--format=${fmt}`, `-n`, String(count)], cwd);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(SEP);
      return {
        hash: parts[0] ?? "",
        short: parts[1] ?? "",
        message: parts[2] ?? "",
        author: parts[3] ?? "",
        date: parts[4] ?? "",
      };
    });
}
