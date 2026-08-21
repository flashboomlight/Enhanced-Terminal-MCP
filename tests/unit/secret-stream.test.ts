/**
 * secret-stream 单元测试：流式候选状态机
 * 核心不变量：scanContent(whole-string)命中的内容，任意 chunk 切分下流式 matcher 必须命中（无 FN）；
 * 且命中前 released 字节永不包含 secret 原文（fault injection）。
 */
import { describe, expect, test } from "vitest";
import { scanContent } from "../../src/scan.js";
import {
  COMMAND_OUTPUT_FALLBACK_PREVIEW_BYTES,
  QUARANTINE_BYTES,
  QUARANTINE_OVERFLOW_HIT,
  SecretStreamMatcher,
} from "../../src/secret-stream.js";

const SECRET_FIXTURES: Array<{ name: string; secret: string }> = [
  { name: "OpenAI API Key", secret: `sk-${"a".repeat(32)}` },
  { name: "GitHub Token", secret: `ghp_${"b".repeat(20)}` },
  { name: "AWS Access Key", secret: "AKIAIOSFODNN7EXAMPLE" },
  { name: "AWS Secret Key", secret: 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"' },
  { name: "Private Key Header", secret: "-----BEGIN OPENSSH PRIVATE KEY-----" },
  {
    name: "JWT Token",
    secret:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
  },
  { name: "Slack Token", secret: `xoxb-${"1".repeat(12)}` },
  { name: "Generic API Key", secret: 'api_key: "abcdef0123456789abcdef0123456789"' },
  { name: "Connection String", secret: "mongodb://admin:secret123@db.example.com:27017/mydb" },
  { name: "Discord Token", secret: `M${"A".repeat(23)}.${"B".repeat(6)}.${"C".repeat(27)}` },
];

describe("differential vs scanContent", () => {
  test("two-way split at every byte offset: no FN, released never contains secret", () => {
    for (const { name, secret } of SECRET_FIXTURES) {
      const wrapped = `prefix noise ${secret} suffix noise`;
      const whole = scanContent(wrapped);
      expect(whole.safe, `scanContent must flag ${name}`).toBe(false);
      expect(whole.findings).toContain(name);
      for (let cut = 0; cut <= wrapped.length; cut++) {
        const m = new SecretStreamMatcher();
        const r1 = m.push(Buffer.from(wrapped.slice(0, cut), "utf8"));
        const r2 = m.push(Buffer.from(wrapped.slice(cut), "utf8"));
        const fin = m.finish();
        const hit = r1.hit ?? r2.hit ?? fin.hit;
        expect(hit, `${name} split at ${cut} must hit (no FN)`).not.toBeNull();
        const releasedAll = Buffer.concat([r1.released, r2.released, fin.released]);
        expect(releasedAll.includes(secret), `${name} split at ${cut}: secret leaked into released`).toBe(false);
      }
    }
  });

  test("random multi-way splits: no FN", () => {
    const sample = `log line 1\nsk-${"q".repeat(40)}\nmongodb://u:p@h:1/db\nmore logs\n`;
    const buf = Buffer.from(sample, "utf8");
    const whole = scanContent(sample);
    expect(whole.findings.length).toBeGreaterThan(0);
    for (let trial = 0; trial < 50; trial++) {
      const cuts = new Set<number>();
      const nCuts = 2 + Math.floor(Math.random() * 5);
      while (cuts.size < nCuts) cuts.add(Math.floor(Math.random() * (buf.length + 1)));
      const points = [0, ...[...cuts].sort((a, b) => a - b), buf.length];
      const m = new SecretStreamMatcher();
      let hit: string | null = null;
      for (let i = 0; i + 1 < points.length; i++) {
        const r = m.push(buf.subarray(points[i], points[i + 1]));
        hit = hit ?? r.hit;
      }
      hit = hit ?? m.finish().hit;
      expect(hit, `trial ${trial} cuts ${[...cuts]} must hit`).not.toBeNull();
    }
  });
});

describe("quarantine", () => {
  const candidate = (n: number) => Buffer.from(`M${"A".repeat(n - 1)}`, "latin1");

  test("8191/8192 hold undecided, 8193 fail-closed", () => {
    for (const n of [QUARANTINE_BYTES - 1, QUARANTINE_BYTES]) {
      const m = new SecretStreamMatcher();
      const r = m.push(candidate(n));
      expect(r.hit, `pending=${n} must not overflow`).toBeNull();
      expect(r.released.length).toBe(0);
      expect(m.hit).toBeNull();
    }
    const m = new SecretStreamMatcher();
    const r = m.push(candidate(QUARANTINE_BYTES + 1));
    expect(r.hit).toBe(QUARANTINE_OVERFLOW_HIT);
    expect(r.released.length).toBe(0);
  });

  test("overflow accumulates across chunks", () => {
    const m = new SecretStreamMatcher();
    expect(m.push(Buffer.from(`M${"A".repeat(8000)}`, "latin1")).hit).toBeNull();
    const r = m.push(Buffer.from("A".repeat(200), "latin1"));
    expect(r.hit).toBe(QUARANTINE_OVERFLOW_HIT);
  });
});

describe("clean input", () => {
  test("all bytes released in order, no hit", () => {
    const text = `${"hello world\n".repeat(500)}numbers 0123456789 end\n`;
    const buf = Buffer.from(text, "utf8");
    const m = new SecretStreamMatcher();
    const parts: Buffer[] = [];
    for (let off = 0; off < buf.length; off += 7) {
      const r = m.push(buf.subarray(off, Math.min(off + 7, buf.length)));
      expect(r.hit).toBeNull();
      parts.push(r.released);
    }
    const fin = m.finish();
    expect(fin.hit).toBeNull();
    parts.push(fin.released);
    expect(Buffer.concat(parts).equals(buf)).toBe(true);
  });
});

describe("EOF resolution", () => {
  test("incomplete secret released (matches scanContent semantics)", () => {
    const m = new SecretStreamMatcher();
    const r = m.push(Buffer.from("token: sk-abc123", "utf8"));
    expect(r.hit).toBeNull();
    expect(r.released.toString("utf8")).toBe("token: ");
    const fin = m.finish();
    expect(fin.hit).toBeNull();
    expect(fin.released.toString("utf8")).toBe("sk-abc123");
    expect(scanContent("token: sk-abc123").safe).toBe(true);
  });

  test("complete secret at stream tail hits", () => {
    const m = new SecretStreamMatcher();
    const r = m.push(Buffer.from(`see ghp_${"c".repeat(20)}`, "utf8"));
    expect(r.hit).toBe("GitHub Token");
    expect(m.finish().hit).toBe("GitHub Token");
  });
});

describe("large drain", () => {
  test(">4MiB stream: secret at 4.5MiB hits, released prefix secret-free", () => {
    const filler = Buffer.from("y".repeat(65536), "latin1");
    const secret = `sk-${"d".repeat(32)}`;
    const m = new SecretStreamMatcher();
    const releasedParts: Buffer[] = [];
    let hit: string | null = null;
    for (let i = 0; i < 72; i++) {
      if (hit !== null) continue;
      const chunk = i === 69 ? Buffer.concat([filler, Buffer.from(secret, "latin1")]) : filler;
      const r = m.push(chunk);
      hit = r.hit;
      releasedParts.push(r.released);
    }
    expect(hit).toBe("OpenAI API Key");
    const releasedAll = Buffer.concat(releasedParts);
    expect(releasedAll.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(releasedAll.includes(secret)).toBe(false);
  });
});

describe("binary bytes", () => {
  test("non-UTF8 bytes: latin1 identity on clean path", () => {
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xff, 0x00, 0xfe]);
    const m = new SecretStreamMatcher();
    const r = m.push(gbk);
    expect(r.hit).toBeNull();
    const fin = m.finish();
    expect(Buffer.concat([r.released, fin.released]).equals(gbk)).toBe(true);
  });

  test("ASCII secret inside binary stream hits", () => {
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xff, 0x00, 0xfe]);
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const mixed = Buffer.concat([gbk, Buffer.from(secret, "latin1"), gbk]);
    const m = new SecretStreamMatcher();
    let hit: string | null = null;
    for (let off = 0; off < mixed.length; off += 3) {
      const r = m.push(mixed.subarray(off, Math.min(off + 3, mixed.length)));
      hit = hit ?? r.hit;
    }
    hit = hit ?? m.finish().hit;
    expect(hit).toBe("AWS Access Key");
  });
});

describe("post-hit behavior", () => {
  test("pushes after hit short-circuit with empty released", () => {
    const m = new SecretStreamMatcher();
    expect(m.push(Buffer.from(`sk-${"e".repeat(32)}`, "latin1")).hit).toBe("OpenAI API Key");
    const r = m.push(Buffer.from("more data", "latin1"));
    expect(r.hit).toBe("OpenAI API Key");
    expect(r.released.length).toBe(0);
  });

  test("constants", () => {
    expect(QUARANTINE_BYTES).toBe(8192);
    expect(COMMAND_OUTPUT_FALLBACK_PREVIEW_BYTES).toBe(65536);
    expect(QUARANTINE_OVERFLOW_HIT).toBe("quarantine-overflow");
  });
});
