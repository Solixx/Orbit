import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import compression from "compression";
import express from "express";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { authMiddleware } from "./middleware/auth.js";
import { apiLimiter, corsMiddleware, helmetMiddleware } from "./middleware/security.js";
import { apiRouter } from "./routes/api.js";
import { attachWebSocket, shutdownWebSocket } from "./routes/ws.js";
import { cancelAllRuns } from "./services/cursor-runner.js";
import { stopDevServer } from "./services/dev-server.js";
import { stopTunnel } from "./services/tunnel-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(helmetMiddleware);
app.use(corsMiddleware);
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === "/api/health" },
  }),
);
app.use(authMiddleware);

app.use(
  express.static(join(__dirname, "public"), {
    maxAge: process.env.NODE_ENV === "production" ? "1d" : 0,
    etag: true,
  }),
);

app.use("/api", apiLimiter, apiRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, "Unhandled error in request pipeline");
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

const server = createServer(app);

attachWebSocket(server);

server.listen(config.port, config.host, () => {
  logger.info(
    { host: config.host, port: config.port },
    `Orbit running at http://${config.host}:${config.port}`,
  );
  if (config.authToken) {
    logger.info("Auth token is set — requests require Authorization header");
  } else {
    logger.warn(
      "No AUTH_TOKEN set — API is accessible without authentication. " +
        "Set AUTH_TOKEN in .env for defense-in-depth.",
    );
  }
});

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down gracefully…");

  shutdownWebSocket();
  cancelAllRuns();
  stopDevServer();
  await stopTunnel();

  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });

  setTimeout(() => {
    logger.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — exiting");
  process.exit(1);
});
