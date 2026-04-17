import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { augmentPathEnv, resolveAgentSpawn } from "./agent-spawn.js";

type JsonRpcId = number | string;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: unknown };

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export type AcpPermissionDecision = "allow-once" | "allow-always" | "reject-once";

export interface AcpHandlers {
  onChunk?: (chunk: string, accumulated: string) => void;
  onPermissionRequest?: (req: {
    requestId: string;
    title?: string;
    detail?: string;
    raw?: Record<string, unknown>;
    options: AcpPermissionDecision[];
  }) => Promise<AcpPermissionDecision>;
  onAskQuestion?: (req: {
    requestId: string;
    title?: string;
    questions: Array<{
      id: string;
      prompt: string;
      options: Array<{ id: string; label: string }>;
      allowMultiple?: boolean;
    }>;
  }) => Promise<
    | { outcome: "answered"; answers: Array<{ questionId: string; selectedOptionIds: string[] }> }
    | { outcome: "skipped"; reason?: string }
    | { outcome: "cancelled" }
  >;
  onCreatePlan?: (req: {
    requestId: string;
    name?: string;
    overview?: string;
    plan: string;
    todos: Array<{
      id: string;
      content: string;
      status: "pending" | "in_progress" | "completed" | "cancelled";
    }>;
  }) => Promise<
    | { outcome: "accepted"; planUri?: string }
    | { outcome: "rejected"; reason?: string }
    | { outcome: "cancelled" }
  >;
}

export interface AcpRunOptions {
  workspace: string;
  model: string;
  mode?: "agent" | "plan" | "ask";
  chatId?: string;
  prompt: string;
}

export interface AcpRunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

type CursorAskQuestion = {
  id: string;
  prompt: string;
  options: Array<{ id: string; label: string }>;
  allowMultiple?: boolean;
};

function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

function isJsonRpcNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

function isJsonRpcResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return !("method" in msg) && "id" in msg;
}

class JsonRpcClient {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<
    JsonRpcId,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private onRequest?: (req: JsonRpcRequest) => void | Promise<void>;
  private onNotification?: (notif: JsonRpcNotification) => void | Promise<void>;

