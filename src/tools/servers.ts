import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  makeApiRequest,
  handleApiError,
  createPaginatedFetch,
  PAGINATION_HARD_CAP_PAGES,
  PartialFailure
} from "../api.js";
import {
  ResponseFormat,
  ListServersResponse,
  ListServersResponseSchema,
  GetServerResponseSchema,
  CreateServerResponseSchema,
  ServerActionResponseSchema,
  HetznerServer
} from "../types.js";
import { escapeHtml } from "../utils.js";

const ResponseFormatSchema = z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN);
const CLOUD_DEFAULT_PER_PAGE = 25;
const TRUNCATION_NOTE = `> ⚠️ Truncated at ${PAGINATION_HARD_CAP_PAGES} pages — supply explicit \`page\` to fetch more.`;

const paginatedFetch = createPaginatedFetch(makeApiRequest);

function formatServer(server: HetznerServer): string {
  const ipv4 = server.public_net.ipv4?.ip || "N/A";
  const ipv6 = server.public_net.ipv6?.ip || "N/A";

  const lines = [
    `## ${escapeHtml(server.name)} (ID: ${server.id})`,
    `- **Status**: ${server.status}`,
    `- **IPv4**: ${ipv4}`,
    `- **IPv6**: ${ipv6}`,
    `- **Type**: ${server.server_type.name} (${server.server_type.cores} cores, ${server.server_type.memory}GB RAM, ${server.server_type.disk}GB disk)`,
    `- **Location**: ${escapeHtml(server.location.city)}, ${escapeHtml(server.location.country)} (${escapeHtml(server.location.name)})`
  ];

  if (server.image) {
    lines.push(`- **Image**: ${escapeHtml(server.image.name)} (${server.image.os_flavor} ${server.image.os_version})`);
  }

  lines.push(`- **Created**: ${new Date(server.created).toLocaleString()}`);

  if (Object.keys(server.labels).length > 0) {
    lines.push(`- **Labels**: ${Object.entries(server.labels).map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`).join(", ")}`);
  }

  return lines.join("\n");
}

export function registerServerTools(server: McpServer): void {
  // List Servers
  server.registerTool(
    "hetzner_list_servers",
    {
      title: "List Servers",
      description: `List all servers in the project.

By default fetches all pages (cap: ${PAGINATION_HARD_CAP_PAGES} pages × ${CLOUD_DEFAULT_PER_PAGE} per page = ${PAGINATION_HARD_CAP_PAGES * CLOUD_DEFAULT_PER_PAGE} servers).
Supply explicit \`page\` and/or \`per_page\` to fetch a single page.

Returns servers with their:
- Name and ID
- Status (running, off, etc.)
- IP addresses
- Server type (CPU, RAM, disk)
- Location
- Image/OS`,
      inputSchema: z.object({
        page: z.number().int().positive().optional().describe("Page number (1-based). When set, fetches a single page only."),
        per_page: z.number().int().positive().max(50).optional().describe("Items per page (max 50). Default 25."),
        label_selector: z.string().max(256).optional()
          .describe("Filter by label (e.g., 'env=production')"),
        response_format: ResponseFormatSchema.describe("Output format: 'markdown' or 'json'")
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params) => {
      try {
        let servers: HetznerServer[];
        let truncated = false;
        let partialFailure: PartialFailure | undefined;

        const filterParams: Record<string, unknown> = {};
        if (params.label_selector) filterParams.label_selector = params.label_selector;

        if (params.page !== undefined) {
          const data = await makeApiRequest(
            "/servers",
            ListServersResponseSchema,
            "GET",
            undefined,
            { page: params.page, per_page: params.per_page ?? CLOUD_DEFAULT_PER_PAGE, ...filterParams }
          );
          servers = data.servers;
        } else {
          const result = await paginatedFetch<ListServersResponse, HetznerServer>(
            "/servers",
            ListServersResponseSchema,
            (r) => r.servers,
            params.per_page ?? CLOUD_DEFAULT_PER_PAGE,
            filterParams
          );
          servers = result.items;
          truncated = result.truncated;
          partialFailure = result.partialFailure;
        }

        if (params.response_format === ResponseFormat.JSON) {
          return {
            content: [{ type: "text", text: JSON.stringify({ servers, truncated, partialFailure }, null, 2) }]
          };
        }

        if (servers.length === 0 && !partialFailure) {
          return {
            content: [{ type: "text", text: "No servers found. Use `hetzner_create_server` to create one." }]
          };
        }

        const lines = ["# Servers", "", `Found ${servers.length} server(s):`, ""];
        for (const srv of servers) {
          lines.push(formatServer(srv));
          lines.push("");
        }
        if (truncated) {
          lines.push(TRUNCATION_NOTE);
        }
        if (partialFailure) {
          lines.push(`> ⚠️ Partial result: pagination failed after ${partialFailure.pagesSucceeded} page(s) (${partialFailure.kind}): ${partialFailure.message}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true
        };
      }
    }
  );

  // Get Server
  server.registerTool(
    "hetzner_get_server",
    {
      title: "Get Server",
      description: `Get detailed information about a specific server.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The server ID"),
        response_format: ResponseFormatSchema.describe("Output format: 'markdown' or 'json'")
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params) => {
      try {
        const data = await makeApiRequest(`/servers/${params.id}`, GetServerResponseSchema);
        const srv = data.server;

        if (params.response_format === ResponseFormat.JSON) {
          return {
            content: [{ type: "text", text: JSON.stringify(srv, null, 2) }]
          };
        }

        const lines = ["# Server Details", "", formatServer(srv)];
        return {
          content: [{ type: "text", text: lines.join("\n") }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true
        };
      }
    }
  );

  // Create Server
  server.registerTool(
    "hetzner_create_server",
    {
      title: "Create Server",
      description: `Create a new server.

Required parameters:
- name: Server name (letters, digits, hyphens)
- server_type: Instance size (e.g., "cx22", "cpx11"). Use hetzner_list_server_types to see options.
- image: OS image (e.g., "ubuntu-24.04"). Use hetzner_list_images to see options.

Optional parameters:
- location: Datacenter (e.g., "fsn1", "nbg1"). Use hetzner_list_locations to see options.
- ssh_keys: List of SSH key names or IDs for server access
- labels: Key-value labels for organization

Returns the new server details including IP address and root password (if no SSH keys specified).
When using JSON output format, the response includes root_password in plaintext — avoid logging the full JSON output to unprotected storage.`,
      inputSchema: z.object({
        name: z.string().min(1).max(255)
          .regex(/^[a-zA-Z0-9-]+$/, "Name can only contain letters, digits, and hyphens")
          .describe("Server name"),
        server_type: z.string().min(1).regex(/^[a-z0-9-]+$/, "server_type must be a valid slug (lowercase alphanumeric and hyphens)").describe("Server type (e.g., 'cx22', 'cpx11')"),
        image: z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/, "image must be a valid slug (alphanumeric, dots, hyphens)").describe("OS image name or numeric ID (e.g., 'ubuntu-24.04', 'Ubuntu-Hardened-2024', '12345')"),
        location: z.string().regex(/^[a-z0-9-]+$/, "location must be a valid slug (lowercase alphanumeric and hyphens)").optional().describe("Datacenter location (e.g., 'fsn1', 'nbg1')"),
        ssh_keys: z.array(z.union([z.string(), z.number()])).optional()
          .describe("SSH key names or IDs for access"),
        labels: z.record(z.string(), z.string()).optional().describe("Labels as key-value pairs"),
        start_after_create: z.boolean().default(true).describe("Start server after creation"),
        response_format: ResponseFormatSchema.describe("Output format: 'markdown' or 'json'")
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params) => {
      try {
        const requestBody: Record<string, unknown> = {
          name: params.name,
          server_type: params.server_type,
          image: params.image,
          start_after_create: params.start_after_create
        };

        if (params.location) {
          requestBody.location = params.location;
        }
        if (params.ssh_keys && params.ssh_keys.length > 0) {
          requestBody.ssh_keys = params.ssh_keys;
        }
        if (params.labels) {
          requestBody.labels = params.labels;
        }

        const data = await makeApiRequest("/servers", CreateServerResponseSchema, "POST", requestBody);
        const srv = data.server;
        const rootPassword = data.root_password;

        if (params.response_format === ResponseFormat.JSON) {
          return {
            content: [{ type: "text", text: JSON.stringify({ server: srv, root_password: rootPassword }, null, 2) }]
          };
        }

        const lines = [
          "# Server Created",
          "",
          formatServer(srv),
          ""
        ];

        if (rootPassword) {
          lines.push("**Root Password**: `" + rootPassword + "`");
          lines.push("");
          lines.push("⚠️ Save this password! It will not be shown again.");
        } else {
          lines.push("SSH key authentication is configured. No root password was generated.");
        }

        lines.push("");
        lines.push("The server is being provisioned. Use `hetzner_get_server` to check its status.");

        return {
          content: [{ type: "text", text: lines.join("\n") }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true
        };
      }
    }
  );

  // Delete Server
  server.registerTool(
    "hetzner_delete_server",
    {
      title: "Delete Server",
      description: `Delete a server permanently.

⚠️ This action is irreversible. All data on the server will be lost.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The server ID to delete")
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params) => {
      try {
        const data = await makeApiRequest(`/servers/${params.id}`, ServerActionResponseSchema, "DELETE");

        return {
          content: [{
            type: "text",
            text: `Server ${params.id} is being deleted. Action status: ${data.action.status}`
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true
        };
      }
    }
  );

  // Power On Server
  server.registerTool(
    "hetzner_power_on_server",
    {
      title: "Power On Server",
      description: `Power on a server that is currently off.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The server ID")
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params) => {
      try {
        const data = await makeApiRequest(
          `/servers/${params.id}/actions/poweron`,
          ServerActionResponseSchema,
          "POST"
        );

        return {
          content: [{
            type: "text",
            text: `Server ${params.id} is powering on. Action status: ${data.action.status}`
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true
        };
      }
    }
  );

  // Power Off Server
  server.registerTool(
    "hetzner_power_off_server",
    {
      title: "Power Off Server",
      description: `Power off a server (hard shutdown).

This is like pulling the power cord. For a graceful shutdown, SSH into the server and run 'shutdown'.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The server ID")
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params) => {
      try {
        const data = await makeApiRequest(
          `/servers/${params.id}/actions/poweroff`,
          ServerActionResponseSchema,
          "POST"
        );

        return {
          content: [{
            type: "text",
            text: `Server ${params.id} is powering off. Action status: ${data.action.status}`
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true
        };
      }
    }
  );

  // Reboot Server
  server.registerTool(
    "hetzner_reboot_server",
    {
      title: "Reboot Server",
      description: `Reboot a server (hard reset).

This is like pressing the reset button. For a graceful reboot, SSH into the server and run 'reboot'.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The server ID")
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params) => {
      try {
        const data = await makeApiRequest(
          `/servers/${params.id}/actions/reboot`,
          ServerActionResponseSchema,
          "POST"
        );

        return {
          content: [{
            type: "text",
            text: `Server ${params.id} is rebooting. Action status: ${data.action.status}`
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true
        };
      }
    }
  );
}
