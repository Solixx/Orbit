# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-04-17

### Added
- Initial public release as **Orbit**.

### Changed
- Rebrand from the private `RemoteCursor` codebase. User-visible strings, PWA manifest, service worker cache name (`orbit-v1`), pino logger `service` field, and Docker Compose service name are now `orbit`.
- `npm` package renamed to `@solixx/orbit`.

### Migration notes
- The service worker cache key changed (`remotecursor-v1` → `orbit-v1`); existing PWA installs will re-cache assets on first load after upgrade.
- Docker users: the compose service is now `orbit` (e.g. `docker compose logs orbit`).
- Log filters keyed on `service=remotecursor` should be updated to `service=orbit`.

## [Unreleased]

### Added
- **Security**: Helmet middleware for secure HTTP headers
- **Security**: CORS configuration
- **Security**: Rate limiting on API and destructive git operations
- **Security**: Zod schema validation on all POST request bodies
- **Security**: Request body size limits (1MB)
- **Security**: Startup warning when AUTH_TOKEN is not set
- **Reliability**: Global Express error handler
- **Reliability**: Graceful shutdown (SIGTERM/SIGINT) with cleanup of WebSocket, child processes, tunnels
- **Reliability**: Unhandled rejection and uncaught exception handlers
- **Reliability**: WebSocket ping/pong heartbeat for stale connection detection
- **Reliability**: Atomic writes for session store (write-then-rename)
- **Observability**: Pino structured JSON logging
- **Observability**: HTTP request logging middleware (pino-http)
- **Observability**: `GET /api/health` endpoint with uptime, memory, and service status
- **Observability**: Cursor CLI execution logging (model, mode, duration, exit code)
- **Frontend**: Extracted CSS to `styles.css` and JS to `app.js` from monolithic `index.html`
- **Frontend**: PWA manifest, service worker, and app icons for Add to Home Screen
- **Frontend**: Toast notifications for non-critical status messages
- **Frontend**: Connection status banner with reconnect countdown
- **Frontend**: Haptic feedback on send/cancel actions (mobile)
- **Frontend**: Keyboard shortcuts: Enter to send, Cmd+Enter to send, Escape to cancel
- **Frontend**: Exponential backoff WebSocket reconnection
- **Testing**: Vitest test framework with 49 tests across 5 suites
- **Testing**: Unit tests for validation schemas, config, session store, auth middleware
- **Testing**: API integration tests with supertest
- **DX**: Biome for linting and formatting
- **DX**: `.nvmrc` and `.editorconfig`
- **DX**: Additional TypeScript strictness (`noUnusedLocals`, `noUnusedParameters`)
- **CI/CD**: GitHub Actions workflow (typecheck, lint, test, build) on Node 18/20/22
- **Deploy**: Dockerfile with multi-stage build
- **Deploy**: docker-compose.yml for quick self-hosted setup
- **Deploy**: `.dockerignore` for efficient builds
- **Deploy**: Response compression (gzip/brotli)
- **Deploy**: Static asset cache headers in production
- **Docs**: CHANGELOG.md
- **Docs**: Complete API reference in README including all git endpoints
