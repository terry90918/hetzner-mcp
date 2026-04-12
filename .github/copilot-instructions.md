請使用繁體中文回覆所有問題與建議。

# Copilot Instructions for hetzner-mcp

## Project Overview

`@jurislm/hetzner-mcp` is a TypeScript MCP (Model Context Protocol) server that wraps the Hetzner Cloud REST API into tools for AI assistants. Published to npm.

## Git Workflow

- **Development branch**: `develop` — all feature work happens here
- **Release branch**: `main` — receives changes via **squash merge** from `develop`
- **Consequence**: A PR from `develop` to `main` will show a large diff including all accumulated commits since the last squash merge. This does NOT mean those changes are new — they may already be live on npm via a previous release.
- **Versioning**: Managed by [Release Please](https://github.com/googleapis/release-please). Do NOT suggest manual version bumps.

## Build & Run

```bash
npm install           # install dependencies
npm run build         # compile TypeScript → dist/
npm run dev           # tsx watch (hot reload)
npm run lint          # ESLint (max-warnings=0)
```

Required environment variable:

```bash
export HETZNER_API_TOKEN=<token>   # Hetzner Cloud API token (Read & Write)
```

## Tool Categories

This server exposes three groups of tools:

| Category | File | Tools |
|----------|------|-------|
| Reference | `src/tools/reference.ts` | `hetzner_list_server_types`, `hetzner_list_images`, `hetzner_list_locations` |
| Servers | `src/tools/servers.ts` | `hetzner_list_servers`, `hetzner_get_server`, `hetzner_create_server`, `hetzner_delete_server`, `hetzner_power_on_server`, `hetzner_power_off_server`, `hetzner_reboot_server` |
| SSH Keys | `src/tools/ssh-keys.ts` | `hetzner_list_ssh_keys`, `hetzner_get_ssh_key`, `hetzner_create_ssh_key`, `hetzner_delete_ssh_key` |

## Code Patterns

### Response Format

Every tool accepts `response_format: "markdown" | "json"` (default: `"markdown"`). Use the shared `ResponseFormatSchema`:

```typescript
const ResponseFormatSchema = z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN);
```

JSON output returns raw API data; Markdown output formats for human readability.

### Tool Registration

All tools are registered via `registerXxxTools(server: McpServer)` pattern in `src/index.ts`. Never register tools directly in `index.ts`.

### API Calls

Use `makeApiRequest<T>(path, method?, body?, queryParams?)` from `src/api.ts`. On error, return `handleApiError(error)` with `isError: true`.

### Tool Annotations

All tools must include annotations:

```typescript
annotations: {
  readOnlyHint: true,      // GET-only tools
  destructiveHint: false,  // true for delete/power-off
  idempotentHint: true,
  openWorldHint: true
}
```

## Code Review 重點

- 禁止使用 `any` 類型；用 `unknown` 配合 type guard
- 所有工具必須有 `inputSchema` 使用 `.strict()` 防止未知欄位
- 破壞性操作（delete、power off）的 `destructiveHint` 必須設為 `true`
- `HETZNER_API_TOKEN` 只能從 `process.env` 讀取，禁止 hardcode
- `stdout` 保留給 MCP protocol；日誌輸出一律用 `console.error()`

## npm Package

- Published files: `dist/` directory
- Version managed by Release Please — do NOT suggest manual version bumps in PRs
- When reviewing `develop → main` PR, the version diff may already be published

## 忽略範圍

- 不審查 `dist/`、`node_modules/`、`.worktrees/` 目錄
