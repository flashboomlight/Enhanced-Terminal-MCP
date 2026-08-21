/**
 * secret-registry 单元测试：registry 单一来源与派生候选结构的一致性
 * 防漂移核心属性：任何完整匹配串的任意前缀，都必须是流式 matcher 的活候选（保证无 FN）
 */
import { describe, expect, test } from "vitest";
import { SECRET_PATTERN_DEFS, STREAM_PATTERN_DERIVATION } from "../../src/secret-registry.js";

/** 每条 pattern 的已知命中 fixture（完整匹配串） */
const FIXTURES: Record<string, string[]> = {
  "OpenAI API Key": [`sk-${"a".repeat(32)}`, `sk-proj-${"Ab1".repeat(11)}`],
  "GitHub Token": [`ghp_${"b".repeat(20)}`, `ghs_${"Z9_".repeat(8)}`],
  "AWS Access Key": ["AKIAIOSFODNN7EXAMPLE"],
  "AWS Secret Key": ['aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'],
  "Private Key Header": ["-----BEGIN OPENSSH PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----"],
  "JWT Token": [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
  ],
  "Slack Token": [`xoxb-${"1".repeat(12)}`],
  "Generic API Key": ['api_key: "abcdef0123456789abcdef0123456789"'],
  "Connection String": ["mongodb://admin:secret123@db.example.com:27017/mydb"],
  "Discord Token": [`M${"A".repeat(23)}.${"B".repeat(6)}.${"C".repeat(27)}`],
};

describe("secret-registry fixtures", () => {
  test("every pattern matches its known fixtures", () => {
    for (const def of SECRET_PATTERN_DEFS) {
      const fixtures = FIXTURES[def.name];
      expect(fixtures, `missing fixtures for ${def.name}`).toBeDefined();
      for (const f of fixtures) {
        def.regex.lastIndex = 0;
        expect(def.regex.test(f), `${def.name} should match fixture`).toBe(true);
      }
    }
  });

  test("fixture keys exactly cover pattern names (no orphan)", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(SECRET_PATTERN_DEFS.map((d) => d.name).sort());
  });
});

describe("candidate derivation", () => {
  test("firstBytes covers head initials with case variants for i-flag defs", () => {
    for (const def of SECRET_PATTERN_DEFS) {
      for (const head of def.heads) {
        expect(STREAM_PATTERN_DERIVATION.firstBytes.has(head[0])).toBe(true);
        if (def.iFlag) {
          expect(STREAM_PATTERN_DERIVATION.firstBytes.has(head[0].toLowerCase())).toBe(true);
          expect(STREAM_PATTERN_DERIVATION.firstBytes.has(head[0].toUpperCase())).toBe(true);
        }
      }
    }
  });

  test("every prefix of every fixture is a live candidate (anti-drift property)", () => {
    const { stickySensitive, stickyInsensitive } = STREAM_PATTERN_DERIVATION;
    for (const def of SECRET_PATTERN_DEFS) {
      const sticky = def.iFlag ? stickyInsensitive : stickySensitive;
      if (sticky === null) throw new Error(`sticky regex missing for ${def.name}`);
      for (const fixture of FIXTURES[def.name]) {
        for (let end = 1; end <= fixture.length; end++) {
          const prefix = fixture.slice(0, end);
          sticky.lastIndex = 0;
          expect(sticky.test(prefix), `${def.name} prefix ${JSON.stringify(prefix)} must stay a live candidate`).toBe(
            true,
          );
        }
      }
    }
  });
});
