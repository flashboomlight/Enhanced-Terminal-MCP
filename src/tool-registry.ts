/**
 * 工具注册记账 —— 真实启用计数的唯一真源
 *
 * roadmap §5.7 ToolRegistry：tool count 必须来自最终启用的 registry，
 * 而不是"曾经调用过多少次 wrapper"。这里保存 name → RegisteredTool 句柄，
 * 启用数直接读取 SDK 句柄上的 enabled 标志（disable/enable 即时反映）。
 */
import type { McpServer, RegisteredTool, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

const registeredTools = new Map<string, RegisteredTool>();

/** 与 McpServer.registerTool 完全一致的注册入参形状（显式镜像，泛型不丢类型） */
interface ManagedToolConfig<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
> {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

/**
 * 注册工具并记账；签名与 server.registerTool 一致（仅多出 server 首参）。
 * 工具文件统一经此入口注册，保证计数与 SDK 启用状态同源。
 */
export function registerManagedTool<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
  server: McpServer,
  name: string,
  config: ManagedToolConfig<OutputArgs, InputArgs>,
  cb: ToolCallback<InputArgs>,
): RegisteredTool {
  const tool = server.registerTool(name, config, cb);
  registeredTools.set(name, tool);
  return tool;
}

/** 当前启用（enabled === true）的工具数；banner/health/prompt 的唯一计数来源 */
export function getRegisteredToolCount(): number {
  let count = 0;
  for (const tool of registeredTools.values()) {
    if (tool.enabled) count++;
  }
  return count;
}

/** 当前启用工具名（按注册顺序，只读） */
export function getEnabledToolNames(): readonly string[] {
  const names: string[] = [];
  for (const [name, tool] of registeredTools) {
    if (tool.enabled) names.push(name);
  }
  return names;
}

/** 全部已注册（含禁用）工具名，测试诊断用 */
export function getAllRegisteredToolNames(): readonly string[] {
  return [...registeredTools.keys()];
}

/** 清空记账（仅供单元测试隔离模块级状态） */
export function resetToolRegistryForTests(): void {
  registeredTools.clear();
}
