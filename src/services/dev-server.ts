import { type ChildProcess, spawn } from "node:child_process";

interface RunningServer {
  process: ChildProcess;
  command: string;
  cwd: string;
  port: number | null;
  output: string;
}

let activeServer: RunningServer | null = null;

export function getDevServer(): RunningServer | null {
  return activeServer;
}

export function startDevServer(
  cwd: string,
  command = "npm run dev",
): Promise<{ port: number | null; output: string }> {
  return new Promise((resolve) => {
    if (activeServer) {
      stopDevServer();
    }

    if (!command.trim()) {
      resolve({ port: null, output: "Invalid command" });
      return;
    }

    const proc = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const server: RunningServer = {
      process: proc,
      command,
      cwd,
      port: null,
      output: "",
    };
    activeServer = server;

    let resolved = false;
    const resolveOnce = () => {
      if (!resolved) {
        resolved = true;
        resolve({ port: server.port, output: server.output });
      }
    };

    const portRegex = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/;

    const handleData = (data: Buffer) => {
      const text = data.toString();
      server.output += text;
      if (server.output.length > 10_000) {
        server.output = server.output.slice(-5_000);
      }

      if (!server.port) {
        const match = portRegex.exec(text);
        if (match?.[1]) {
          server.port = parseInt(match[1], 10);
        }
      }

      if (server.port && !resolved) {
        resolveOnce();
      }
    };

    proc.stdout?.on("data", handleData);
    proc.stderr?.on("data", handleData);

    proc.on("error", (err) => {
      server.output += `\nProcess error: ${err.message}`;
      resolveOnce();
    });

    proc.on("close", (code) => {
      server.output += `\nProcess exited with code ${code}`;
      if (activeServer === server) activeServer = null;
      resolveOnce();
    });

    // If port isn't detected within 15s, resolve anyway
    setTimeout(resolveOnce, 15_000);
  });
}

export function stopDevServer(): boolean {
  if (!activeServer) return false;
  try {
    activeServer.process.kill("SIGTERM");
  } catch {
    // already dead
  }
  activeServer = null;
  return true;
}
