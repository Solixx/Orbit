import { type ChildProcess, spawn } from "node:child_process";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { cancelAcpRun, isAcpRunning } from "./acp-runner.js";
import { augmentPathEnv, resolveAgentSpawn } from "./agent-spawn.js";

export interface CursorRunOptions {
  prompt: string;
  workspace: string;
  model: string;
  mode?: "agent" | "plan" | "ask";
  force?: boolean;
  chatId?: string;
}

export interface CursorRunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

type ProgressCallback = (chunk: string, accumulated: string) => void;

const activeProcesses = new Map<string, ChildProcess>();

export function isRunning(userId: string): boolean {
  return activeProcesses.has(userId) || isAcpRunning();
}

export function cancelRun(userId: string): boolean {
  // Try legacy runner first, then ACP runner.
  const proc = activeProcesses.get(userId);
  if (proc) {
    proc.kill("SIGTERM");
    activeProcesses.delete(userId);
    logger.info({ userId }, "Cancelled running prompt");
    return true;
  }
  return cancelAcpRun();
}

export function cancelAllRuns(): void {
  for (const [userId, proc] of activeProcesses) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already dead
    }
    logger.info({ userId }, "Cancelled run during shutdown");
  }
  activeProcesses.clear();
  cancelAcpRun();
}

export async function runCursor(
  userId: string,
  options: CursorRunOptions,
  onProgress?: ProgressCallback,
): Promise<CursorRunResult> {
  if (activeProcesses.has(userId)) {
    return {
      output: "A prompt is already running. Wait for it to finish or use /cancel.",
      exitCode: null,
      timedOut: false,
    };
  }

  const args = buildArgs(options);
  const env = { ...(process.env as Record<string, string>) } as Record<string, string> & {
    CURSOR_API_KEY?: string;
  };
  if (config.cursor.apiKey) {
    env.CURSOR_API_KEY = config.cursor.apiKey;
  }

  const agentBin = process.env.AGENT_BIN || "agent";
  const resolved = resolveAgentSpawn(agentBin, args);
  logger.info(
    { command: resolved.command, model: options.model, mode: options.mode },
    "Spawning Cursor CLI",
  );

  return new Promise<CursorRunResult>((resolve) => {
    const startTs = Date.now();
    const proc = spawn(resolved.command, resolved.spawnArgs, {
      cwd: options.workspace,
      env: augmentPathEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
      shell: resolved.shell,
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    });

    activeProcesses.set(userId, proc);

    let output = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, config.promptTimeoutMs);

    proc.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      output += chunk;
      onProgress?.(chunk, output);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      output += chunk;
      onProgress?.(chunk, output);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      activeProcesses.delete(userId);
      const durationMs = Date.now() - startTs;
      logger.info({ userId, exitCode: code, timedOut, durationMs }, "Cursor CLI finished");
      resolve({ output: output.trim(), exitCode: code, timedOut });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      activeProcesses.delete(userId);
      logger.error({ err, userId }, "Failed to start Cursor CLI");
      resolve({
        output: `Failed to start Cursor CLI: ${err.message}`,
        exitCode: 1,
        timedOut: false,
      });
    });
  });
}

export async function createChat(workspace: string): Promise<string> {
  const agentBin = process.env.AGENT_BIN || "agent";
  const resolved = resolveAgentSpawn(agentBin, ["create-chat"]);

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(resolved.command, resolved.spawnArgs, {
      cwd: workspace,
      env: augmentPathEnv({ ...(process.env as Record<string, string>) }),
      stdio: ["ignore", "pipe", "pipe"],
      shell: resolved.shell,
    });

    let stdout = "";
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("create-chat timed out"));
    }, 10_000);

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      const match = stdout.match(/^([0-9a-f-]{36})/m);
      const chatId = match?.[1];
      if (chatId) {
        clearTimeout(timeout);
        proc.kill("SIGTERM");
        logger.info({ chatId }, "Created new Cursor chat");
        resolve(chatId);
      }
    });

    proc.on("close", () => {
      clearTimeout(timeout);
      const match = stdout.trim().match(/^([0-9a-f-]{36})/m);
      const chatId = match?.[1];
      if (chatId) {
        resolve(chatId);
      } else {
        reject(new Error(`create-chat returned unexpected output: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function buildArgs(options: CursorRunOptions): string[] {
  const args: string[] = [
    "-p",
    "--trust",
    "--workspace",
    options.workspace,
    "--model",
    options.model,
  ];

  if (options.chatId) {
    args.push("--resume", options.chatId);
  }

  if (options.mode === "plan" || options.mode === "ask") {
    args.push("--mode", options.mode);
  }

  const useForce = options.force ?? (options.mode !== "plan" && options.mode !== "ask");
  if (useForce) {
    args.push("--force");
  }

  args.push(options.prompt);

  return args;
}
