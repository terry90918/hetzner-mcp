import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  makeStorageBoxApiRequest,
  handleApiError,
  createPaginatedFetch,
  PAGINATION_HARD_CAP_PAGES,
  PartialFailure
} from "../api.js";
import {
  ResponseFormat,
  ListStorageBoxesResponse,
  ListStorageBoxesResponseSchema,
  GetStorageBoxResponseSchema,
  ListStorageBoxSubaccountsResponse,
  ListStorageBoxSubaccountsResponseSchema,
  ListStorageBoxSnapshotsResponse,
  ListStorageBoxSnapshotsResponseSchema,
  CreateStorageBoxSnapshotResponseSchema,
  RollbackStorageBoxSnapshotResponseSchema,
  StorageBoxActionResponseSchema,
  CreateStorageBoxResponseSchema,
  UpdateStorageBoxResponseSchema,
  ListFoldersResponseSchema,
  CreateSubaccountResponseSchema,
  UpdateSubaccountResponseSchema,
  HetznerStorageBox,
  HetznerStorageBoxSubaccount,
  HetznerStorageBoxSnapshot,
  HetznerAction,
  BooleanKeys
} from "../types.js";
import { escapeHtml, isSafePathSegment } from "../utils.js";

// Shared message for path-segment params that pass the char allowlist but are
// dot-only (".", "..") and could traverse to a parent resource upstream.
const PATH_SEGMENT_TRAVERSAL_MSG =
  "must not be a path-traversal segment ('.', '..', '...')";

const ResponseFormatSchema = z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN);
const DEFAULT_PER_PAGE = 50;

// access_settings protocol keys in display order. Using a tuple instead of
// BooleanKeys<HetznerStorageBox> because protocols are now nested inside
// access_settings (unified API redesign — issue #13).
const STORAGE_BOX_PROTOCOL_KEYS = [
  ["ssh_enabled", "ssh"],
  ["webdav_enabled", "webdav"],
  ["samba_enabled", "samba"],
  ["zfs_enabled", "zfs"]
] as const;

// C-3: constrain to keys whose value type is `boolean` so a typo like "name"
// fails typecheck instead of silently filtering to false at runtime.
const SUBACCOUNT_PROTOCOLS = ["ssh", "webdav", "samba"] as const satisfies readonly BooleanKeys<HetznerStorageBoxSubaccount>[];

export interface StorageBoxStats {
  used_bytes: number;
  used_gib: number;
  total_bytes: number;
  total_gib: number;
  available_gib: number;
  usage_percent: number;
}

// Exported for unit testing.
export function computeStorageBoxStats(box: HetznerStorageBox): StorageBoxStats {
  const used_bytes = box.stats.size; // size = size_data + size_snapshots (total consumed)
  const total_bytes = box.storage_box_type.size;
  const GiB = 1024 ** 3;
  const used_gib = used_bytes / GiB;
  const total_gib = total_bytes / GiB;
  const available_gib = total_gib - used_gib;
  const usage_percent = total_bytes > 0
    ? Math.round((used_bytes / total_bytes) * 10000) / 100
    : 0;
  return { used_bytes, used_gib, total_bytes, total_gib, available_gib, usage_percent };
}

// Exported for unit testing.
export function formatBytes(bytes: number): string {
  const gib = bytes / (1024 ** 3);
  if (gib >= 1) {
    return `${gib.toFixed(1)} GiB`;
  }
  return `${(bytes / (1024 ** 2)).toFixed(0)} MiB`;
}

// Exported for unit testing.
export function formatStorageBox(box: HetznerStorageBox): string {
  const settings = box.access_settings;
  const protocols = STORAGE_BOX_PROTOCOL_KEYS
    .filter(([key]) => settings[key] === true)
    .map(([, label]) => label)
    .join(", ") || "none";
  const totalSize = box.storage_box_type.size;
  const usagePercent = totalSize > 0
    ? Math.round((box.stats.size_data / totalSize) * 100)
    : 0;
  return [
    `## ${escapeHtml(box.name)} (ID: ${box.id})`,
    `- **Username**: ${escapeHtml(box.username)}`,
    `- **Status**: ${box.status}`,
    `- **Type**: ${box.storage_box_type.name}`,
    `- **Location**: ${box.location.name}`,
    `- **Server**: ${box.server ? escapeHtml(box.server) : "—"}`,
    `- **Storage**: ${formatBytes(box.stats.size_data)} used / ${formatBytes(totalSize)} total (~${usagePercent}% used)`,
    `- **Snapshots**: ${formatBytes(box.stats.size_snapshots)}`,
    `- **Protocols**: ${protocols}`,
    `- **External reachability**: ${settings.reachable_externally ? "yes" : "no"}`,
    `- **Delete protected**: ${box.protection.delete ? "yes" : "no"}`
  ].join("\n");
}

