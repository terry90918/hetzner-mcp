import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api.js")>();
  return {
    ...actual,
    makeApiRequest: vi.fn()
  };
});

import { registerMetricsTools } from "../../src/tools/metrics.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeApiRequest } from "../../src/api.js";

const mockedRequest = vi.mocked(makeApiRequest);

beforeEach(() => {
  mockedRequest.mockReset();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW_TS = 1735689600;

function cpuSeries(vals: number[]) {
  return { cpu: { values: vals.map((v, i) => [NOW_TS + i * 60, String(v)]) } };
}

function diskSeries(bwRead = 10_485_760, bwWrite = 1_048_576, iopsR = 100, iopsW = 10) {
  return {
    "disk.0.bandwidth.read":  { values: [[NOW_TS, String(bwRead)]] },
    "disk.0.bandwidth.write": { values: [[NOW_TS, String(bwWrite)]] },
    "disk.0.iops.read":       { values: [[NOW_TS, String(iopsR)]] },
    "disk.0.iops.write":      { values: [[NOW_TS, String(iopsW)]] }
  };
}

function networkSeries(bwIn = 262_144, bwOut = 131_072) {
  return {
    "network.0.bandwidth.in":  { values: [[NOW_TS, String(bwIn)]] },
    "network.0.bandwidth.out": { values: [[NOW_TS, String(bwOut)]] }
  };
}

function metricsResponse(timeSeries: Record<string, unknown>) {
  return {
    metrics: {
      start: "2026-01-01T00:00:00+00:00",
      end: "2026-01-01T00:05:00+00:00",
      step: 60,
      time_series: timeSeries
    }
  };
}

const serverResponse = {
  server: {
    id: 127404611,
    name: "jurislm-coolify-nbg1",
    status: "running",
    public_net: { ipv4: { ip: "91.99.173.93" }, ipv6: { ip: "2a01:4f8::1" } },
    server_type: { id: 22, name: "cx53", description: "CX53", cores: 16, memory: 32, disk: 320 },
    location: { id: 2, name: "nbg1", description: "Nuremberg DC Park 1", country: "DE", city: "Nuremberg" },
    image: { id: 1, name: "ubuntu-22.04", description: "Ubuntu 22.04", os_flavor: "ubuntu", os_version: "22.04" },
    labels: {},
    created: "2024-01-01T00:00:00+00:00"
  }
};

type ToolHandler = (params: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
interface CapturedTool { name: string; handler: ToolHandler }

function captureTools(): CapturedTool[] {
  const captured: CapturedTool[] = [];
  const fakeServer = {
    registerTool: vi.fn((name: string, _opts: unknown, handler: ToolHandler) => {
      captured.push({ name, handler });
    })
  };
  registerMetricsTools(fakeServer as unknown as McpServer);
  return captured;
}

function getHandler(): ToolHandler {
  return captureTools().find((t) => t.name === "hetzner_get_server_metrics")!.handler;
}

// ── CPU section ───────────────────────────────────────────────────────────────

describe("hetzner_get_server_metrics — CPU", () => {
  it("calculates percentage from summed raw value and core count", async () => {
    mockedRequest
      .mockResolvedValueOnce(metricsResponse(cpuSeries([480, 640, 757.75])))  // metrics
      .mockResolvedValueOnce(serverResponse);                                   // server info

    const result = await getHandler()({ id: 127404611, type: ["cpu"], response_format: "markdown" });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // latest = 757.75, cores = 16 → 47.4%
    expect(text).toContain("47.4%");
    expect(text).toContain("757.8");   // fmt(757.75, 1)
    expect(text).toContain("/ 1600");  // max = 16 × 100
    expect(text).toContain("16 核");
  });

  it("shows avg and max", async () => {
    // vals: 400, 800, 1200 → avg=800, max=1200, cores=16
    mockedRequest
      .mockResolvedValueOnce(metricsResponse(cpuSeries([400, 800, 1200])))
      .mockResolvedValueOnce(serverResponse);

    const result = await getHandler()({ id: 1, type: ["cpu"], response_format: "markdown" });

    const text = result.content[0].text;
    expect(text).toContain("平均");
    expect(text).toContain("最高");
    // avg = 800/16 = 50.0%, max = 1200/16 = 75.0%
    expect(text).toContain("50.0%");
    expect(text).toContain("75.0%");
  });

  it("shows period footer", async () => {
    mockedRequest
      .mockResolvedValueOnce(metricsResponse(cpuSeries([100])))
      .mockResolvedValueOnce(serverResponse);

    const result = await getHandler()({ id: 1, type: ["cpu"], response_format: "markdown" });

    expect(result.content[0].text).toContain("Period:");
    expect(result.content[0].text).toContain("step 60s");
  });

  it("handles all-NaN series gracefully", async () => {
    const nanSeries = { cpu: { values: [[NOW_TS, "NaN"], [NOW_TS + 60, "NaN"]] } };
    mockedRequest
      .mockResolvedValueOnce(metricsResponse(nanSeries))
      .mockResolvedValueOnce(serverResponse);

    const result = await getHandler()({ id: 1, type: ["cpu"], response_format: "markdown" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No CPU data");
  });

  it("returns JSON with core count when response_format is json", async () => {
    mockedRequest
      .mockResolvedValueOnce(metricsResponse(cpuSeries([800])))
      .mockResolvedValueOnce(serverResponse);

    const result = await getHandler()({ id: 1, type: ["cpu"], response_format: "json" });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.cores).toBe(16);
    expect(parsed.time_series.cpu.values[0][1]).toBe("800");
  });

  it("returns isError when API fails", async () => {
    mockedRequest.mockRejectedValueOnce(new Error("timeout"));

    const result = await getHandler()({ id: 1, type: ["cpu"], response_format: "markdown" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error");
  });
});

// ── Disk section ──────────────────────────────────────────────────────────────

describe("hetzner_get_server_metrics — disk", () => {
  it("converts bytes/s to MB/s and shows IOPS", async () => {
    // 10 MB/s read, 1 MB/s write, 100 read IOPS, 10 write IOPS
    mockedRequest.mockResolvedValueOnce(metricsResponse(diskSeries()));

    const result = await getHandler()({ id: 1, type: ["disk"], response_format: "markdown" });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("10.00 MB/s");
    expect(text).toContain("1.00 MB/s");
    expect(text).toContain("100 ops/s");
    expect(text).toContain("10 ops/s");
  });

  it("shows 磁碟 I/O header", async () => {
    mockedRequest.mockResolvedValueOnce(metricsResponse(diskSeries()));

    const result = await getHandler()({ id: 1, type: ["disk"], response_format: "markdown" });

    expect(result.content[0].text).toContain("磁碟 I/O");
  });

  it("does NOT fetch server info when type is disk only", async () => {
    mockedRequest.mockResolvedValueOnce(metricsResponse(diskSeries()));

    await getHandler()({ id: 1, type: ["disk"], response_format: "markdown" });

    // Only one call: the metrics request. Server info must not be fetched.
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });
});

// ── Network section ───────────────────────────────────────────────────────────

describe("hetzner_get_server_metrics — network", () => {
  it("converts bytes/s to Mbps", async () => {
    // 262144 bytes/s in = 2.097152 Mbps ≈ 2.10 Mbps
    // 131072 bytes/s out = 1.048576 Mbps ≈ 1.05 Mbps
    mockedRequest.mockResolvedValueOnce(metricsResponse(networkSeries()));

    const result = await getHandler()({ id: 1, type: ["network"], response_format: "markdown" });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Mbps");
    expect(text).toContain("2.10 Mbps");
    expect(text).toContain("1.05 Mbps");
  });

  it("shows 網路 header", async () => {
    mockedRequest.mockResolvedValueOnce(metricsResponse(networkSeries()));

    const result = await getHandler()({ id: 1, type: ["network"], response_format: "markdown" });

    expect(result.content[0].text).toContain("網路");
  });
});

// ── Multi-type ────────────────────────────────────────────────────────────────

describe("hetzner_get_server_metrics — multiple types", () => {
  it("renders all three sections when type=[cpu,disk,network]", async () => {
    mockedRequest
      .mockResolvedValueOnce(metricsResponse({
        ...cpuSeries([800]),
        ...diskSeries(),
        ...networkSeries()
      }))
      .mockResolvedValueOnce(serverResponse);

    const result = await getHandler()({
      id: 1,
      type: ["cpu", "disk", "network"],
      response_format: "markdown"
    });

    const text = result.content[0].text;
    expect(text).toContain("CPU 使用率");
    expect(text).toContain("磁碟 I/O");
    expect(text).toContain("網路");
  });

  it("calls API with comma-joined type query param", async () => {
    mockedRequest
      .mockResolvedValueOnce(metricsResponse({ ...cpuSeries([400]), ...diskSeries() }))
      .mockResolvedValueOnce(serverResponse);

    await getHandler()({ id: 5, type: ["cpu", "disk"], response_format: "markdown" });

    expect(mockedRequest).toHaveBeenCalledWith(
      "/servers/5/metrics",
      expect.anything(),
      "GET",
      undefined,
      expect.objectContaining({ type: "cpu,disk" })
    );
  });
});

// ── Default time range ────────────────────────────────────────────────────────

describe("hetzner_get_server_metrics — default parameters", () => {
  it("passes start/end defaults to API when not supplied", async () => {
    mockedRequest
      .mockResolvedValueOnce(metricsResponse(cpuSeries([100])))
      .mockResolvedValueOnce(serverResponse);

    const before = new Date();
    await getHandler()({ id: 1, type: ["cpu"], response_format: "markdown" });
    const after = new Date();

    const call = mockedRequest.mock.calls[0];
    const queryParams = call[4] as { start: string; end: string; step: number };
    const startDate = new Date(queryParams.start);
    const endDate = new Date(queryParams.end);

    // start should be ~5 min before end
    const diffMs = endDate.getTime() - startDate.getTime();
    expect(diffMs).toBeGreaterThanOrEqual(4 * 60 * 1000);
    expect(diffMs).toBeLessThanOrEqual(6 * 60 * 1000);
    // end should be within the test execution window
    expect(endDate.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(endDate.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    expect(queryParams.step).toBe(60);
  });

  it("honours explicit start/end/step when provided", async () => {
    mockedRequest
      .mockResolvedValueOnce(metricsResponse(cpuSeries([100])))
      .mockResolvedValueOnce(serverResponse);

    await getHandler()({
      id: 1,
      type: ["cpu"],
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-01T01:00:00Z",
      step: 300,
      response_format: "markdown"
    });

    const call = mockedRequest.mock.calls[0];
    const queryParams = call[4] as { start: string; end: string; step: number };
    expect(queryParams.start).toBe("2026-01-01T00:00:00Z");
    expect(queryParams.end).toBe("2026-01-01T01:00:00Z");
    expect(queryParams.step).toBe(300);
  });
});
