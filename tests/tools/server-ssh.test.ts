import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api.js")>();
  return { ...actual, makeApiRequest: vi.fn() };
});

vi.mock("child_process");

import { parseFreeOutput, registerServerSshTools, runSsh, runSshKeyScan } from "../../src/tools/server-ssh.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeApiRequest } from "../../src/api.js";
import { execFile } from "child_process";

const mockExecFile = vi.mocked(execFile);

const mockedRequest = vi.mocked(makeApiRequest);
// Injected via dependency injection — no module mocking required.
const mockSsh = vi.fn<typeof runSsh>();
const mockKeyScan = vi.fn<typeof runSshKeyScan>();

beforeEach(() => {
  mockedRequest.mockReset();
  mockSsh.mockReset();
  mockKeyScan.mockReset();
  mockExecFile.mockReset();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FREE_OUTPUT_NORMAL = [
  "               total        used        free      shared  buff/cache   available",
  "Mem:           31334        5540        1234         100       24560       25794",
  "Swap:              0           0           0"
].join("\n");

const FREE_OUTPUT_WITH_SWAP = [
  "               total        used        free      shared  buff/cache   available",
  "Mem:           31334       18000        2334         200       11000       13000",
  "Swap:           8192        3000        5192"
].join("\n");

const FREE_OUTPUT_NO_SWAP_LINE = [
  "               total        used        free      shared  buff/cache   available",
  "Mem:            8192        4096        1024          50        3072        4042"
].join("\n");

const serverResponse = {
  server: {
    id: 127404611,
    name: "jurislm-coolify-nbg1",
    status: "running",
    public_net: {
      ipv4: { ip: "91.99.173.93" },
      ipv6: { ip: "2a01:4f8::1" }
    },
    server_type: { id: 22, name: "cx53", description: "CX53", cores: 16, memory: 32, disk: 320 },
    location: { id: 2, name: "nbg1", description: "Nuremberg DC Park 1", country: "DE", city: "Nuremberg" },
    image: { id: 1, name: "ubuntu-22.04", description: "Ubuntu 22.04", os_flavor: "ubuntu", os_version: "22.04" },
    labels: {},
    created: "2024-01-01T00:00:00+00:00"
  }
};

type ToolHandler = (params: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

function captureHandler(keyScanRunner?: typeof runSshKeyScan): ToolHandler {
  let captured: ToolHandler | undefined;
  const fakeServer = {
    registerTool: vi.fn((_name: string, _opts: unknown, handler: ToolHandler) => {
      captured = handler;
    })
  };
  // Inject mockSsh (and optional keyScanRunner) so the handler never touches real SSH.
  registerServerSshTools(fakeServer as unknown as McpServer, mockSsh, keyScanRunner ?? mockKeyScan);
  if (!captured) {
    throw new Error("registerServerSshTools did not call registerTool — handler not captured");
  }
  return captured;
}

function captureToolOpts(): { description: string; inputSchema: { shape: Record<string, unknown> } } {
  let opts: { description: string; inputSchema: { shape: Record<string, unknown> } } | undefined;
  const fakeServer = {
    registerTool: vi.fn((_name: string, o: typeof opts) => { opts = o; })
  };
  registerServerSshTools(fakeServer as unknown as McpServer, mockSsh, mockKeyScan);
  if (!opts) throw new Error("opts not captured");
  return opts;
}

// ── runSshKeyScan — direct unit tests (execFile mocked) ───────────────────────

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;
type FakeChildProcess = { stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } | null };

function stubExecFileCalls(...calls: Array<{ err: Error | null; stdout: string; stderr: string }>): FakeChildProcess {
  const mockStdin = { write: vi.fn(), end: vi.fn() };
  let callIndex = 0;
  mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
    const call = calls[callIndex++] ?? { err: null, stdout: "", stderr: "" };
    (cb as ExecCallback)(call.err, call.stdout, call.stderr);
    return { stdin: mockStdin } as ReturnType<typeof execFile>;
  });
  return { stdin: mockStdin };
}

