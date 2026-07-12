import { afterEach, describe, expect, test } from "vitest";
import { checkCommandPolicy, getAllowPrefixes, getCommandPolicyMode } from "../../src/command-policy.js";

describe("command-policy", () => {
  const prevPolicy = process.env.MCP_COMMAND_POLICY;
  const prevAllow = process.env.MCP_COMMAND_ALLOW;

  afterEach(() => {
    if (prevPolicy === undefined) delete process.env.MCP_COMMAND_POLICY;
    else process.env.MCP_COMMAND_POLICY = prevPolicy;
    if (prevAllow === undefined) delete process.env.MCP_COMMAND_ALLOW;
    else process.env.MCP_COMMAND_ALLOW = prevAllow;
  });

  test("default mode is blocklist", () => {
    delete process.env.MCP_COMMAND_POLICY;
    expect(getCommandPolicyMode()).toBe("blocklist");
  });

  test("blocklist allows npm run and blocks rm -rf /", () => {
    process.env.MCP_COMMAND_POLICY = "blocklist";
    expect(checkCommandPolicy("npm run build")).toBeNull();
    expect(checkCommandPolicy("rm -rf /")).toMatch(/hard-blocked|dangerous/);
  });

  test("allow mode rejects unknown commands", () => {
    process.env.MCP_COMMAND_POLICY = "allow";
    delete process.env.MCP_COMMAND_ALLOW;
    expect(checkCommandPolicy("curl http://evil")).toMatch(/allow-policy/);
    expect(checkCommandPolicy("npm test")).toBeNull();
    expect(checkCommandPolicy("git status")).toBeNull();
  });

  test("allow mode still hard-blocks catastrophic even if prefix matches", () => {
    process.env.MCP_COMMAND_POLICY = "allow";
    process.env.MCP_COMMAND_ALLOW = "rm ";
    expect(checkCommandPolicy("rm -rf /")).toMatch(/hard-blocked/);
  });

  test("MCP_COMMAND_ALLOW custom prefixes", () => {
    process.env.MCP_COMMAND_POLICY = "allow";
    process.env.MCP_COMMAND_ALLOW = "python ,cargo ";
    expect(getAllowPrefixes()).toEqual(["python", "cargo"]);
    expect(checkCommandPolicy("python -c print(1)")).toBeNull();
    expect(checkCommandPolicy("cargo build")).toBeNull();
    expect(checkCommandPolicy("npm test")).toMatch(/allow-policy/);
  });
});
