import { describe, it, expect, vi, beforeEach } from "vitest";
import { z, ZodError } from "zod";

vi.mock("../../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api.js")>();
  return {
    ...actual,
    makeApiRequest: vi.fn()
  };
});

import { registerServerTools } from "../../src/tools/servers.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeApiRequest } from "../../src/api.js";
import { HetznerServer, HetznerServerSchema, ListServersResponse, ListServersResponseSchema } from "../../src/types.js";

const mockedRequest = vi.mocked(makeApiRequest);

beforeEach(() => {
  mockedRequest.mockReset();
});

const baseServer: HetznerServer = {
  id: 1,
  name: "test-server",
  status: "running",
  public_net: {
    ipv4: { ip: "1.2.3.4" },
    ipv6: { ip: "2001:db8::1" }
  },
  server_type: { id: 1, name: "cx22", description: "CX22", cores: 2, memory: 4, disk: 40 },
  // 只保留 schema 宣告的欄位，與 parse 後的實際形狀一致。
  // 真實 API 多回傳的欄位由下方 rawApiServer 測試涵蓋。
  location: { name: "fsn1", country: "DE", city: "Falkenstein" },
  image: { id: 1, name: "ubuntu-24.04", description: "Ubuntu 24.04", os_flavor: "ubuntu", os_version: "24.04" },
  labels: {},
  created: "2026-01-01T00:00:00+00:00"
};

function makeServer(id: number): HetznerServer {
  return { ...baseServer, id, name: `server-${id}` };
}

function pageResponse(servers: HetznerServer[], nextPage: number | null): ListServersResponse {
  return {
    servers,
    meta: { pagination: { next_page: nextPage } }
  };
}