describe("runSshKeyScan — direct unit tests", () => {
  it("rejects when ssh-keyscan returns empty stdout", async () => {
    stubExecFileCalls({ err: null, stdout: "", stderr: "Connection refused" });
    await expect(runSshKeyScan("1.2.3.4", 22)).rejects.toThrow("ssh-keyscan failed");
  });

  it("rejects when ssh-keyscan exits non-zero even with partial stdout (Finding #3)", async () => {
    const scanError = new Error("ssh-keyscan: connection timeout");
    stubExecFileCalls({ err: scanError, stdout: "partial-key-data\n", stderr: "" });
    await expect(runSshKeyScan("1.2.3.4", 22)).rejects.toThrow("connection timeout");
  });

  it("returns array of all fingerprints preserving base64 padding (Findings #1 and #2)", async () => {
    const keyscanOut = "1.2.3.4 ecdsa-sha2-nistp256 ECDSA\n1.2.3.4 ssh-ed25519 ED25519";
    // Second fingerprint has trailing '=' (base64 padding)
    const keygenOut = "256 SHA256:AbCdEf+abc root@host (ECDSA)\n256 SHA256:XyZ123/q8= user@host (ED25519)";
    stubExecFileCalls(
      { err: null, stdout: keyscanOut, stderr: "" },
      { err: null, stdout: keygenOut, stderr: "" }
    );

    const result = await runSshKeyScan("1.2.3.4", 22);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toContain("SHA256:AbCdEf+abc");
    expect(result).toContain("SHA256:XyZ123/q8=");  // '=' must be preserved
    expect(result).toHaveLength(2);
  });

  it("rejects when ssh-keygen produces no recognisable fingerprint", async () => {
    stubExecFileCalls(
      { err: null, stdout: "1.2.3.4 ssh-ed25519 KEY", stderr: "" },
      { err: null, stdout: "garbled output without SHA256", stderr: "" }
    );
    await expect(runSshKeyScan("1.2.3.4", 22)).rejects.toThrow("Could not parse fingerprint");
  });

  it("rejects when ssh-keygen exits non-zero", async () => {
    const keygenError = new Error("permission denied");
    stubExecFileCalls(
      { err: null, stdout: "1.2.3.4 ssh-ed25519 KEY", stderr: "" },
      { err: keygenError, stdout: "", stderr: "" }
    );
    await expect(runSshKeyScan("1.2.3.4", 22)).rejects.toThrow("permission denied");
  });
});

// ── parseFreeOutput — pure unit tests ─────────────────────────────────────────

describe("parseFreeOutput", () => {
  it("parses normal output with swap=0 correctly", () => {
    const { ram, swap } = parseFreeOutput(FREE_OUTPUT_NORMAL);

    expect(ram.total).toBe(31334);
    expect(ram.used).toBe(5540);
    expect(ram.free).toBe(1234);
    expect(ram.available).toBe(25794);
    expect(ram.usedPercent).toBeCloseTo((5540 / 31334) * 100, 1);
    expect(swap).not.toBeNull();
    expect(swap!.total).toBe(0);
  });

  it("parses output with active swap", () => {
    const { ram, swap } = parseFreeOutput(FREE_OUTPUT_WITH_SWAP);

    expect(ram.total).toBe(31334);
    expect(ram.used).toBe(18000);
    expect(swap).not.toBeNull();
    expect(swap!.total).toBe(8192);
    expect(swap!.used).toBe(3000);
    expect(swap!.free).toBe(5192);
  });

  it("returns null swap when Swap: line is absent", () => {
    const { swap } = parseFreeOutput(FREE_OUTPUT_NO_SWAP_LINE);
    expect(swap).toBeNull();
  });

  it("usedPercent is 0 when total is 0", () => {
    const output = "Mem:              0           0           0           0           0           0";
    const { ram } = parseFreeOutput(output);
    expect(ram.usedPercent).toBe(0);
  });

  it("throws on empty / unrecognised output", () => {
    expect(() => parseFreeOutput("not valid output")).toThrow();
  });
});

// ── hetzner_get_server_ram — markdown output ──────────────────────────────────

