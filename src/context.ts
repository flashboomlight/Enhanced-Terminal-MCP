/**
 * 上下文注入 — session state 自动注入到工具 description
 * LLM 无需额外查询即可感知当前 cwd 和环境上下文
 *
 * NOTE: 当前被 usage-guide prompt 使用，用于注入会话上下文。
 * 也可用于后续动态 description 更新。
 */
import { session } from "./session.js";

/**
 * 获取上下文增强后缀
 * 追加到工具 description 末尾
 */
export function contextSuffix(): string {
  const s = session.get();
  const parts: string[] = [];
  parts.push(`\n[Session: cwd="${s.cwd}"`);
  if (Object.keys(s.env).length > 0) {
    const envKeys = Object.keys(s.env).join(", ");
    parts.push(`env={${envKeys}}`);
  }
  if (s.history.length > 0) {
    const lastCmd = s.history[s.history.length - 1];
    parts.push(`last_cmd="${lastCmd.slice(0, 60)}"`);
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