  constructor(
    proc: ChildProcessWithoutNullStreams,
    onRequest?: (req: JsonRpcRequest) => void | Promise<void>,
    onNotification?: (notif: JsonRpcNotification) => void | Promise<void>,
  ) {
    this.proc = proc;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (data: string) => this.onStdout(data));
  }

  private onStdout(data: string) {
    this.buffer += data;
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch (err) {
        logger.warn({ err, line: line.slice(0, 200) }, "ACP: failed to parse JSON-RPC line");
        continue;
      }

      if (isJsonRpcRequest(msg)) {
        logger.debug({ method: msg.method, id: msg.id }, "ACP ← request");
        void this.onRequest?.(msg);
        continue;
      }

      if (isJsonRpcNotification(msg)) {
        logger.debug({ method: msg.method }, "ACP ← notification");
        void this.onNotification?.(msg);
        continue;
      }

      if (isJsonRpcResponse(msg)) {
        const hasError = "error" in msg;
        logger.debug({ id: msg.id, hasError }, "ACP ← response");
        const waiter = this.pending.get(msg.id);
        if (!waiter) {
          logger.debug(
            { id: msg.id },
            "ACP: response for unknown id (already resolved or unsolicited)",
          );
          continue;
        }
        this.pending.delete(msg.id);
        if (hasError) waiter.reject((msg as { error: unknown }).error);
        else waiter.resolve((msg as { result: unknown }).result);
        continue;
      }

      logger.debug({ keys: Object.keys(msg as object) }, "ACP ← unclassified message");
    }
  }

  send(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    const serialized = JSON.stringify(payload);
    logger.debug({ method, id }, "ACP → request");
    this.proc.stdin.write(`${serialized}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  respond(id: JsonRpcId, result: unknown) {
    const serialized = JSON.stringify({ jsonrpc: "2.0", id, result });
    logger.debug({ id }, "ACP → response");
    this.proc.stdin.write(`${serialized}\n`);
  }

  respondError(id: JsonRpcId, error: unknown) {
    const serialized = JSON.stringify({ jsonrpc: "2.0", id, error });
    logger.debug({ id }, "ACP → error response");
    this.proc.stdin.write(`${serialized}\n`);
  }
}

function spawnAgentAcp(workspace: string): ChildProcessWithoutNullStreams {
  const agentBin = process.env.AGENT_BIN || "agent";
  const env = { ...(process.env as Record<string, string>) } as Record<string, string> & {
    CURSOR_API_KEY?: string;
  };
  if (config.cursor.apiKey) env.CURSOR_API_KEY = config.cursor.apiKey;

  const resolved = resolveAgentSpawn(agentBin, ["acp"]);
  return spawn(resolved.command, resolved.spawnArgs, {
    cwd: workspace,
    env: augmentPathEnv(env),
    stdio: ["pipe", "pipe", "pipe"],
    shell: resolved.shell,
    ...(process.platform === "win32" ? { windowsHide: true } : {}),
  });
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * Extract chunk text from a session/update message params object.
 * Works for both request and notification forms.
 */
function extractChunkText(params: unknown): string | null {
  const p = asRecord(params);
  if (!p) return null;
  const update = asRecord(p.update);
  if (!update) return null;
  const content = asRecord(update.content);
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    content &&
    typeof content.text === "string"
  ) {
    return content.text;
  }
  return null;
}

function parseAskQuestions(v: unknown): CursorAskQuestion[] {
  const out: CursorAskQuestion[] = [];
  const arr = Array.isArray(v) ? v : [];
  for (const item of arr) {
    const o = asRecord(item) as
      | (Record<string, unknown> & {
          id?: unknown;
          prompt?: unknown;
          allowMultiple?: unknown;
          options?: unknown;
        })
      | null;
    if (!o) continue;
    const id = typeof o.id === "string" ? o.id : "";
    const prompt = typeof o.prompt === "string" ? o.prompt : "";
    const allowMultiple = typeof o.allowMultiple === "boolean" ? o.allowMultiple : undefined;
    const optArr = Array.isArray(o.options) ? (o.options as unknown[]) : [];
    const options: Array<{ id: string; label: string }> = [];
    for (const opt of optArr) {
      const oo = asRecord(opt) as
        | (Record<string, unknown> & { id?: unknown; label?: unknown })
        | null;
      if (!oo) continue;
      const oid = typeof oo.id === "string" ? oo.id : "";
      const label = typeof oo.label === "string" ? oo.label : "";
      if (oid) options.push({ id: oid, label });
    }
    if (id && options.length > 0)
      out.push({
        id,
        prompt,
        options,
        ...(allowMultiple !== undefined ? { allowMultiple } : {}),
      });
  }
  return out;
}

function parseTodos(v: unknown): Array<{
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}> {
  const out: Array<{
    id: string;
    content: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
  }> = [];
  const arr = Array.isArray(v) ? v : [];
  for (const item of arr) {
    const o = asRecord(item) as
      | (Record<string, unknown> & { id?: unknown; content?: unknown; status?: unknown })
      | null;
    if (!o) continue;
    const id = typeof o.id === "string" ? o.id : "";
    const content = typeof o.content === "string" ? o.content : "";
    const status = o.status;
    if (
      id &&
      content &&
      (status === "pending" ||
        status === "in_progress" ||
        status === "completed" ||
        status === "cancelled")
    ) {
      out.push({ id, content, status });
    }
  }
  return out;
}

/** The currently running ACP child process, if any. Used by cancelAcpRun(). */
let activeAcpProc: ChildProcessWithoutNullStreams | null = null;

export function isAcpRunning(): boolean {
  return activeAcpProc !== null;
}

export function cancelAcpRun(): boolean {
  if (activeAcpProc) {
    try {
      activeAcpProc.kill("SIGTERM");
    } catch {
      // already dead
    }
    activeAcpProc = null;
    logger.info("Cancelled running ACP prompt");
    return true;
  }
  return false;
}

export async function runCursorAcp(
  options: AcpRunOptions,
  handlers: AcpHandlers,
): Promise<AcpRunResult> {
  const proc = spawnAgentAcp(options.workspace);
  activeAcpProc = proc;
  proc.stderr.setEncoding("utf8");

  let output = "";
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
  }, config.promptTimeoutMs);

  function cleanup() {
    clearTimeout(timeout);
    if (activeAcpProc === proc) activeAcpProc = null;
  }

  proc.stderr.on("data", (data: string) => {
    output += data;
    handlers.onChunk?.(data, output);
  });

  /**
   * Handle session/update (and similar chunk-bearing messages) regardless of whether
   * they arrive as a request (with id) or a notification (without id).
   */
  function handleSessionUpdate(params: unknown, reqId?: JsonRpcId): boolean {
    const chunk = extractChunkText(params);
    if (chunk !== null) {
      output += chunk;
      handlers.onChunk?.(chunk, output);
    }
    if (reqId !== undefined) {
      rpc.respond(reqId, { outcome: { outcome: "ack" } });
    }
    return true;
  }

  const requestHandler = async (req: JsonRpcRequest) => {
    try {
      const params = (asRecord(req.params) ?? {}) as {
        update?: unknown;
        title?: unknown;
        detail?: unknown;
        toolCallId?: unknown;
        questions?: unknown;
        name?: unknown;
        overview?: unknown;
        plan?: unknown;
        todos?: unknown;
      };

      if (req.method === "session/update") {
        handleSessionUpdate(req.params, req.id);
        return;
      }

      if (req.method === "session/request_permission") {
        const requestId = String(req.id);
        const title = typeof params.title === "string" ? params.title : undefined;
        const detail = typeof params.detail === "string" ? params.detail : undefined;
        const raw = asRecord(req.params) ?? undefined;
        const decision =
          (await handlers.onPermissionRequest?.({
            requestId,
            title,
            detail,
            raw,
            options: ["allow-once", "allow-always", "reject-once"],
          })) ?? "reject-once";
        rpc.respond(req.id, { outcome: { outcome: "selected", optionId: decision } });
        return;
      }

      if (req.method === "cursor/ask_question") {
        const toolCallId = typeof params.toolCallId === "string" ? params.toolCallId : undefined;
        const title = typeof params.title === "string" ? params.title : undefined;
        const questions = parseAskQuestions(params.questions);
        const requestId = String(toolCallId ?? req.id ?? randomUUID());
        const outcome = (await handlers.onAskQuestion?.({
          requestId,
          title,
          questions,
        })) ?? { outcome: "cancelled" as const };
        rpc.respond(req.id, { outcome });
        return;
      }

      if (req.method === "cursor/create_plan") {
        const toolCallId = typeof params.toolCallId === "string" ? params.toolCallId : undefined;
        const requestId = String(toolCallId ?? req.id ?? randomUUID());
        const name = typeof params.name === "string" ? params.name : undefined;
        const overview = typeof params.overview === "string" ? params.overview : undefined;
        const plan = typeof params.plan === "string" ? params.plan : "";
        const todos = parseTodos(params.todos);
        const outcome = (await handlers.onCreatePlan?.({
          requestId,
          name,
          overview,
          plan,
          todos,
        })) ?? { outcome: "cancelled" as const };
        rpc.respond(req.id, { outcome });
        return;
      }

      // Unknown request method — acknowledge instead of cancelling to avoid
      // killing the agent's current operation. The agent can proceed normally.
      logger.info(
        { method: req.method, id: req.id },
        "ACP: unknown request method — acknowledging",
      );
      rpc.respond(req.id, { outcome: { outcome: "ack" } });
    } catch (err) {
      logger.error({ err, method: req.method }, "ACP: request handler failed");
      rpc.respondError(req.id, {
        message: "client_error",
        data: String((err as Error)?.message ?? err),
      });
    }
  };

  /**
   * Notifications are one-way messages (no id, no response expected).
   * The Cursor ACP agent may send session/update as a notification in some versions.
   */
  const notificationHandler = (notif: JsonRpcNotification) => {
    if (notif.method === "session/update") {
      handleSessionUpdate(notif.params);
      return;
    }

    // Any notification can carry chunk-like data; try to extract it.
    const chunk = extractChunkText(notif.params);
    if (chunk !== null) {
      output += chunk;
      handlers.onChunk?.(chunk, output);
      return;
    }

    logger.debug({ method: notif.method }, "ACP: unhandled notification (no response needed)");
  };

  const rpc = new JsonRpcClient(proc, requestHandler, notificationHandler);

  let settled = false;

  // Fallback: if the process exits/crashes before session/prompt responds,
  // resolve immediately so we don't hang forever.
  const earlyExit = new Promise<AcpRunResult>((resolve) => {
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      logger.info({ exitCode: code, timedOut }, "ACP process exited (before prompt response)");
      resolve({ output: output.trim(), exitCode: code, timedOut });
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      logger.error({ err }, "ACP process error");
      resolve({
        output: `ACP process error: ${err.message}`,
        exitCode: 1,
        timedOut: false,
      });
    });
  });

  try {
    await rpc.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "orbit", version: "0.1.0" },
    });

    await rpc.send("authenticate", { methodId: "cursor_login" });

    const session = await rpc.send("session/new", { cwd: options.workspace, mcpServers: [] });
    const sessionId = (asRecord(session) as { sessionId?: unknown } | null)?.sessionId;
    const sessionIdStr = typeof sessionId === "string" ? sessionId : undefined;
    if (!sessionIdStr) throw new Error("ACP: session/new did not return sessionId");

    // Race: session/prompt response (normal completion) vs process exit (crash/timeout).
    // The ACP agent is a persistent server — it does NOT exit after a prompt.
    // The RPC response to session/prompt is the real completion signal.
    const promptDone = rpc.send("session/prompt", {
      sessionId: sessionIdStr,
      prompt: [{ type: "text", text: options.prompt }],
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.model ? { model: options.model } : {}),
    });

    await Promise.race([promptDone, earlyExit]);

    if (!settled) {
      settled = true;
      cleanup();
      logger.info("ACP: session/prompt completed successfully");
      // Kill the persistent ACP process since we spawn a fresh one per prompt.
      try {
        proc.kill("SIGTERM");
      } catch {
        // already dead
      }
    }

    return { output: output.trim(), exitCode: 0, timedOut };
  } catch (err) {
    if (settled) {
      // Process already exited — earlyExit resolved, return that.
      return earlyExit;
    }
    settled = true;
    cleanup();
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    return {
      output: output.trim() || `ACP session error: ${(err as Error)?.message ?? String(err)}`,
      exitCode: 1,
      timedOut: false,
    };
  }
}
