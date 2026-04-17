import { beforeEach, describe, expect, it, vi } from "vitest";

describe("config", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses default port when PORT env is not set", async () => {
    vi.stubEnv("PORT", "");
    const { config } = await import("../config.js");
    expect(config.port).toBe(4000);
  });

  it("uses default host when HOST env is not set", async () => {
    vi.stubEnv("HOST", "");
    const { config } = await import("../config.js");
    expect(config.host).toBe("0.0.0.0");
  });

  it("uses default prompt timeout", async () => {
    vi.stubEnv("PROMPT_TIMEOUT_MS", "");
    const { config } = await import("../config.js");
    expect(config.promptTimeoutMs).toBe(300_000);
  });
});
