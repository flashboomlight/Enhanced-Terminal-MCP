/**
 * 上下文注入 — session state 自动注入到工具 description
 * LLM 无需额外查询即可感知当前 cwd 和环境上下文
 *
 * NOTE: 当前被 usage-guide prompt 使用，用于注入会话上下文。
 * 也可用于后续动态 description 更新。
 */
import { sanitizeLogField } from "./secret-governance.js";
import { session } from "./session.js";

/**
 * 获取上下文增强后缀
 * 追加到工具 description 末尾；注入字段（cwd/env key/last_cmd）统一过 sanitizeLogField，
 * 命令原文不进入 prompt（redact + 控制字符转义 + 截断）。
 */
export function contextSuffix(): string {
  const s = session.get();
  const parts: string[] = [];
  parts.push(`\n[Session: cwd="${sanitizeLogField(s.cwd, 256)}"`);
  if (Object.keys(s.env).length > 0) {
    const envKeys = Object.keys(s.env)
      .map((k) => sanitizeLogField(k, 64))
      .join(", ");
    parts.push(`env={${envKeys}}`);
  }
  if (s.history.length > 0) {
    const lastCmd = sanitizeLogField(s.history[s.history.length - 1], 64);
    parts.push(`last_cmd="${lastCmd}"`);
  }
  parts.push("]");
  return parts.join(" ");
}

/**
 * 增强工具 description，注入会话上下文
 */
export function injectContext(description: string): string {
  return description + contextSuffix();
}