describe("hetzner_get_server_ram — markdown", () => {
  it("returns formatted RAM stats", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockSsh.mockResolvedValueOnce(FREE_OUTPUT_NORMAL);

    const result = await captureHandler()({ id: 127404611, response_format: "markdown" });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("RAM 使用率");
    expect(text).toContain("5,540 MiB");
    expect(text).toContain("31,334 MiB");
    expect(text).toContain("17.7%");
    expect(text).toContain("25,794 MiB");
  });

  it("shows 未配置 when swap total is 0", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockSsh.mockResolvedValueOnce(FREE_OUTPUT_NORMAL);

    const result = await captureHandler()({ id: 1, response_format: "markdown" });

    expect(result.content[0].text).toContain("未配置");
  });

  it("shows swap stats when swap is active", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockSsh.mockResolvedValueOnce(FREE_OUTPUT_WITH_SWAP);

    const result = await captureHandler()({ id: 1, response_format: "markdown" });

    const text = result.content[0].text;
    expect(text).toContain("Swap");
    expect(text).toContain("3,000 MiB");
    expect(text).toContain("8,192 MiB");
  });

  it("includes source line with resolved IP and custom SSH params", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockSsh.mockResolvedValueOnce(FREE_OUTPUT_NORMAL);

    const result = await captureHandler()({
      id: 127404611,
      ssh_user: "ubuntu",
      ssh_port: 2222,
      response_format: "markdown"
    });

    expect(result.content[0].text).toContain("ubuntu@91.99.173.93:2222");
  });

  it("passes correct IP, port, user, and command to sshRunner", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockSsh.mockResolvedValueOnce(FREE_OUTPUT_NORMAL);

    await captureHandler()({ id: 1, ssh_user: "ubuntu", ssh_port: 2222, response_format: "markdown" });

    expect(mockSsh).toHaveBeenCalledWith("91.99.173.93", 2222, "ubuntu", "free -m");
  });

  it("defaults ssh_user to root and ssh_port to 22", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockSsh.mockResolvedValueOnce(FREE_OUTPUT_NORMAL);

    await captureHandler()({ id: 1, response_format: "markdown" });

    expect(mockSsh).toHaveBeenCalledWith("91.99.173.93", 22, "root", "free -m");
  });
});

// ── hetzner_get_server_ram — JSON output ──────────────────────────────────────

