# Contributing to Orbit

Thanks for your interest in contributing! This document covers the setup, conventions, and process.

## Prerequisites

- Node.js 18+ (see `.nvmrc`)
- [Cursor CLI](https://cursor.com) installed for end-to-end testing
- Git

## Setup

```bash
git clone https://github.com/Solixx/Orbit.git
cd Orbit
npm install
cp .env.example .env
npm run dev
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with tsx (hot reload) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm test` | Run all tests once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | TypeScript type checking (no emit) |
| `npm run lint` | Run Biome linter |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run format` | Format code with Biome |

## Code Conventions

- **TypeScript** with strict mode enabled
- **Biome** for linting and formatting (run `npm run lint:fix` before committing)
- **Zod** for request body validation on all POST endpoints
- **Pino** for structured logging (never use `console.log`)
- Express error handling through the global error handler in `src/index.ts`

## Project Structure

```
src/
  index.ts              # Express app setup, middleware, graceful shutdown
  config.ts             # Environment configuration
  lib/
    logger.ts           # Pino logger instance
    validation.ts       # Zod schemas for API validation
  middleware/
    auth.ts             # Bearer token authentication
    security.ts         # Helmet, CORS, rate limiting
  routes/
    api.ts              # REST API endpoints
    ws.ts               # WebSocket server
  services/
    cursor-runner.ts    # Cursor CLI process management
    dev-server.ts       # Dev server lifecycle
    git-runner.ts       # Git operations via execFile
    session-store.ts    # Persistent session state
    tunnel-manager.ts   # ngrok tunnel management
  public/
    index.html          # Single-page app shell
    styles.css          # Extracted CSS
    app.js              # Extracted client-side JavaScript
    manifest.json       # PWA manifest
    sw.js               # Service worker
  __tests__/            # Vitest test files
```

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Run `npm run typecheck && npm run lint && npm test` before pushing
4. Open a PR with a clear description of the change
5. All CI checks must pass before merge

## Adding API Endpoints

1. Add a Zod schema to `src/lib/validation.ts`
2. Add the route to `src/routes/api.ts`
3. Use the `validate()` helper for request body parsing
4. Use `requireProject()` if the endpoint needs an active project
5. Apply `destructiveLimiter` to any destructive operation
6. Add tests to `src/__tests__/api.test.ts`
