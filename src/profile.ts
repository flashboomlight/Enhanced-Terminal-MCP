/**
 * 执行 profile 与 capability policy。
 *
 * profile 在启动时固定；本文件不实现 OS sandbox，只在 capability/backend 不可用时 fail-closed。
 */
import type {
  Capability,
  CapabilityDecision,
  CapabilityPolicy,
  ExecutionProfile,
  RequestContext,
  RequestHandlerExtraLike,
} from "./hardening-contract.js";

export interface ProfileAvailability {
  localTrustedShell: boolean;
  sandboxedProduction: boolean;
}

export const DEFAULT_PROFILE_AVAILABILITY: Readonly<ProfileAvailability> = {
  localTrustedShell: true,
  sandboxedProduction: false,
};

export const LOCAL_TRUSTED_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "shell-execution",
  "argv-execution",
  "host-process-inspection",
  "host-environment-read",
  "network-egress",
  "filesystem-write",
]);

let activeProfile: ExecutionProfile | null = null;

export type ProfileErrorCode = "CONFIG_INVALID" | "SANDBOX_UNAVAILABLE";

export interface ProfileError extends Error {
  readonly code: ProfileErrorCode;
  readonly param?: string;
  readonly profile?: ExecutionProfile;
}

function profileError(
  code: ProfileErrorCode,
  message: string,
  param?: string,
  profile?: ExecutionProfile,
): ProfileError {
  const error = new Error(message) as ProfileError;
  Object.defineProperty(error, "name", { value: "ProfileError", configurable: true });
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  if (param) Object.defineProperty(error, "param", { value: param, enumerable: true });
  if (profile) Object.defineProperty(error, "profile", { value: profile, enumerable: true });
  return error;
}

/**
 * 读取启动 profile；未设置保持现有本机 shell 行为，显式非法值直接失败。
 */
export function readExecutionProfile(env: Record<string, string | undefined> = process.env): ExecutionProfile {
  const raw = env.MCP_EXECUTION_PROFILE;
  if (raw === undefined) return "local-trusted-shell";
  const value = raw.trim();
  if (value === "local-trusted-shell" || value === "sandboxed-production") return value;
  throw profileError(
    "CONFIG_INVALID",
    "MCP_EXECUTION_PROFILE must be local-trusted-shell or sandboxed-production",
    "MCP_EXECUTION_PROFILE",
  );
}

/**
 * 检查 profile 的 backend 是否已准备好；不可用时不允许静默回退。
 */
export function assertProfileAvailable(
  profile: ExecutionProfile,
  availability: ProfileAvailability = DEFAULT_PROFILE_AVAILABILITY,
): void {
  const available =
    profile === "local-trusted-shell" ? availability.localTrustedShell : availability.sandboxedProduction;
  if (available) return;
  throw profileError("SANDBOX_UNAVAILABLE", `Execution profile is unavailable: ${profile}`, undefined, profile);
}

/** 初始化并冻结进程级 profile；启动后不再从 process.env 重新读取。 */
export function initializeExecutionProfile(
  env: Record<string, string | undefined> = process.env,
  availability: ProfileAvailability = DEFAULT_PROFILE_AVAILABILITY,
): ExecutionProfile {
  const profile = readExecutionProfile(env);
  if (activeProfile !== null) {
    if (activeProfile !== profile) {
      throw profileError(
        "CONFIG_INVALID",
        "Execution profile cannot change after initialization",
        "MCP_EXECUTION_PROFILE",
      );
    }
    return activeProfile;
  }
  assertProfileAvailable(profile, availability);
  activeProfile = profile;
  return profile;
}

/** 获取已经初始化的 profile；仅供未经过 main 的直接单元调用提供兼容 fallback。 */
export function getActiveExecutionProfile(): ExecutionProfile {
  return activeProfile ?? initializeExecutionProfile();
}

/**
 * 将 MCP SDK handler extra 转换为不可由 arguments 覆盖的请求上下文。
 */
export function createRequestContext(
  extra: RequestHandlerExtraLike,
  profile: ExecutionProfile,
  fallbackScopeId = "process",
): RequestContext {
  return {
    requestId: extra.requestId,
    scopeId: extra.sessionId ?? fallbackScopeId,
    profile,
    signal: extra.signal,
    ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
    ...(extra.authInfo !== undefined ? { authInfo: extra.authInfo } : {}),
  };
}

/**
 * 创建默认 capability policy；sandbox profile 仅允许宿主启动时声明的 capability。
 */
export function createCapabilityPolicy(hostCapabilities: Iterable<Capability> = []): CapabilityPolicy {
  const declared = new Set(hostCapabilities);
  return {
    check(context: RequestContext, capability: Capability): CapabilityDecision {
      if (context.profile === "local-trusted-shell") {
        return { allowed: LOCAL_TRUSTED_CAPABILITIES.has(capability) };
      }
      if (declared.has(capability)) return { allowed: true };
      return {
        allowed: false,
        code: "CAPABILITY_DENIED",
        reason: `Capability is not declared by the ${context.profile} host`,
      };
    },
  };
}
