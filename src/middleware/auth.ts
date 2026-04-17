import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.authToken) {
    next();
    return;
  }

  // Allow static file requests (the frontend) through without auth
  if (!req.path.startsWith("/api")) {
    next();
    return;
  }

  const header = req.headers.authorization;
  if (header === `Bearer ${config.authToken}`) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

export function validateWsToken(token: string | undefined): boolean {
  if (!config.authToken) return true;
  return token === config.authToken;
}
