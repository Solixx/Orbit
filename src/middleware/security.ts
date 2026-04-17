import cors from "cors";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

export const corsMiddleware = cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

export const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

export const destructiveLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many destructive operations, slow down" },
});
