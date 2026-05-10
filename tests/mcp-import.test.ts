import { afterEach, describe, expect, it, vi } from "vitest";

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  vi.restoreAllMocks();
});

describe("mcp server import behavior", () => {
  it("does not auto-start when imported by another MCP process", async () => {
    process.argv[1] = "C:/Users/bizsu/Projects/brain/dist/mcp.js";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mod = await import("../src/mcp/server.ts");

    expect(typeof mod.default).toBe("function");
    expect(errorSpy).not.toHaveBeenCalledWith("[mnemopay-mcp] Server started (stdio mode)");
  }, 15000);
});