describe("hetzner_get_server_ram — JSON", () => {
  it("returns structured JSON with ram and swap", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockSsh.mockResolvedValueOnce(FREE_OUTPUT_WITH_SWAP);

    const result = await captureHandler()({ id: 127404611, response_format: "json" });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.server.ipv4).toBe("91.99.173.93");
    expect(parsed.ram.total).toBe(31334);
    expect(parsed.swap.total).toBe(8192);
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("hetzner_get_server_ram — error handling", () => {
  it("returns isError when server has no IPv4", async () => {
    const noIpServer = {
      server: {
        ...serverResponse.server,
        public_net: { ipv4: null, ipv6: { ip: "2a01:4f8::1" } }
      }
    };
    mockedRequest.mockResolvedValueOnce(noIpServer);

    const result = await captureHandler()({ id: 1, response_format: "markdown" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no public IPv4");
  });

  it("returns SSH permission denied message", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockSsh.mockRejectedValueOnce(new Error("Permission denied (publickey)"));

    const result = await captureHandler()({ id: 1, response_format: "markdown" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("permission denied");
  });

  it("returns timeout message on SSH timeout", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockSsh.mockRejectedValueOnce(new Error("Connection timed out"));

    const result = await captureHandler()({ id: 1, response_format: "markdown" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("timed out");
  });

  it("returns connection refused message", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockSsh.mockRejectedValueOnce(new Error("Connection refused"));

    const result = await captureHandler()({ id: 1, response_format: "markdown" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("refused");
  });

  it("returns ENOENT message when ssh binary is missing", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockSsh.mockRejectedValueOnce(new Error("ENOENT"));

    const result = await captureHandler()({ id: 1, response_format: "markdown" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ssh");
  });

  it("returns isError when Hetzner API fails", async () => {
    mockedRequest.mockRejectedValueOnce(new Error("network error"));

    const result = await captureHandler()({ id: 1, response_format: "markdown" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("network error");
  });

  it("returns isError when API returns non-IPv4 string for ip field", async () => {
    const badIpServer = {
      server: {
        ...serverResponse.server,
        public_net: { ipv4: { ip: "not-an-ip" }, ipv6: { ip: "2a01:4f8::1" } }
      }
    };
    mockedRequest.mockResolvedValueOnce(badIpServer);

    const result = await captureHandler()({ id: 1, response_format: "markdown" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/IPv4|invalid/i);
  });

  it("returns isError when API returns IP with out-of-range octet (999.0.0.1)", async () => {
    const badIpServer = {
      server: {
        ...serverResponse.server,
        public_net: { ipv4: { ip: "999.0.0.1" }, ipv6: { ip: "2a01:4f8::1" } }
      }
    };
    mockedRequest.mockResolvedValueOnce(badIpServer);

    const result = await captureHandler()({ id: 1, response_format: "markdown" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/IPv4|unexpected format/i);
  });
});

// ── [H-2] expected_fingerprint — TOFU MITM prevention ───────────────────────

const FAKE_FP = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WRONG_FP = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("hetzner_get_server_ram — expected_fingerprint", () => {
  it("tool description warns about TOFU risk and mentions expected_fingerprint", () => {
    const opts = captureToolOpts();
    expect(opts.description).toMatch(/TOFU|accept-new/i);
    expect(opts.description).toContain("expected_fingerprint");
  });

  it("input schema accepts expected_fingerprint as optional string", () => {
    const opts = captureToolOpts();
    expect(opts.inputSchema.shape).toHaveProperty("expected_fingerprint");
  });

  it("skips fingerprint check when expected_fingerprint is not provided", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockSsh.mockResolvedValueOnce(FREE_OUTPUT_NORMAL);

    await captureHandler()({ id: 1, response_format: "markdown" });

    expect(mockKeyScan).not.toHaveBeenCalled();
    expect(mockSsh).toHaveBeenCalled();
  });

  it("calls keyScanRunner with resolved IP and port when expected_fingerprint is provided", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockKeyScan.mockResolvedValueOnce([FAKE_FP]);
    mockSsh.mockResolvedValueOnce(FREE_OUTPUT_NORMAL);

    await captureHandler()({
      id: 1,
      expected_fingerprint: FAKE_FP,
      ssh_port: 22,
      response_format: "markdown"
    });

    expect(mockKeyScan).toHaveBeenCalledWith("91.99.173.93", 22);
  });

  it("proceeds normally when fingerprint matches", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockKeyScan.mockResolvedValueOnce([FAKE_FP]);
    mockSsh.mockResolvedValueOnce(FREE_OUTPUT_NORMAL);

    const result = await captureHandler()({
      id: 1,
      expected_fingerprint: FAKE_FP,
      response_format: "markdown"
    });

    expect(result.isError).toBeUndefined();
    expect(mockSsh).toHaveBeenCalled();
  });

  it("returns isError and does NOT call sshRunner when fingerprint mismatches", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockKeyScan.mockResolvedValueOnce([FAKE_FP]);

    const result = await captureHandler()({
      id: 1,
      expected_fingerprint: WRONG_FP,
      response_format: "markdown"
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/fingerprint mismatch/i);
    expect(mockSsh).not.toHaveBeenCalled();
  });

  it("returns isError when keyScan fails", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    mockKeyScan.mockRejectedValueOnce(new Error("ssh-keyscan: connection refused"));

    const result = await captureHandler()({
      id: 1,
      expected_fingerprint: FAKE_FP,
      response_format: "markdown"
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/fingerprint|keyscan/i);
    expect(mockSsh).not.toHaveBeenCalled();
  });

  it("proceeds when expected_fingerprint matches second key in multi-key response (Finding #1)", async () => {
    mockedRequest.mockResolvedValueOnce(serverResponse);
    // keyScanRunner now returns string[] — expected is the SECOND fingerprint
    const multiKeyMock = vi.fn<typeof runSshKeyScan>().mockResolvedValueOnce([WRONG_FP, FAKE_FP]);
    mockSsh.mockResolvedValueOnce(FREE_OUTPUT_NORMAL);

    const result = await captureHandler(multiKeyMock)({
      id: 1,
      expected_fingerprint: FAKE_FP,
      response_format: "markdown"
    });

    expect(result.isError).toBeUndefined();
    expect(mockSsh).toHaveBeenCalled();
  });

  it("returns isError when padded fingerprint (SHA256:abc==) is expected but extraction strips padding (Finding #2)", async () => {
    const PADDED_FP = "SHA256:AbCdEfGhIjKlMnOpQrStUvWxYzABCDEFGHIJK==";
    mockedRequest.mockResolvedValueOnce(serverResponse);
    const paddedMock = vi.fn<typeof runSshKeyScan>().mockResolvedValueOnce([PADDED_FP]);
    mockSsh.mockResolvedValueOnce(FREE_OUTPUT_NORMAL);

    const result = await captureHandler(paddedMock)({
      id: 1,
      expected_fingerprint: PADDED_FP,
      response_format: "markdown"
    });

    // Should succeed — padded fingerprint in response must match padded expected
    expect(result.isError).toBeUndefined();
    expect(mockSsh).toHaveBeenCalled();
  });
});
