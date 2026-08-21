/**
 * secret pattern 共享注册表 — scanContent(whole-string)与流式 matcher 的单一来源
 *
 * 每条 pattern 除完整 regex 外,额外声明:
 * - heads: 完整匹配串必然以其之一开头的固定字面前缀
 * - tail: 去掉 head 后的剩余 pattern source,量词放宽为前缀闭合({n,} → *,分隔段改可选)
 * 流式候选状态机据此机械生成 sticky 前缀 regex 与首字节集合,避免第二份可漂移的 pattern 定义;
 * tests/unit/secret-registry.test.ts 用"完整匹配串的任意前缀都是活候选"属性测试防漂移。
 */

export interface SecretPatternDef {
  name: string;
  /** 完整匹配 regex;scanContent 与流式命中检测共用同一对象 */
  regex: RegExp;
  /** 完整匹配串必然以其之一开头的固定字面前缀 */
  heads: readonly string[];
  /** 前缀闭合的剩余 pattern source;空串表示 head 本身即完整匹配 */
  tail: string;
  /** 大小写不敏感(与 regex 的 i flag 一致) */
  iFlag?: boolean;
}

export const SECRET_PATTERN_DEFS: readonly SecretPatternDef[] = [
  {
    name: "OpenAI API Key",
    regex: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/,
    heads: ["sk-", "sk-proj-"],
    tail: "[A-Za-z0-9]*",
  },
  {
    name: "GitHub Token",
    regex: /\bgh[ps]_[A-Za-z0-9_]{20,}\b/,
    heads: ["ghp_", "ghs_"],
    tail: "[A-Za-z0-9_]*",
  },
  {
    name: "AWS Access Key",
    regex: /\bAKIA[0-9A-Z]{16}\b/,
    heads: ["AKIA"],
    tail: "[0-9A-Z]*",
  },
  {
    name: "AWS Secret Key",
    regex: /(?:aws_secret_access_key|secret_key|SecretAccessKey)\s*[:=]\s*["']?[0-9a-zA-Z/+]{40}["']?/i,
    heads: ["aws_secret_access_key", "secret_key", "SecretAccessKey"],
    tail: "\\s*[:=]?\\s*[\"']?[0-9a-zA-Z/+]*[\"']?",
    iFlag: true,
  },
  {
    name: "Private Key Header",
    regex: /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----/,
    heads: [
      "-----BEGIN RSA PRIVATE KEY-----",
      "-----BEGIN EC PRIVATE KEY-----",
      "-----BEGIN DSA PRIVATE KEY-----",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "-----BEGIN PGP PRIVATE KEY-----",
    ],
    tail: "",
  },
  {
    name: "JWT Token",
    regex: /\beyJ[A-Za-z0-9-_=]{10,}\.[A-Za-z0-9-_=]{10,}\.?[A-Za-z0-9-_.+/=]*/,
    heads: ["eyJ"],
    tail: "[A-Za-z0-9-_=]*\\.?[A-Za-z0-9-_=]*\\.?[A-Za-z0-9-_.+/=]*",
  },
  {
    name: "Slack Token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    heads: ["xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-"],
    tail: "[A-Za-z0-9-]*",
  },
  {
    name: "Generic API Key",
    regex: /\bapi[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_-]{32,}["']?/i,
    heads: ["apikey", "api-key", "api_key"],
    tail: "\\s*[:=]?\\s*[\"']?[A-Za-z0-9_-]*[\"']?",
    iFlag: true,
  },
  {
    name: "Connection String",
    regex: /(?:mongodb|mysql|postgres|redis):\/\/[^:\s]{1,128}:[^@\s]{1,128}@(?!localhost|127\.0\.0\.1)[^\s]{1,256}/i,
    heads: ["mongodb://", "mysql://", "postgres://", "redis://"],
    tail: "[^:\\s]*:?[^@\\s]*@?[^\\s]*",
    iFlag: true,
  },
  {
    name: "Discord Token",
    regex: /\b[MN][A-Za-z0-9]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}\b/,
    heads: ["M", "N"],
    tail: "[A-Za-z0-9]*\\.?[A-Za-z0-9_-]*\\.?[A-Za-z0-9_-]*",
  },
];

const REGEX_SPECIALS = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

/** regex 特殊字符转义(把 head 字面量安全拼入分支 source) */
function escapeRegExp(text: string): string {
  let out = "";
  for (const ch of text) out += REGEX_SPECIALS.has(ch) ? `\${ch}` : ch;
  return out;
}

/** 单条 pattern 的候选分支:head 的全部长度前缀 + 完整 head+tail(tail 空时完整 head 已含于前缀) */
function branchesOf(def: SecretPatternDef): string[] {
  const branches = new Set<string>();
  for (const head of def.heads) {
    for (let i = 1; i <= head.length; i++) {
      branches.add(escapeRegExp(head.slice(0, i)));
    }
    if (def.tail !== "") {
      branches.add(`(?:${escapeRegExp(head)})${def.tail}`);
    }
  }
  return [...branches];
}

export interface StreamPatternDerivation {
  /** 候选前缀 sticky regex(大小写敏感组);(?![^]) 断言匹配必须延伸至 pending 末尾 */
  stickySensitive: RegExp | null;
  /** 候选前缀 sticky regex(i-flag 组) */
  stickyInsensitive: RegExp | null;
  /** 候选首字节集合(latin1 单字符;i-flag pattern 贡献大小写两个变体) */
  firstBytes: ReadonlySet<string>;
}

/** 按大小写敏感性分组构造 sticky 候选 regex;无分支时返回 null */
function buildSticky(defs: readonly SecretPatternDef[], insensitive: boolean): RegExp | null {
  const branches: string[] = [];
  for (const def of defs) {
    if (Boolean(def.iFlag) !== insensitive) continue;
    branches.push(...branchesOf(def));
  }
  if (branches.length === 0) return null;
  return new RegExp(`(?:${branches.join("|")})(?![^])`, insensitive ? "yi" : "y");
}

/** 汇总全部 head 首字符(i-flag 含大小写变体)作为候选首字节集合 */
function buildFirstBytes(defs: readonly SecretPatternDef[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const def of defs) {
    for (const head of def.heads) {
      const first = head[0];
      set.add(first);
      if (def.iFlag) {
        set.add(first.toLowerCase());
        set.add(first.toUpperCase());
      }
    }
  }
  return set;
}

/** 流式 matcher 使用的派生候选结构(模块加载时机械生成一次) */
export const STREAM_PATTERN_DERIVATION: StreamPatternDerivation = {
  stickySensitive: buildSticky(SECRET_PATTERN_DEFS, false),
  stickyInsensitive: buildSticky(SECRET_PATTERN_DEFS, true),
  firstBytes: buildFirstBytes(SECRET_PATTERN_DEFS),
};

/** scanContent 的 whole-string 视图;与流式命中检测共用同一 regex 对象 */
export const SECRET_PATTERNS: readonly { name: string; regex: RegExp }[] = SECRET_PATTERN_DEFS.map((def) => ({
  name: def.name,
  regex: def.regex,
}));