// Exported for unit testing.
export function formatSubaccount(sub: HetznerStorageBoxSubaccount): string {
  const protocols = SUBACCOUNT_PROTOCOLS
    .filter((p) => sub[p] === true)
    .join(", ") || "none";

  const lines: string[] = [
    `## ${escapeHtml(sub.username)}`,
    `- **Home directory**: ${escapeHtml(sub.home_directory)}`,
    `- **Protocols**: ${protocols}`,
    `- **External reachability**: ${sub.external_reachability ? "yes" : "no"}`,
    `- **Read-only**: ${sub.readonly ? "yes" : "no"}`
  ];

  if (sub.comment) {
    lines.push(`- **Comment**: ${escapeHtml(sub.comment)}`);
  }

  return lines.join("\n");
}

// Exported for unit testing.
export function formatSnapshot(snap: HetznerStorageBoxSnapshot): string {
  const lines: string[] = [
    `## ${escapeHtml(snap.name)} (ID: ${snap.id})`,
    `- **Created**: ${snap.created.slice(0, 10)}`
  ];
  if (snap.description) {
    lines.push(`- **Description**: ${escapeHtml(snap.description)}`);
  }
  if (snap.stats?.size !== undefined) {
    lines.push(`- **Size**: ${formatBytes(snap.stats.size)}`);
  }
  if (snap.is_automatic !== undefined) {
    lines.push(`- **Automatic**: ${snap.is_automatic ? "yes" : "no"}`);
  }
  if (snap.labels && Object.keys(snap.labels).length > 0) {
    const labelStr = Object.entries(snap.labels)
      .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`)
      .join(", ");
    lines.push(`- **Labels**: ${labelStr}`);
  }
  return lines.join("\n");
}

// Exported for unit testing.
export function formatAction(action: HetznerAction): string {
  const lines: string[] = [
    `- **Action ID**: ${action.id}`,
    `- **Command**: ${action.command}`,
    `- **Status**: ${action.status}`,
    `- **Progress**: ${action.progress}%`
  ];
  if (action.error) {
    lines.push(`- **Error**: ${action.error.code} — ${action.error.message}`);
  }
  return lines.join("\n");
}

// Exported for unit testing. Bound to makeStorageBoxApiRequest via the shared factory.
export const paginatedFetch = createPaginatedFetch(makeStorageBoxApiRequest);

const TRUNCATION_NOTE = `> ⚠️ Truncated at ${PAGINATION_HARD_CAP_PAGES} pages — supply explicit \`page\` to fetch more.`;

export function registerStorageBoxTools(server: McpServer): void {
  // List Storage Boxes
  server.registerTool(
    "hetzner_list_storage_boxes",
    {
      title: "List Storage Boxes",
      description: `List Storage Boxes in the account.

By default fetches all pages (cap: ${PAGINATION_HARD_CAP_PAGES} pages × ${DEFAULT_PER_PAGE} per page = ${PAGINATION_HARD_CAP_PAGES * DEFAULT_PER_PAGE} boxes).
Supply explicit \`page\` and/or \`per_page\` to fetch a single page.

Returns Storage Boxes with their:
- Name, ID, username, and status
- Storage box type and location
- Storage usage and quota
- Enabled protocols (SSH, WebDAV, Samba, ZFS)`,
      inputSchema: z.object({
        page: z.number().int().positive().optional().describe("Page number (1-based). When set, fetches a single page only."),
        per_page: z.number().int().positive().max(50).optional().describe("Items per page (max 50). Default 50."),
        label_selector: z.string().max(256).optional().describe("Filter by label selector (e.g. 'env=prod')"),
        name: z.string().max(255).optional().describe("Filter by exact name"),
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
        let boxes: HetznerStorageBox[];
        let truncated = false;
        let partialFailure: PartialFailure | undefined;

        const filterParams: Record<string, unknown> = {};
        if (params.label_selector) filterParams.label_selector = params.label_selector;
        if (params.name) filterParams.name = params.name;

        if (params.page !== undefined) {
          const data = await makeStorageBoxApiRequest(
            "/storage_boxes",
            ListStorageBoxesResponseSchema,
            "GET",
            undefined,
            { page: params.page, per_page: params.per_page ?? DEFAULT_PER_PAGE, ...filterParams }
          );
          boxes = data.storage_boxes;
        } else {
          const result = await paginatedFetch<ListStorageBoxesResponse, HetznerStorageBox>(
            "/storage_boxes",
            ListStorageBoxesResponseSchema,
            (r) => r.storage_boxes,
            params.per_page ?? DEFAULT_PER_PAGE,
            filterParams
          );
          boxes = result.items;
          truncated = result.truncated;
          partialFailure = result.partialFailure;
        }

        if (params.response_format === ResponseFormat.JSON) {
          return {
            content: [{ type: "text", text: JSON.stringify({ storage_boxes: boxes, truncated, partialFailure }, null, 2) }]
          };
        }

        if (boxes.length === 0 && !partialFailure) {
          return {
            content: [{ type: "text", text: "No Storage Boxes found." }]
          };
        }

        const lines = ["# Storage Boxes", "", `Found ${boxes.length} storage box(es):`, ""];
        for (const box of boxes) {
          lines.push(formatStorageBox(box));
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

  // Get Storage Box
  server.registerTool(
    "hetzner_get_storage_box",
    {
      title: "Get Storage Box",
      description: `Get detailed information about a specific Storage Box.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
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
        const data = await makeStorageBoxApiRequest(`/storage_boxes/${params.id}`, GetStorageBoxResponseSchema);
        const box = data.storage_box;

        if (params.response_format === ResponseFormat.JSON) {
          return {
            content: [{ type: "text", text: JSON.stringify(box, null, 2) }]
          };
        }

        const lines = ["# Storage Box Details", "", formatStorageBox(box)];
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

  // List Storage Box Subaccounts
  server.registerTool(
    "hetzner_list_storage_box_subaccounts",
    {
      title: "List Storage Box Subaccounts",
      description: `List subaccounts for a specific Storage Box.

By default fetches all pages (cap: ${PAGINATION_HARD_CAP_PAGES} pages × ${DEFAULT_PER_PAGE} per page = ${PAGINATION_HARD_CAP_PAGES * DEFAULT_PER_PAGE} subaccounts).
Supply explicit \`page\` and/or \`per_page\` to fetch a single page.

Returns subaccounts with their:
- Username and home directory
- Enabled protocols (SSH, WebDAV, Samba)
- External reachability and read-only status`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        page: z.number().int().positive().optional().describe("Page number (1-based). When set, fetches a single page only."),
        per_page: z.number().int().positive().max(50).optional().describe("Items per page (max 50). Default 50."),
        username: z.string().max(255).regex(/^[a-zA-Z0-9._-]+$/, "username must contain only alphanumeric characters, dots, hyphens, or underscores").optional().describe("Filter by exact subaccount username"),
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
        const endpoint = `/storage_boxes/${params.id}/subaccounts`;
        let subaccounts: HetznerStorageBoxSubaccount[];
        let truncated = false;
        let partialFailure: PartialFailure | undefined;

        const filterParams: Record<string, unknown> = {};
        if (params.username) filterParams.username = params.username;

        if (params.page !== undefined) {
          const data = await makeStorageBoxApiRequest(
            endpoint,
            ListStorageBoxSubaccountsResponseSchema,
            "GET",
            undefined,
            { page: params.page, per_page: params.per_page ?? DEFAULT_PER_PAGE, ...filterParams }
          );
          subaccounts = data.subaccounts;
        } else {
          const result = await paginatedFetch<ListStorageBoxSubaccountsResponse, HetznerStorageBoxSubaccount>(
            endpoint,
            ListStorageBoxSubaccountsResponseSchema,
            (r) => r.subaccounts,
            params.per_page ?? DEFAULT_PER_PAGE,
            filterParams
          );
          subaccounts = result.items;
          truncated = result.truncated;
          partialFailure = result.partialFailure;
        }

        if (params.response_format === ResponseFormat.JSON) {
          return {
            content: [{ type: "text", text: JSON.stringify({ subaccounts, truncated, partialFailure }, null, 2) }]
          };
        }

        if (subaccounts.length === 0 && !partialFailure) {
          return {
            content: [{ type: "text", text: `No subaccounts found for Storage Box ${params.id}.` }]
          };
        }

        const lines = [
          `# Subaccounts for Storage Box ${params.id}`,
          "",
          `Found ${subaccounts.length} subaccount(s):`,
          ""
        ];
        for (const sub of subaccounts) {
          lines.push(formatSubaccount(sub));
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

  // List Storage Box Snapshots
  server.registerTool(
    "hetzner_list_storage_box_snapshots",
    {
      title: "List Storage Box Snapshots",
      description: `List snapshots for a specific Storage Box.

By default fetches all pages (cap: ${PAGINATION_HARD_CAP_PAGES} pages × ${DEFAULT_PER_PAGE} per page = ${PAGINATION_HARD_CAP_PAGES * DEFAULT_PER_PAGE} snapshots).
Supply explicit \`page\` and/or \`per_page\` to fetch a single page.

Returns each snapshot with its id, name, description, created timestamp,
optional size, and whether it was created by the automatic snapshot plan.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        page: z.number().int().positive().optional().describe("Page number (1-based). When set, fetches a single page only."),
        per_page: z.number().int().positive().max(50).optional().describe("Items per page (max 50). Default 50."),
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
        const endpoint = `/storage_boxes/${params.id}/snapshots`;
        let snapshots: HetznerStorageBoxSnapshot[];
        let truncated = false;
        let partialFailure: PartialFailure | undefined;

        if (params.page !== undefined) {
          const data = await makeStorageBoxApiRequest(
            endpoint,
            ListStorageBoxSnapshotsResponseSchema,
            "GET",
            undefined,
            { page: params.page, per_page: params.per_page ?? DEFAULT_PER_PAGE }
          );
          snapshots = data.snapshots;
        } else {
          const result = await paginatedFetch<ListStorageBoxSnapshotsResponse, HetznerStorageBoxSnapshot>(
            endpoint,
            ListStorageBoxSnapshotsResponseSchema,
            (r) => r.snapshots,
            params.per_page ?? DEFAULT_PER_PAGE
          );
          snapshots = result.items;
          truncated = result.truncated;
          partialFailure = result.partialFailure;
        }

        if (params.response_format === ResponseFormat.JSON) {
          return {
            content: [{ type: "text", text: JSON.stringify({ snapshots, truncated, partialFailure }, null, 2) }]
          };
        }

        if (snapshots.length === 0 && !partialFailure) {
          return {
            content: [{ type: "text", text: `No snapshots found for Storage Box ${params.id}.` }]
          };
        }

        const lines = [
          `# Snapshots for Storage Box ${params.id}`,
          "",
          `Found ${snapshots.length} snapshot(s):`,
          ""
        ];
        for (const snap of snapshots) {
          lines.push(formatSnapshot(snap));
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

  // Create Storage Box Snapshot
  server.registerTool(
    "hetzner_create_storage_box_snapshot",
    {
      title: "Create Storage Box Snapshot",
      description: `Trigger an on-demand snapshot for a Storage Box.

Optional \`description\` and \`labels\` are forwarded as the request body.
Returns the new snapshot id and the action envelope (status, progress).`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        description: z.string().optional().describe("Optional human-readable description for the snapshot"),
        labels: z.record(z.string(), z.string()).optional().describe("Optional Hetzner labels (string→string map)"),
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
        const body: Record<string, unknown> = {};
        if (params.description !== undefined) body.description = params.description;
        if (params.labels !== undefined) body.labels = params.labels;

        const data = await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}/snapshots`,
          CreateStorageBoxSnapshotResponseSchema,
          "POST",
          body
        );

        if (params.response_format === ResponseFormat.JSON) {
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
          };
        }

        const lines = [
          `# Snapshot Created for Storage Box ${params.id}`,
          "",
          formatSnapshot(data.snapshot),
          "",
          "## Action",
          formatAction(data.action)
        ];

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

  // Create Storage Box
  server.registerTool(
    "hetzner_create_storage_box",
    {
      title: "Create Storage Box",
      description: `Create a new Storage Box.

⚠️ **This action will incur costs** based on the selected storage box type.

Required parameters:
- storage_box_type: Plan name (e.g., "bx11", "bx20"). Use hetzner_list_server_types for reference.
- location: Datacenter location (e.g., "fsn1", "nbg1", "hel1").
- name: Name for the storage box.
- password: Initial password (min 12 chars, must include uppercase, lowercase, number, and special character).

⚠️ Security: the password parameter is transmitted as plaintext in the MCP protocol. Ensure MCP session logs are access-controlled and do not persist to unprotected storage.

Returns the new Storage Box and an action tracking provisioning.`,
      inputSchema: z.object({
        storage_box_type: z.string().min(1).regex(/^[a-z0-9-]+$/, "storage_box_type must be a valid slug (lowercase alphanumeric and hyphens)").describe("Storage box type name (e.g., 'bx11', 'bx20')"),
        location: z.string().min(1).regex(/^[a-z0-9-]+$/, "location must be a valid slug (lowercase alphanumeric and hyphens)").describe("Location name (e.g., 'fsn1', 'nbg1', 'hel1')"),
        name: z.string().min(1).describe("Name for the storage box"),
        password: z
          .string()
          .min(12)
          .regex(
            /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9])/,
            "Password must include uppercase, lowercase, number, and special character"
          )
          .describe("Initial password (min 12 chars, must include uppercase, lowercase, number, special char)"),
        labels: z.record(z.string(), z.string()).optional().describe("Optional key-value labels"),
        ssh_enabled: z.boolean().optional().describe("Enable SSH access"),
        samba_enabled: z.boolean().optional().describe("Enable Samba access"),
        webdav_enabled: z.boolean().optional().describe("Enable WebDAV access"),
        zfs_enabled: z.boolean().optional().describe("Enable ZFS access"),
        reachable_externally: z.boolean().optional().describe("Allow external network access"),
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
        const body: Record<string, unknown> = {
          storage_box_type: params.storage_box_type,
          location: params.location,
          name: params.name,
          password: params.password
        };
        if (params.labels) body.labels = params.labels;
        const accessSettings: Record<string, boolean> = {};
        if (params.ssh_enabled !== undefined) accessSettings.ssh_enabled = params.ssh_enabled;
        if (params.samba_enabled !== undefined) accessSettings.samba_enabled = params.samba_enabled;
        if (params.webdav_enabled !== undefined) accessSettings.webdav_enabled = params.webdav_enabled;
        if (params.zfs_enabled !== undefined) accessSettings.zfs_enabled = params.zfs_enabled;
        if (params.reachable_externally !== undefined) accessSettings.reachable_externally = params.reachable_externally;
        if (Object.keys(accessSettings).length > 0) body.access_settings = accessSettings;

        const data = await makeStorageBoxApiRequest("/storage_boxes", CreateStorageBoxResponseSchema, "POST", body);

        if (params.response_format === ResponseFormat.JSON) {
          return { content: [{ type: "text", text: JSON.stringify({ storage_box: data.storage_box, action: data.action }, null, 2) }] };
        }

        const lines = [
          "# Storage Box Created",
          "",
          formatStorageBox(data.storage_box),
          "",
          "## Provisioning Action",
          formatAction(data.action)
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // Update Storage Box
  server.registerTool(
    "hetzner_update_storage_box",
    {
      title: "Update Storage Box",
      description: `Update a Storage Box (rename, change labels, or toggle auto-delete).`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        name: z.string().min(1).optional().describe("New name"),
        labels: z.record(z.string(), z.string()).optional().describe("Labels (replaces existing)"),
        autodelete: z.boolean().optional().describe("Auto-delete on contract end"),
        response_format: ResponseFormatSchema.describe("Output format: 'markdown' or 'json'")
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
        const body: Record<string, unknown> = {};
        if (params.name !== undefined) body.name = params.name;
        if (params.labels !== undefined) body.labels = params.labels;
        if (params.autodelete !== undefined) body.autodelete = params.autodelete;

        const data = await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}`,
          UpdateStorageBoxResponseSchema,
          "PUT",
          body
        );

        if (params.response_format === ResponseFormat.JSON) {
          return { content: [{ type: "text", text: JSON.stringify(data.storage_box, null, 2) }] };
        }

        const lines = ["# Storage Box Updated", "", formatStorageBox(data.storage_box)];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // Delete Storage Box
  server.registerTool(
    "hetzner_delete_storage_box",
    {
      title: "Delete Storage Box",
      description: `Delete a Storage Box permanently.

⚠️ DESTRUCTIVE: All data, snapshots, and subaccounts will be permanently deleted.
This action cannot be undone.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID to delete")
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
        const data = await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}`,
          StorageBoxActionResponseSchema,
          "DELETE"
        );
        return {
          content: [{
            type: "text",
            text: `Storage Box ${params.id} is being deleted. Action status: ${data.action.status}`
          }]
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // List Storage Box Folders
  server.registerTool(
    "hetzner_list_storage_box_folders",
    {
      title: "List Storage Box Folders",
      description: `List top-level folders inside a Storage Box.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
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
        const data = await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}/folders`,
          ListFoldersResponseSchema
        );

        if (params.response_format === ResponseFormat.JSON) {
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }

        if (data.folders.length === 0) {
          return { content: [{ type: "text", text: `No folders found in Storage Box ${params.id}.` }] };
        }

        const lines = [
          `# Folders in Storage Box ${params.id}`,
          "",
          ...data.folders.map((f) => `- \`${escapeHtml(f)}\``)
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // Create Storage Box Subaccount
  server.registerTool(
    "hetzner_create_storage_box_subaccount",
    {
      title: "Create Storage Box Subaccount",
      description: `Create a new subaccount for a Storage Box.

The subaccount gets an auto-generated username (e.g., u12345-sub1).
Use access settings to configure which protocols the subaccount can use.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        comment: z.string().optional().describe("Optional comment / label for this subaccount"),
        labels: z.record(z.string(), z.string()).optional().describe("Optional key-value labels"),
        ssh_enabled: z.boolean().optional().describe("Allow SSH access"),
        samba_enabled: z.boolean().optional().describe("Allow Samba access"),
        webdav_enabled: z.boolean().optional().describe("Allow WebDAV access"),
        zfs_enabled: z.boolean().optional().describe("Allow ZFS access"),
        reachable_externally: z.boolean().optional().describe("Allow external network access"),
        readonly: z.boolean().optional().describe("Restrict to read-only access"),
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
        const body: Record<string, unknown> = {};
        if (params.comment !== undefined) body.comment = params.comment;
        if (params.labels !== undefined) body.labels = params.labels;
        const access: Record<string, boolean> = {};
        if (params.ssh_enabled !== undefined) access.ssh_enabled = params.ssh_enabled;
        if (params.samba_enabled !== undefined) access.samba_enabled = params.samba_enabled;
        if (params.webdav_enabled !== undefined) access.webdav_enabled = params.webdav_enabled;
        if (params.zfs_enabled !== undefined) access.zfs_enabled = params.zfs_enabled;
        if (params.reachable_externally !== undefined) access.reachable_externally = params.reachable_externally;
        if (params.readonly !== undefined) access.readonly = params.readonly;
        if (Object.keys(access).length > 0) body.access_settings = access;

        const data = await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}/subaccounts`,
          CreateSubaccountResponseSchema,
          "POST",
          body
        );

        if (params.response_format === ResponseFormat.JSON) {
          return { content: [{ type: "text", text: JSON.stringify(data.subaccount, null, 2) }] };
        }

        const lines = [
          `# Subaccount Created for Storage Box ${params.id}`,
          "",
          formatSubaccount(data.subaccount)
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // Update Storage Box Subaccount
  server.registerTool(
    "hetzner_update_storage_box_subaccount",
    {
      title: "Update Storage Box Subaccount",
      description: `Update access settings or comment for a Storage Box subaccount.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        username: z
          .string()
          .regex(/^[a-zA-Z0-9._-]+$/, "username must contain only alphanumeric characters, dots, underscores, or hyphens")
          .refine(isSafePathSegment, `username ${PATH_SEGMENT_TRAVERSAL_MSG}`)
          .describe("The subaccount username to update"),
        comment: z.string().optional().describe("New comment"),
        labels: z.record(z.string(), z.string()).optional().describe("Labels (replaces existing)"),
        ssh_enabled: z.boolean().optional().describe("Allow SSH access"),
        samba_enabled: z.boolean().optional().describe("Allow Samba access"),
        webdav_enabled: z.boolean().optional().describe("Allow WebDAV access"),
        zfs_enabled: z.boolean().optional().describe("Allow ZFS access"),
        reachable_externally: z.boolean().optional().describe("Allow external network access"),
        readonly: z.boolean().optional().describe("Restrict to read-only access"),
        response_format: ResponseFormatSchema.describe("Output format: 'markdown' or 'json'")
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
        const body: Record<string, unknown> = {};
        if (params.comment !== undefined) body.comment = params.comment;
        if (params.labels !== undefined) body.labels = params.labels;
        const access: Record<string, boolean> = {};
        if (params.ssh_enabled !== undefined) access.ssh_enabled = params.ssh_enabled;
        if (params.samba_enabled !== undefined) access.samba_enabled = params.samba_enabled;
        if (params.webdav_enabled !== undefined) access.webdav_enabled = params.webdav_enabled;
        if (params.zfs_enabled !== undefined) access.zfs_enabled = params.zfs_enabled;
        if (params.reachable_externally !== undefined) access.reachable_externally = params.reachable_externally;
        if (params.readonly !== undefined) access.readonly = params.readonly;
        if (Object.keys(access).length > 0) body.access_settings = access;

        const data = await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}/subaccounts/${params.username}`,
          UpdateSubaccountResponseSchema,
          "PUT",
          body
        );

        if (params.response_format === ResponseFormat.JSON) {
          return { content: [{ type: "text", text: JSON.stringify(data.subaccount, null, 2) }] };
        }

        const lines = [
          `# Subaccount Updated: ${params.username}`,
          "",
          formatSubaccount(data.subaccount)
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // Delete Storage Box Subaccount
  server.registerTool(
    "hetzner_delete_storage_box_subaccount",
    {
      title: "Delete Storage Box Subaccount",
      description: `Delete a subaccount from a Storage Box.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        username: z
          .string()
          .regex(/^[a-zA-Z0-9._-]+$/, "username must contain only alphanumeric characters, dots, underscores, or hyphens")
          .refine(isSafePathSegment, `username ${PATH_SEGMENT_TRAVERSAL_MSG}`)
          .describe("The subaccount username to delete")
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
        await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}/subaccounts/${params.username}`,
          z.unknown(),
          "DELETE"
        );
        return {
          content: [{
            type: "text",
            text: `Subaccount \`${params.username}\` has been deleted from Storage Box ${params.id}.`
          }]
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // Delete Storage Box Snapshot
  server.registerTool(
    "hetzner_delete_storage_box_snapshot",
    {
      title: "Delete Storage Box Snapshot",
      description: `Delete a snapshot from a Storage Box.

⚠️ DESTRUCTIVE: The snapshot will be permanently deleted and cannot be recovered.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        snapshot_id: z
          .string()
          .min(1)
          .regex(
            /^[A-Za-z0-9._:+@-]+$/,
            "snapshot_id must contain only safe characters (alphanumeric, . _ : + @ -)"
          )
          .refine(isSafePathSegment, `snapshot_id ${PATH_SEGMENT_TRAVERSAL_MSG}`)
          .describe("Snapshot name or numeric ID (as string)")
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
        await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}/snapshots/${params.snapshot_id}`,
          z.unknown(),
          "DELETE"
        );
        return {
          content: [{
            type: "text",
            text: `Snapshot \`${params.snapshot_id}\` has been deleted from Storage Box ${params.id}.`
          }]
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // Change Storage Box Protection
  server.registerTool(
    "hetzner_change_storage_box_protection",
    {
      title: "Change Storage Box Protection",
      description: `Enable or disable delete protection for a Storage Box.

When delete protection is enabled, the Storage Box cannot be deleted until protection is removed.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        delete: z.boolean().describe("true to enable delete protection, false to disable")
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
        const data = await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}/actions/change_protection`,
          StorageBoxActionResponseSchema,
          "POST",
          { delete: params.delete }
        );
        const status = params.delete ? "enabled" : "disabled";
        return {
          content: [{
            type: "text",
            text: `Delete protection ${status} for Storage Box ${params.id}. Action status: ${data.action.status}`
          }]
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // Change Storage Box Type
  server.registerTool(
    "hetzner_change_storage_box_type",
    {
      title: "Change Storage Box Type",
      description: `Upgrade or downgrade a Storage Box plan.

⚠️ WARNING: Downgrading to a smaller plan may cause data loss if current usage exceeds the new plan's capacity.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        storage_box_type: z.string().min(1).regex(/^[a-z0-9-]+$/, "storage_box_type must be a valid slug (lowercase alphanumeric and hyphens)").describe("Target plan name (e.g., 'bx11', 'bx20', 'bx60')")
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params) => {
      try {
        const data = await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}/actions/change_type`,
          StorageBoxActionResponseSchema,
          "POST",
          { storage_box_type: params.storage_box_type }
        );
        return {
          content: [{
            type: "text",
            text: `Storage Box ${params.id} is changing to type \`${params.storage_box_type}\`. Action status: ${data.action.status}`
          }]
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // Reset Storage Box Password
  server.registerTool(
    "hetzner_reset_storage_box_password",
    {
      title: "Reset Storage Box Password",
      description: `Reset the password for a Storage Box.

Password policy: minimum 12 characters, must include uppercase, lowercase, number, and special character.

⚠️ Security: the password parameter is transmitted as plaintext in the MCP protocol. Ensure MCP session logs are access-controlled and do not persist to unprotected storage.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        password: z
          .string()
          .min(12)
          .regex(
            /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9])/,
            "Password must include uppercase, lowercase, number, and special character"
          )
          .describe("New password (min 12 chars, must include uppercase, lowercase, number, special char)")
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
        const data = await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}/actions/reset_password`,
          StorageBoxActionResponseSchema,
          "POST",
          { password: params.password }
        );
        return {
          content: [{
            type: "text",
            text: `Password reset for Storage Box ${params.id}. Action status: ${data.action.status}`
          }]
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // Update Storage Box Access Settings
  server.registerTool(
    "hetzner_update_storage_box_access_settings",
    {
      title: "Update Storage Box Access Settings",
      description: `Update protocol access settings for a Storage Box (SSH, Samba, WebDAV, ZFS, external reachability).`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        ssh_enabled: z.boolean().optional().describe("Enable SSH access"),
        samba_enabled: z.boolean().optional().describe("Enable Samba/CIFS access"),
        webdav_enabled: z.boolean().optional().describe("Enable WebDAV access"),
        zfs_enabled: z.boolean().optional().describe("Enable ZFS access"),
        reachable_externally: z.boolean().optional().describe("Allow access from external networks")
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
        const body: Record<string, boolean> = {};
        if (params.ssh_enabled !== undefined) body.ssh_enabled = params.ssh_enabled;
        if (params.samba_enabled !== undefined) body.samba_enabled = params.samba_enabled;
        if (params.webdav_enabled !== undefined) body.webdav_enabled = params.webdav_enabled;
        if (params.zfs_enabled !== undefined) body.zfs_enabled = params.zfs_enabled;
        if (params.reachable_externally !== undefined) body.reachable_externally = params.reachable_externally;

        const data = await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}/actions/update_access_settings`,
          StorageBoxActionResponseSchema,
          "POST",
          body
        );
        return {
          content: [{
            type: "text",
            text: `Access settings updated for Storage Box ${params.id}. Action status: ${data.action.status}`
          }]
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // Enable Snapshot Plan
  server.registerTool(
    "hetzner_enable_storage_box_snapshot_plan",
    {
      title: "Enable Storage Box Snapshot Plan",
      description: `Enable an automatic snapshot schedule for a Storage Box.

Schedule options:
- Daily: set hour (0-23), leave day_of_week and day_of_month as null
- Weekly: set hour and day_of_week (1=Mon, 7=Sun), set day_of_month to null
- Monthly: set hour and day_of_month (1-31), set day_of_week to null`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        hour: z.number().int().min(0).max(23).describe("Hour to run the snapshot (0-23)"),
        minute: z.number().int().min(0).max(59).default(0).describe("Minute to run the snapshot (0-59, default 0)"),
        day_of_week: z.number().int().min(1).max(7).nullable().default(null).describe("Day of week (1=Mon, 7=Sun) or null for daily/monthly"),
        day_of_month: z.number().int().min(1).max(31).nullable().default(null).describe("Day of month (1-31) or null for daily/weekly")
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
        const data = await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}/actions/enable_snapshot_plan`,
          StorageBoxActionResponseSchema,
          "POST",
          {
            minute: params.minute,
            hour: params.hour,
            day_of_week: params.day_of_week,
            day_of_month: params.day_of_month
          }
        );
        return {
          content: [{
            type: "text",
            text: `Snapshot plan enabled for Storage Box ${params.id}. Action status: ${data.action.status}`
          }]
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // Disable Snapshot Plan
  server.registerTool(
    "hetzner_disable_storage_box_snapshot_plan",
    {
      title: "Disable Storage Box Snapshot Plan",
      description: `Disable the automatic snapshot schedule for a Storage Box.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID")
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
        const data = await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}/actions/disable_snapshot_plan`,
          StorageBoxActionResponseSchema,
          "POST",
          {}
        );
        return {
          content: [{
            type: "text",
            text: `Snapshot plan disabled for Storage Box ${params.id}. Action status: ${data.action.status}`
          }]
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
      }
    }
  );

  // Get Storage Box Stats
  server.registerTool(
    "hetzner_get_storage_box_stats",
    {
      title: "Get Storage Box Stats",
      description: `Get storage usage statistics for a specific Storage Box.

Returns:
- used_bytes / used_gib — current data usage
- total_bytes / total_gib — plan capacity
- available_gib — remaining free space
- usage_percent — utilisation as a percentage (2 decimal places)

Useful for dashboards, cron jobs, and pre-flight capacity checks before backup operations.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
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
        const data = await makeStorageBoxApiRequest(`/storage_boxes/${params.id}`, GetStorageBoxResponseSchema);
        const stats = computeStorageBoxStats(data.storage_box);

        if (params.response_format === ResponseFormat.JSON) {
          return {
            content: [{ type: "text", text: JSON.stringify(stats, null, 2) }]
          };
        }

        const lines = [
          `# Storage Box ${params.id} — Usage Stats`,
          "",
          `- **Used**: ${formatBytes(stats.used_bytes)} (${stats.used_gib.toFixed(2)} GiB)`,
          `- **Total**: ${formatBytes(stats.total_bytes)} (${stats.total_gib.toFixed(2)} GiB)`,
          `- **Available**: ${stats.available_gib.toFixed(2)} GiB`,
          `- **Usage**: ${stats.usage_percent.toFixed(2)}%`
        ];
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

  // Assert Storage Box Space
  server.registerTool(
    "hetzner_assert_storage_box_space",
    {
      title: "Assert Storage Box Space",
      description: `Pre-flight space check: assert that a Storage Box has at least \`required_gib\` GiB of available space.

Returns success if space is sufficient, or an error (isError: true) if space is insufficient.
Designed for use in cron jobs and backup pipelines before executing storage-intensive operations.`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        required_gib: z.number().positive().describe("Minimum required free space in GiB")
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
        const data = await makeStorageBoxApiRequest(`/storage_boxes/${params.id}`, GetStorageBoxResponseSchema);
        const stats = computeStorageBoxStats(data.storage_box);

        if (stats.available_gib >= params.required_gib) {
          return {
            content: [{
              type: "text",
              text: `✓ Storage Box ${params.id} has sufficient space: ${stats.available_gib.toFixed(2)} GiB available (required: ${params.required_gib} GiB, usage: ${stats.usage_percent.toFixed(2)}%).`
            }]
          };
        }

        return {
          content: [{
            type: "text",
            text: `✗ Storage Box ${params.id} has insufficient space: ${stats.available_gib.toFixed(2)} GiB available but ${params.required_gib} GiB required (usage: ${stats.usage_percent.toFixed(2)}%, total: ${stats.total_gib.toFixed(2)} GiB).`
          }],
          isError: true
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true
        };
      }
    }
  );

  // Rollback Storage Box Snapshot
  server.registerTool(
    "hetzner_rollback_storage_box_snapshot",
    {
      title: "Rollback Storage Box Snapshot",
      description: `Roll a Storage Box back to a previous snapshot.

⚠️ DESTRUCTIVE: this overwrites the current state of the Storage Box.
Any data written after the snapshot was taken will be lost.

The \`snapshot\` parameter accepts the snapshot's name OR its numeric id.
(The legacy \`snapshot_id\` API field has been deprecated by Hetzner;
this tool uses the replacement \`snapshot\` field.)`,
      inputSchema: z.object({
        id: z.number().int().positive().describe("The Storage Box ID"),
        snapshot: z
          .string()
          .min(1)
          .regex(
            /^[A-Za-z0-9._:+@-]+$/,
            "snapshot must contain only safe characters (alphanumeric, . _ : + @ -)"
          )
          .describe("Snapshot name or numeric ID (as string) to roll back to"),
        response_format: ResponseFormatSchema.describe("Output format: 'markdown' or 'json'")
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params) => {
      try {
        const data = await makeStorageBoxApiRequest(
          `/storage_boxes/${params.id}/actions/rollback_snapshot`,
          RollbackStorageBoxSnapshotResponseSchema,
          "POST",
          { snapshot: params.snapshot }
        );

        if (params.response_format === ResponseFormat.JSON) {
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
          };
        }

        const lines = [
          `# Rollback Triggered for Storage Box ${params.id}`,
          "",
          `Rolling back to snapshot: \`${params.snapshot}\``,
          "",
          "## Action",
          formatAction(data.action)
        ];

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
}