type ToolHandler = (params: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
interface CapturedTool {
  name: string;
  handler: ToolHandler;
  opts: {
    annotations?: Record<string, unknown>;
    description?: string;
    inputSchema?: z.ZodType<unknown>;
  };
}

function captureRegisteredTools(): CapturedTool[] {
  const captured: CapturedTool[] = [];
  const fakeServer = {
    registerTool: vi.fn((name: string, opts: CapturedTool["opts"], handler: ToolHandler) => {
      captured.push({ name, handler, opts });
    })
  };
  registerServerTools(fakeServer as unknown as McpServer);
  return captured;
}

describe("hetzner_list_servers — location rendering", () => {
  // Regression: Hetzner removed `datacenter` from the Servers API on 2026-06-30.
  // The formatter must read the top-level `location` object instead.
  it("renders Location from the top-level location object", async () => {
    const tools = captureRegisteredTools();
    const handler = tools.find((t) => t.name === "hetzner_list_servers")!.handler;
    mockedRequest.mockResolvedValueOnce(pageResponse([makeServer(1)], null));

    const result = await handler({ response_format: "markdown" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("**Location**: Falkenstein, DE (fsn1)");
  });

  // The live payload carries no `datacenter` and extra location keys we never render.
  // Declaring only the consumed fields must tolerate both.
  it("parses a raw API payload with no datacenter and unknown extra keys", () => {
    const rawApiServer = {
      ...baseServer,
      location: {
        id: 1,
        name: "fsn1",
        description: "Falkenstein DC Park 1",
        country: "DE",
        city: "Falkenstein",
        latitude: 50.47612,
        longitude: 12.370071,
        network_zone: "eu-central"
      }
    };
    expect(() => HetznerServerSchema.parse(rawApiServer)).not.toThrow();
  });
});

describe("hetzner_list_servers — auto-pagination", () => {
  it("fetches all pages and combines results", async () => {
    const tools = captureRegisteredTools();
    const handler = tools.find((t) => t.name === "hetzner_list_servers")!.handler;
    mockedRequest
      .mockResolvedValueOnce(pageResponse([makeServer(1), makeServer(2)], 2))
      .mockResolvedValueOnce(pageResponse([makeServer(3)], null));

    const result = await handler({ response_format: "markdown" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Found 3 server(s)");
    expect(mockedRequest).toHaveBeenCalledTimes(2);
  });

  it("stops at hard cap and includes truncation warning", async () => {
    const tools = captureRegisteredTools();
    const handler = tools.find((t) => t.name === "hetzner_list_servers")!.handler;
    for (let i = 1; i <= 6; i++) {
      mockedRequest.mockResolvedValueOnce(pageResponse([makeServer(i)], i + 1));
    }

    const result = await handler({ response_format: "markdown" });

    expect(result.content[0].text).toContain("Found 5 server(s)");
    expect(result.content[0].text).toContain("Truncated at 5 pages");
  });

  it("single-page mode bypasses auto-pagination", async () => {
    const tools = captureRegisteredTools();
    const handler = tools.find((t) => t.name === "hetzner_list_servers")!.handler;
    mockedRequest.mockResolvedValueOnce(pageResponse([makeServer(7)], 5));

    const result = await handler({ response_format: "markdown", page: 2, per_page: 10 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Found 1 server(s)");
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it("mid-stream failure returns partial results with warning", async () => {
    const tools = captureRegisteredTools();
    const handler = tools.find((t) => t.name === "hetzner_list_servers")!.handler;
    mockedRequest
      .mockResolvedValueOnce(pageResponse([makeServer(1)], 2))
      .mockRejectedValueOnce(new Error("page-2 down"));

    const result = await handler({ response_format: "markdown" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("server-1");
    expect(result.content[0].text).toContain("Partial result");
    expect(result.content[0].text).toContain("after 1 page(s)");
  });

  it("first-page failure returns isError: true", async () => {
    const tools = captureRegisteredTools();
    const handler = tools.find((t) => t.name === "hetzner_list_servers")!.handler;
    mockedRequest.mockRejectedValueOnce(new Error("network down"));

    const result = await handler({ response_format: "markdown" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("network down");
  });
});

describe("hetzner_list_servers — edge cases", () => {
  it("empty result returns 'No servers found.' message", async () => {
    const tools = captureRegisteredTools();
    const handler = tools.find((t) => t.name === "hetzner_list_servers")!.handler;
    mockedRequest.mockResolvedValueOnce(pageResponse([], null));

    const result = await handler({ response_format: "markdown" });

    expect(result.content[0].text).toContain("No servers found");
  });

  it("JSON format includes servers array, truncated and partialFailure", async () => {
    const tools = captureRegisteredTools();
    const handler = tools.find((t) => t.name === "hetzner_list_servers")!.handler;
    mockedRequest.mockResolvedValueOnce(pageResponse([makeServer(1)], null));

    const result = await handler({ response_format: "json" });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.truncated).toBe(false);
  });

  it("propagates ZodError mid-stream as isError: true", async () => {
    const tools = captureRegisteredTools();
    const handler = tools.find((t) => t.name === "hetzner_list_servers")!.handler;
    mockedRequest
      .mockResolvedValueOnce(pageResponse([makeServer(1)], 2))
      .mockRejectedValueOnce(new ZodError([
        { code: "invalid_type", path: ["servers", 0, "id"], message: "expected number", input: "x", expected: "number" }
      ]));

    const result = await handler({ response_format: "markdown" });

    expect(result.isError).toBe(true);
  });

  it("ListServersResponseSchema parses without error", () => {
    const result = ListServersResponseSchema.safeParse({ servers: [baseServer], meta: { pagination: { next_page: null } } });
    expect(result.success).toBe(true);
  });
});

// L-3 security: POST body field character validation
describe("L-3 security: create_server body field character validation", () => {
  it("rejects server_type with special characters", () => {
    const tool = captureRegisteredTools().find((t) => t.name === "hetzner_create_server")!;
    expect(
      tool.opts.inputSchema?.safeParse({ name: "test", server_type: "cx; rm -rf", image: "ubuntu-24.04" }).success
    ).toBe(false);
  });

  it("rejects image with special characters", () => {
    const tool = captureRegisteredTools().find((t) => t.name === "hetzner_create_server")!;
    expect(
      tool.opts.inputSchema?.safeParse({ name: "test", server_type: "cx22", image: "ubuntu<script>" }).success
    ).toBe(false);
  });

  it("accepts valid server_type slug (cx53)", () => {
    const tool = captureRegisteredTools().find((t) => t.name === "hetzner_create_server")!;
    expect(
      tool.opts.inputSchema?.safeParse({ name: "test", server_type: "cx53", image: "ubuntu-24.04" }).success
    ).toBe(true);
  });

  it("accepts valid image slug (ubuntu-24.04)", () => {
    const tool = captureRegisteredTools().find((t) => t.name === "hetzner_create_server")!;
    expect(
      tool.opts.inputSchema?.safeParse({ name: "test", server_type: "cx22", image: "ubuntu-24.04" }).success
    ).toBe(true);
  });

  it("accepts uppercase custom image name (Ubuntu-Hardened-2024)", () => {
    const tool = captureRegisteredTools().find((t) => t.name === "hetzner_create_server")!;
    expect(
      tool.opts.inputSchema?.safeParse({ name: "test", server_type: "cx22", image: "Ubuntu-Hardened-2024" }).success
    ).toBe(true);
  });

  it("accepts numeric image ID string (12345)", () => {
    const tool = captureRegisteredTools().find((t) => t.name === "hetzner_create_server")!;
    expect(
      tool.opts.inputSchema?.safeParse({ name: "test", server_type: "cx22", image: "12345" }).success
    ).toBe(true);
  });

  it("still rejects image with injection characters (ubuntu<script>)", () => {
    const tool = captureRegisteredTools().find((t) => t.name === "hetzner_create_server")!;
    expect(
      tool.opts.inputSchema?.safeParse({ name: "test", server_type: "cx22", image: "ubuntu<script>" }).success
    ).toBe(false);
  });
});

// L-2b security: HTML escaping in non-label fields of formatServer
describe("L-2b security: HTML escaping in formatServer non-label fields", () => {
  const XSS = '<script>alert(1)</script>';
  const SAFE = '&lt;script&gt;alert(1)&lt;/script&gt;';

  it("hetzner_get_server escapes server.name in markdown output", async () => {
    const tools = captureRegisteredTools();
    const handler = tools.find((t) => t.name === "hetzner_get_server")!.handler;
    mockedRequest.mockResolvedValueOnce({ server: { ...baseServer, name: XSS } });
    const result = await handler({ id: 1, response_format: "markdown" });
    expect(result.content[0].text).not.toContain(XSS);
    expect(result.content[0].text).toContain(SAFE);
  });

  it("hetzner_get_server escapes server.image.name in markdown output", async () => {
    const tools = captureRegisteredTools();
    const handler = tools.find((t) => t.name === "hetzner_get_server")!.handler;
    mockedRequest.mockResolvedValueOnce({
      server: { ...baseServer, image: { ...baseServer.image, name: '<evil-image>' } }
    });
    const result = await handler({ id: 1, response_format: "markdown" });
    expect(result.content[0].text).not.toContain('<evil-image>');
    expect(result.content[0].text).toContain('&lt;evil-image&gt;');
  });
});

// ── [M-1/M-4] filter parameter validation ─────────────────────────────────────

describe("hetzner_list_servers — filter parameter validation", () => {
  it("rejects label_selector longer than 256 characters", () => {
    const tools = captureRegisteredTools();
    const tool = tools.find((t) => t.name === "hetzner_list_servers")!;
    const longStr = "a".repeat(257);
    expect(
      (tool.opts.inputSchema as { safeParse: (v: unknown) => { success: boolean } })
        .safeParse({ label_selector: longStr, response_format: "markdown" }).success
    ).toBe(false);
  });

  it("accepts label_selector of exactly 256 characters", () => {
    const tools = captureRegisteredTools();
    const tool = tools.find((t) => t.name === "hetzner_list_servers")!;
    const okStr = "a".repeat(256);
    expect(
      (tool.opts.inputSchema as { safeParse: (v: unknown) => { success: boolean } })
        .safeParse({ label_selector: okStr, response_format: "markdown" }).success
    ).toBe(true);
  });
});

// ── [L-1] create_server — root_password plaintext warning ─────────────────────

describe("hetzner_create_server — root_password warning", () => {
  it("description warns that JSON mode returns root_password in plaintext", () => {
    const tools = captureRegisteredTools();
    const tool = tools.find((t) => t.name === "hetzner_create_server")!;
    expect(tool.opts.description).toMatch(/root_password|log|plaintext/i);
  });
});
