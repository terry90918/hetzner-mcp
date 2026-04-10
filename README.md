# @jurislm/hetzner-mcp

MCP (Model Context Protocol) server for [Hetzner Cloud](https://www.hetzner.com/cloud) — provides 14 tools for server management (create, power control, SSH keys) via natural language.

## Tools

### Servers (7 tools)
- `hetzner_list_servers` — List all servers in the project
- `hetzner_get_server` — Get details of a single server (IP, status, specs)
- `hetzner_create_server` — Create a new server (charges apply)
- `hetzner_delete_server` — Permanently delete a server
- `hetzner_power_on_server` — Power on a stopped server
- `hetzner_power_off_server` — Hard power off a server
- `hetzner_reboot_server` — Hard reboot a server

### SSH Keys (4 tools)
- `hetzner_list_ssh_keys` — List all SSH keys in the project
- `hetzner_get_ssh_key` — Get details of a single SSH key
- `hetzner_create_ssh_key` — Add a new SSH public key
- `hetzner_delete_ssh_key` — Remove an SSH key

### Reference (3 tools)
- `hetzner_list_server_types` — List available server sizes and pricing
- `hetzner_list_images` — List available OS images
- `hetzner_list_locations` — List available datacenters

## Setup

### Environment Variables

```bash
HETZNER_API_TOKEN=your-api-token  # Read & Write token from Hetzner Cloud Console
```

Generate a token: [Hetzner Cloud Console](https://console.hetzner.cloud/projects) → Project → Security → API Tokens → Generate API Token (Read & Write)

### Usage with Claude Code (via npx)

Add to your MCP configuration (`.mcp.json` or `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "hetzner": {
      "command": "bunx",
      "args": ["@jurislm/hetzner-mcp@latest"],
      "env": {
        "HETZNER_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### Usage with Claude Code Plugin (jurislm-tools)

If you use the [jurislm-tools](https://github.com/jurislm/jurislm-tools) Claude Code plugin, `jt:hetzner` is included:

```
/plugin marketplace update jurislm-tools
```

Then set environment variables in `~/.zshenv`:

```bash
export HETZNER_API_TOKEN=your-api-token
```

## Development

```bash
npm install
npm run build      # Compile TypeScript to dist/
npm run dev        # Watch mode (tsx watch)
npm run lint       # ESLint (max-warnings=0)
```

## License

MIT
