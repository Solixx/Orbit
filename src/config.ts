import "dotenv/config";

export const config = {
  port: Number(process.env.PORT) || 4000,
  host: process.env.HOST ?? "0.0.0.0",
  authToken: process.env.AUTH_TOKEN ?? "",
  ngrok: {
    authtoken: process.env.NGROK_AUTHTOKEN ?? "",
  },
  cursor: {
    apiKey: process.env.CURSOR_API_KEY ?? "",
  },
  projectsDir: process.env.PROJECTS_DIR ?? "",
  promptTimeoutMs: Number(process.env.PROMPT_TIMEOUT_MS) || 300_000,
  llmInactivityWarnMs: Number(process.env.LLM_INACTIVITY_WARN_MS) || 45_000,
  interactiveTimeoutMs: Number(process.env.INTERACTIVE_TIMEOUT_MS) || 120_000,
  disconnectGraceMs: Number(process.env.DISCONNECT_GRACE_MS) || 30_000,
} as const;
