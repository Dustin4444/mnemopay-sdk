import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "../src/mcp/server.js";

const agent = {} as any;
const envKeys = [
  "MNEMOPAY_GATEWAY_URL",
  "MNEMOPAY_ORG_ID",
  "MNEMOPAY_ORG_API_KEY",
  "MNEMOPAY_IDENTITY",
  "MNEMOPAY_OPERATOR_API_KEY",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

describe("MCP Agent OS tools", () => {
  beforeEach(() => {
    process.env.MNEMOPAY_GATEWAY_URL = "https://gateway.example.com/";
    process.env.MNEMOPAY_ORG_ID = "org/a";
    process.env.MNEMOPAY_ORG_API_KEY = "org-secret";
    process.env.MNEMOPAY_IDENTITY = "operator@example.com";
    process.env.MNEMOPAY_OPERATOR_API_KEY = "operator-secret";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 202,
      text: async () => JSON.stringify({ job: { id: "job-1" } }),
    })));
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
  });

  it("creates isolated jobs with organization auth and identity headers", async () => {
    const result = JSON.parse(await executeTool(agent, "agent_os_job_create", {
      type: "browser.run",
      agentId: "research-agent",
      payload: { url: "https://example.com" },
      maxAttempts: 5,
    }));
    expect(result.job.id).toBe("job-1");
    expect(fetch).toHaveBeenCalledWith(
      "https://gateway.example.com/api/v1/platform/organizations/org%2Fa/jobs",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer org-secret",
          "x-mnemopay-identity": "operator@example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "browser.run",
          agent_id: "research-agent",
          payload: { url: "https://example.com" },
          max_attempts: 5,
        }),
      }),
    );
  });

  it("reads organization usage without sending a request body", async () => {
    await executeTool(agent, "agent_os_usage", {});
    expect(fetch).toHaveBeenCalledWith(
      "https://gateway.example.com/api/v1/platform/organizations/org%2Fa/usage",
      expect.not.objectContaining({ body: expect.anything() }),
    );
  });

  it("fails closed when the gateway is not configured with HTTPS", async () => {
    process.env.MNEMOPAY_GATEWAY_URL = "http://gateway.example.com";
    await expect(executeTool(agent, "agent_os_jobs", {})).rejects.toThrow(/HTTPS MNEMOPAY_GATEWAY_URL/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not hide gateway errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    })));
    await expect(executeTool(agent, "agent_os_alerts", {})).rejects.toThrow(
      "Agent OS gateway returned 403: forbidden",
    );
  });

  it("updates members through organization-scoped role enforcement", async () => {
    await executeTool(agent, "organization_member_update", {
      identity: "member@example.com",
      role: "approver",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://gateway.example.com/api/v1/platform/organizations/org%2Fa/members/member%40example.com",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ role: "approver" }),
      }),
    );
  });

  it("uses separate operator credentials for emergency controls", async () => {
    await executeTool(agent, "operator_process_estop", { processId: "process/1" });
    expect(fetch).toHaveBeenCalledWith(
      "https://gateway.example.com/api/v1/operator/processes/process%2F1/estop",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer operator-secret",
          "content-type": "application/json",
        },
      }),
    );
  });
});
