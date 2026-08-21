/**
 * 流式 secret 候选状态机 — 在原始字节(latin1 恒等)上增量匹配
 *
 * 只释放"已证明安全"的前缀:从最早活候选起点起的字节全部保留在 pending(quarantine)。
 * 活候选 = 从该位置起到 pending 末尾整段是某 pattern 的合法前缀(sticky regex + 串尾断言)。
 * 未决候选每流至多保留 QUARANTINE_BYTES;超限 fail-closed 判命中(保守超集:宁可误报不可漏报)。
 * 完整命中检测与 scanContent 共用 registry 中的同一 regex 对象,whole-string 与流式语义同源。
 */
import { SECRET_PATTERN_DEFS, STREAM_PATTERN_DERIVATION } from "./secret-registry.js";

/** 每流 quarantine 固定字节数(内部常量,不开放环境变量) */
export const QUARANTINE_BYTES = 8192;

/** 每流 fallback preview 保留的 scanner 已释放安全前缀字节数(内部常量) */
export const COMMAND_OUTPUT_FALLBACK_PREVIEW_BYTES = 65536;

/** quarantine 未决超限 fail-closed 时的命中名 */
export const QUARANTINE_OVERFLOW_HIT = "quarantine-overflow";

export interface SecretStreamPushResult {
  /** 本步证明安全、可进入 retention/fallback 的字节(命中后恒为空) */
  released: Buffer;
  /** 命中的 pattern 名或 QUARANTINE_OVERFLOW_HIT;未命中为 null */
  hit: string | null;
}

export class SecretStreamMatcher {
  private pending = "";
  private hitName: string | null = null;

  /** 当前命中名(未命中为 null) */
  get hit(): string | null {
    return this.hitName;
  }

  /** 喂入一个原始字节 chunk;返回新证明安全的字节与命中状态 */
  push(chunk: Buffer): SecretStreamPushResult {
    if (this.hitName !== null) return { released: Buffer.alloc(0), hit: this.hitName };
    this.pending += chunk.toString("latin1");
    const hit = this.fullScan();
    if (hit !== null) return { released: Buffer.alloc(0), hit };
    const start = this.firstLiveCandidateStart();
    const safe = start === -1 ? this.pending : this.pending.slice(0, start);
    this.pending = start === -1 ? "" : this.pending.slice(start);
    if (this.pending.length > QUARANTINE_BYTES) {
      this.hitName = QUARANTINE_OVERFLOW_HIT;
      this.pending = "";
      return { released: Buffer.alloc(0), hit: this.hitName };
    }
    return { released: Buffer.from(safe, "latin1"), hit: null };
  }

  /** 流结束:EOF 解析短候选——完整 regex 最终判定,未命中则全部释放(与 scanContent 语义一致) */
  finish(): SecretStreamPushResult {
    if (this.hitName !== null) return { released: Buffer.alloc(0), hit: this.hitName };
    const hit = this.fullScan();
    if (hit !== null) return { released: Buffer.alloc(0), hit };
    const safe = this.pending;
    this.pending = "";
    return { released: Buffer.from(safe, "latin1"), hit: null };
  }

  /** 完整命中检测:pending 上跑全部 pattern(同一 regex 对象,无 g flag 无 lastIndex 副作用) */
  private fullScan(): string | null {
    if (this.hitName !== null) return this.hitName;
    for (const def of SECRET_PATTERN_DEFS) {
      if (def.regex.test(this.pending)) {
        this.hitName = def.name;
        this.pending = "";
        return this.hitName;
      }
    }
    return null;
  }

  /** 最早的活候选起点;无候选返回 -1 */
  private firstLiveCandidateStart(): number {
    const { firstBytes, stickySensitive, stickyInsensitive } = STREAM_PATTERN_DERIVATION;
    const s = this.pending;
    for (let i = 0; i < s.length; i++) {
      if (!firstBytes.has(s[i])) continue;
      if (stickySensitive !== null) {
        stickySensitive.lastIndex = i;
        if (stickySensitive.test(s)) return i;
      }
      if (stickyInsensitive !== null) {
        stickyInsensitive.lastIndex = i;
        if (stickyInsensitive.test(s)) return i;
      }
    }
    return -1;
  }
}
