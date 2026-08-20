/**
 * Security regression corpus — driven by tests/fixtures/security-corpus.json
 * Do not weaken production policy to make a sample pass; fix the sample or document allow_mode_block.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { checkCommandPolicy } from "../../src/command-policy.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "security-corpus.json");

interface Corpus {
  must_block: Array<{ cmd: string }>;
  must_allow_blocklist: Array<{ cmd: string }>;
  must_allow_allowmode: Array<{ cmd: string }>;
  allow_mode_block: Array<{ cmd: string }>;
}

const corpus = JSON.parse(readFileSync(FIXTURE, "utf-8")) as Corpus;

describe("security corpus", () => {
  const prevPolicy = process.env.MCP_COMMAND_POLICY;
  const prevAllow = process.env.MCP_COMMAND_ALLOW;

  afterEach(() => {
    if (prevPolicy === undefined) delete process.env.MCP_COMMAND_POLICY;
    else process.env.MCP_COMMAND_POLICY = prevPolicy;
    if (prevAllow === undefined) delete process.env.MCP_COMMAND_ALLOW;
    else process.env.MCP_COMMAND_ALLOW = prevAllow;
  });

  test("must_block under blocklist", () => {
    process.env.MCP_COMMAND_POLICY = "blocklist";
    delete process.env.MCP_COMMAND_ALLOW;
    for (const { cmd } of corpus.must_block) {
      const reason = checkCommandPolicy(cmd);
      expect(reason, `expected block: ${cmd}`).toBeTruthy();
    }
  });

  test("must_allow_blocklist under blocklist", () => {
    process.env.MCP_COMMAND_POLICY = "blocklist";
    delete process.env.MCP_COMMAND_ALLOW;
    for (const { cmd } of corpus.must_allow_blocklist) {
      expect(checkCommandPolicy(cmd), `expected allow: ${cmd}`).toBeNull();
    }
  });

  test("must_allow_allowmode under allow", () => {
    process.env.MCP_COMMAND_POLICY = "allow";
    delete process.env.MCP_COMMAND_ALLOW;
    for (const { cmd } of corpus.must_allow_allowmode) {
      expect(checkCommandPolicy(cmd), `expected allow-mode pass: ${cmd}`).toBeNull();
    }
  });

  test("allow_mode_block under allow", () => {
    process.env.MCP_COMMAND_POLICY = "allow";
    delete process.env.MCP_COMMAND_ALLOW;
    for (const { cmd } of corpus.allow_mode_block) {
      expect(checkCommandPolicy(cmd), `expected allow-mode block: ${cmd}`).toBeTruthy();
    }
  });

  test("must_block still blocked under allow mode", () => {
    process.env.MCP_COMMAND_POLICY = "allow";
    process.env.MCP_COMMAND_ALLOW = "rm,python,perl,echo,sh,bash,find,mkfs,dd,format,shutdown,chmod";
    for (const { cmd } of corpus.must_block) {
      const reason = checkCommandPolicy(cmd);
      expect(reason, `hard baseline must hold in allow: ${cmd}`).toBeTruthy();
    }
  });
});
