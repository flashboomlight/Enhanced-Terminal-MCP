/**
 * 进程身份探测与安全终止适配器。
 *
 * 该模块只允许对已经取得并重新验证 identity proof 的 PID 做终止；
 * 不把进程名交给操作系统的 wildcard/name matching 语义。
 */
import { readdir, readFile } from "node:fs/promises";
import { IS_LINUX, IS_MAC, IS_WIN } from "./platform.js";
import { ErrorCode, Errors, fail, type ToolError } from "./result.js";
import { isCriticalProcess } from "./safeguard.js";
import { getShellSpec, powerShellTarget } from "./shell.js";
import { safeExecFile } from "./utils.js";

const MAX_PROCESS_NAME_CHARS = 128;
const MAX_PROCESS_NAME_BYTES = 512;
const MAX_PROCESS_ID = 2_147_483_647;
const MAX_PROCESS_SCAN = 10_000;
const PROCESS_EXIT_WAIT_MS = 1_000;
const PROCESS_PROBE_TIMEOUT_MS = 5_000;
const PROCESS_TERMINATE_TIMEOUT_MS = 10_000;

export interface KillTarget {
  pid?: number;
  exactName?: string;
  force: boolean;
}

export interface ProcessIdentity {
  pid: number;
  name: string;
  startedAt: number;
  token: string;
  ownedByCurrentWorker: boolean;
  processGroupId?: number;
}

export interface ProcessIdentityProvider {
  findByExactName(name: string): Promise<ProcessIdentity[]>;
  inspectPid(pid: number): Promise<ProcessIdentity | ToolError>;
  terminate(identity: ProcessIdentity, force: boolean, tree: boolean): Promise<ProcessTerminationResult>;
}

export type ProcessTerminationResult = undefined | ToolError;

/** provider 无法可靠取得身份数据时使用的内部错误，不携带原始命令/系统输出。 */
class ProcessIdentityProbeError extends Error {
  constructor(readonly operation: string) {
    super(`Process identity probe failed: ${operation}`);
    this.name = "ProcessIdentityProbeError";
  }
}

/** 判断一个值是否为统一的 ToolError。 */
export function isToolError(value: unknown): value is ToolError {
  return Boolean(value && typeof value === "object" && "ok" in value && (value as { ok?: unknown }).ok === false);
}

/** 判断错误是否明确表示目标 PID 已不存在。 */
function isNotFoundError(value: unknown): value is ToolError {
  return isToolError(value) && value.error.code === ErrorCode.NOT_FOUND;
}

/** 统一生成不泄露原始输入的 identity 歧义错误。 */
function identityAmbiguous(targetKind: "pid" | "name", reason: string): ToolError {
  return Errors.processIdentityAmbiguous("Unable to establish a unique process identity", {
    target_kind: targetKind,
    reason,
  });
}

/** 统一生成 provider 终止失败错误。 */
function terminationFailed(targetKind: "pid" | "name", tree: boolean, reason: string): ToolError {
  if (tree) {
    return Errors.processTreeTerminationFailed("Verified process tree termination did not complete", {
      target_kind: targetKind,
      reason,
    });
  }
  return Errors.executionFailed("Verified process termination failed", {
    target_kind: targetKind,
    reason,
  });
}

/** 生成目标不存在错误。 */
function processNotFound(param: "pid" | "name"): ToolError {
  return fail(ErrorCode.NOT_FOUND, "Process not found", {
    retryable: true,
    param,
  });
}

/** 规范化 Windows 的 .exe 别名，Unix 保留实际名称语义。 */
export function normalizeProcessName(name: string, windows = IS_WIN): string {
  if (windows && name.toLowerCase().endsWith(".exe")) return name.slice(0, -4);
  return name;
}

/** 检查进程名是否是有界、无控制字符和无路径/wildcard 语义的 basename。 */
export function isExactProcessNameValid(name: string): boolean {
  if (name.length === 0 || name.trim() !== name) return false;
  if (Array.from(name).length > MAX_PROCESS_NAME_CHARS || Buffer.byteLength(name, "utf8") > MAX_PROCESS_NAME_BYTES) {
    return false;
  }
  for (const character of name) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  return !/[\\/:*?"<>|]/u.test(name) && normalizeProcessName(name).length > 0;
}

/** 检查 provider 返回的 identity 是否具备可用于终止的最小 proof 字段。 */
export function isProcessIdentityValid(identity: ProcessIdentity): boolean {
  return (
    Number.isSafeInteger(identity.pid) &&
    identity.pid >= 1 &&
    identity.pid <= MAX_PROCESS_ID &&
    isExactProcessNameValid(identity.name) &&
    Number.isSafeInteger(identity.startedAt) &&
    identity.token.length > 0 &&
    typeof identity.ownedByCurrentWorker === "boolean" &&
    (identity.processGroupId === undefined ||
      (Number.isSafeInteger(identity.processGroupId) && identity.processGroupId >= 1))
  );
}

/** 严格解析 kill_process 输入，拒绝空目标、双目标、wildcard 和路径字符。 */
export function parseKillTarget(input: { pid?: unknown; name?: unknown; force?: unknown }): KillTarget | ToolError {
  const hasPid = input.pid !== undefined;
  const hasName = input.name !== undefined;
  if (hasPid === hasName) {
    return Errors.validationError("Provide exactly one of pid or name", "pid");
  }

  let pid: number | undefined;
  if (hasPid) {
    if (
      typeof input.pid !== "number" ||
      !Number.isSafeInteger(input.pid) ||
      input.pid < 1 ||
      input.pid > MAX_PROCESS_ID
    ) {
      return Errors.validationError("pid must be a finite integer between 1 and 2147483647", "pid");
    }
    pid = input.pid;
  }

  let exactName: string | undefined;
  if (hasName) {
    if (typeof input.name !== "string") return Errors.validationError("name must be a string", "name");
    const name = input.name;
    if (!isExactProcessNameValid(name)) {
      return Errors.validationError(
        "name must be an exact process basename without wildcard or path characters",
        "name",
      );
    }
    exactName = name;
  }

  const force = input.force === undefined ? false : input.force;
  if (typeof force !== "boolean") return Errors.validationError("force must be boolean", "force");
  return { ...(pid !== undefined ? { pid } : { exactName }), force };
}

/** 判断 identity 是否指向当前 server 或当前 server 的 parent。 */
export function isProtectedProcessIdentity(identity: ProcessIdentity): boolean {
  return identity.ownedByCurrentWorker || identity.pid === process.pid || identity.pid === process.ppid;
}

/** 比较两个 identity 是否仍然代表同一个进程实例。 */
export function sameProcessIdentity(expected: ProcessIdentity, actual: ProcessIdentity): boolean {
  return (
    expected.pid === actual.pid &&
    expected.token === actual.token &&
    normalizeProcessName(expected.name) === normalizeProcessName(actual.name)
  );
}

/** 将平台记录转成 identity，并检查所有 proof 字段的基本边界。 */
function toProcessIdentity(
  pidValue: unknown,
  nameValue: unknown,
  startedAtValue: unknown,
  tokenPrefix: string,
  processGroupIdValue?: unknown,
): ProcessIdentity {
  const pid = typeof pidValue === "number" ? pidValue : Number(pidValue);
  const name = typeof nameValue === "string" ? nameValue : "";
  const startedText = typeof startedAtValue === "string" ? startedAtValue : String(startedAtValue ?? "");
  const startedAt = Number.isFinite(Number(startedAtValue)) ? Number(startedAtValue) : Date.parse(startedText);
  if (
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    pid > MAX_PROCESS_ID ||
    name.length === 0 ||
    !Number.isSafeInteger(startedAt)
  ) {
    throw new ProcessIdentityProbeError("invalid identity record");
  }
  const processGroupId =
    processGroupIdValue === undefined
      ? undefined
      : typeof processGroupIdValue === "number"
        ? processGroupIdValue
        : Number(processGroupIdValue);
  if (processGroupId !== undefined && (!Number.isSafeInteger(processGroupId) || processGroupId < 1)) {
    throw new ProcessIdentityProbeError("invalid process group");
  }
  const identity = {
    pid,
    name,
    startedAt,
    token: `${tokenPrefix}:${startedText}`,
    ownedByCurrentWorker: pid === process.pid,
    ...(processGroupId !== undefined ? { processGroupId } : {}),
  };
  if (!isProcessIdentityValid(identity)) throw new ProcessIdentityProbeError("invalid identity proof");
  return identity;
}

interface JsonIdentityRecord {
  pid?: unknown;
  name?: unknown;
  startedAt?: unknown;
  processGroupId?: unknown;
}

/** 解析 Windows provider 输出的 JSON identity 数组。 */
export function parseWindowsIdentityOutput(output: string): ProcessIdentity[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new ProcessIdentityProbeError("windows JSON");
  }
  const records = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
  if (records.length > MAX_PROCESS_SCAN) throw new ProcessIdentityProbeError("windows process scan limit");
  return records.map((record) => {
    if (!record || typeof record !== "object") throw new ProcessIdentityProbeError("windows record");
    const value = record as JsonIdentityRecord;
    return toProcessIdentity(value.pid, value.name, value.startedAt, "windows");
  });
}

const WINDOWS_FIND_SCRIPT = `& {
  param([string]$target)
  $ErrorActionPreference = 'Stop'
  $rows = @(
    Get-Process -ErrorAction Stop |
      Where-Object { [StringComparer]::OrdinalIgnoreCase.Equals($_.ProcessName, $target) } |
      ForEach-Object {
        try {
          [pscustomobject]@{
            pid = [int]$_.Id
            name = [string]$_.ProcessName
            startedAt = $_.StartTime.ToUniversalTime().ToString('o')
          }
        } catch { }
      }
  )
  if ($rows.Count -eq 0) { Write-Output '[]' } else { $rows | ConvertTo-Json -Compress }
}`;

const WINDOWS_INSPECT_SCRIPT = `& {
  param([int]$targetPid)
  $ErrorActionPreference = 'Stop'
  $result = [ordered]@{ status = 'unavailable'; items = @() }
  $process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    $result.status = 'not-found'
  } else {
    try {
      $result.items = @(
        $process | ForEach-Object {
          [pscustomobject]@{
            pid = [int]$_.Id
            name = [string]$_.ProcessName
            startedAt = $_.StartTime.ToUniversalTime().ToString('o')
          }
        }
      )
      $result.status = 'ok'
    } catch {
      $result.status = 'unavailable'
    }
  }
  $result | ConvertTo-Json -Compress
}`;

const WINDOWS_TERMINATE_SCRIPT = `& {
  param([int]$targetPid, [string]$expectedStart, [string]$forceText, [string]$treeText)
  $ErrorActionPreference = 'Stop'
  $result = [ordered]@{ status = 'failed' }
  $force = $forceText -ieq 'true'
  $tree = $treeText -ieq 'true'
  $process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    $result.status = 'not-found'
  } else {
    try {
      $actualStart = $process.StartTime.ToUniversalTime().ToString('o')
      if ($actualStart -ne $expectedStart) {
        $result.status = 'identity-mismatch'
      } elseif ($tree) {
        $killTree = [System.Diagnostics.Process].GetMethod('Kill', [type[]]@([bool]))
        if ($null -eq $killTree) {
          $result.status = 'tree-unsupported'
        } else {
          $process.Kill($true)
          $result.status = if ($process.WaitForExit(5000)) { 'ok' } else { 'timeout' }
        }
      } elseif ($force) {
        $process.Kill()
        $result.status = if ($process.WaitForExit(5000)) { 'ok' } else { 'timeout' }
      } elseif ($process.MainWindowHandle -ne 0) {
        [void]$process.CloseMainWindow()
        $result.status = if ($process.WaitForExit(5000)) { 'ok' } else { 'timeout' }
      } else {
        $result.status = 'graceful-unsupported'
      }
    } catch {
      $result.status = 'failed'
    }
  }
  $result | ConvertTo-Json -Compress
}`;

/** 以固定 PowerShell 脚本和 argv 参数执行 Windows identity 操作。 */
async function runWindowsScript(script: string, args: string[], timeout: number): Promise<string> {
  try {
    const shell = await getShellSpec();
    const target = powerShellTarget(shell);
    const result = await safeExecFile(target.file, [...target.baseArgs, "-Command", script, ...args], {
      timeout,
      kind: "identity-probe",
    });
    return result.stdout;
  } catch {
    throw new ProcessIdentityProbeError("windows command");
  }
}

/** 解析 Windows 终止脚本的有限状态集合。 */
function parseWindowsTerminationStatus(output: string): string {
  try {
    const parsed = JSON.parse(output.trim()) as { status?: unknown };
    if (typeof parsed.status !== "string") throw new Error("missing status");
    return parsed.status;
  } catch {
    throw new ProcessIdentityProbeError("windows termination status");
  }
}

async function findWindowsByExactName(name: string): Promise<ProcessIdentity[]> {
  const target = normalizeProcessName(name, true);
  const output = await runWindowsScript(WINDOWS_FIND_SCRIPT, [target], PROCESS_PROBE_TIMEOUT_MS);
  return parseWindowsIdentityOutput(output).filter(
    (identity) => normalizeProcessName(identity.name, true).toLowerCase() === target.toLowerCase(),
  );
}

async function inspectWindowsPid(pid: number): Promise<ProcessIdentity | ToolError> {
  try {
    const output = await runWindowsScript(WINDOWS_INSPECT_SCRIPT, [String(pid)], PROCESS_PROBE_TIMEOUT_MS);
    const parsed = JSON.parse(output.trim()) as { status?: unknown; items?: unknown };
    if (parsed.status === "not-found") return processNotFound("pid");
    if (parsed.status !== "ok" || !Array.isArray(parsed.items)) {
      return identityAmbiguous("pid", "identity probe unavailable");
    }
    const identities = parseWindowsIdentityOutput(JSON.stringify(parsed.items));
    return identities[0] ?? processNotFound("pid");
  } catch (error) {
    if (error instanceof ProcessIdentityProbeError && error.operation === "windows command") {
      return identityAmbiguous("pid", "identity probe unavailable");
    }
    return identityAmbiguous("pid", "identity record unavailable");
  }
}

async function terminateWindowsIdentity(
  identity: ProcessIdentity,
  force: boolean,
  tree: boolean,
): Promise<ProcessTerminationResult> {
  if (!identity.token.startsWith("windows:")) return identityAmbiguous("pid", "unsupported identity token");
  const expectedStart = identity.token.slice("windows:".length);
  let status: string;
  try {
    const output = await runWindowsScript(
      WINDOWS_TERMINATE_SCRIPT,
      [String(identity.pid), expectedStart, String(force), String(tree)],
      PROCESS_TERMINATE_TIMEOUT_MS,
    );
    status = parseWindowsTerminationStatus(output);
  } catch {
    return terminationFailed("pid", tree, "platform termination call failed");
  }
  if (status === "not-found") return processNotFound("pid");
  if (status === "identity-mismatch") return identityAmbiguous("pid", "identity changed before termination");
  if (status === "tree-unsupported") return terminationFailed("pid", true, "tree termination unavailable");
  if (status === "graceful-unsupported") return terminationFailed("pid", false, "graceful termination unavailable");
  if (status !== "ok") return terminationFailed("pid", tree, status);

  const after = await inspectWindowsPid(identity.pid);
  if (isNotFoundError(after)) return;
  if (isToolError(after)) return terminationFailed("pid", tree, "post-termination identity probe failed");
  if (!sameProcessIdentity(identity, after)) return identityAmbiguous("pid", "identity changed after termination");
  return terminationFailed("pid", tree, "target remains alive");
}

interface ProcStat {
  pid: number;
  name: string;
  state: string;
  processGroupId: number;
  startTicks: number;
}

/** 解析 Linux /proc/{pid}/stat，处理 comm 中可能出现的空格和右括号。 */
export function parseProcStat(input: string): ProcStat {
  const open = input.indexOf("(");
  const close = input.lastIndexOf(")");
  if (open <= 0 || close <= open) throw new ProcessIdentityProbeError("linux proc stat shape");
  const pid = Number(input.slice(0, open));
  const name = input.slice(open + 1, close);
  const fields = input
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  const processGroupId = Number(fields[2]);
  const startTicks = Number(fields[19]);
  if (
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    name.length === 0 ||
    typeof fields[0] !== "string" ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId < 1 ||
    !Number.isSafeInteger(startTicks) ||
    startTicks < 0
  ) {
    throw new ProcessIdentityProbeError("linux proc stat fields");
  }
  return { pid, name, state: fields[0], processGroupId, startTicks };
}

function isNotFoundFsError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT",
  );
}

async function inspectLinuxPid(pid: number): Promise<ProcessIdentity | ToolError> {
  try {
    const stat = parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
    if (stat.pid !== pid) return identityAmbiguous("pid", "PID probe mismatch");
    return {
      pid: stat.pid,
      name: stat.name,
      startedAt: stat.startTicks,
      token: `linux:${stat.startTicks}`,
      ownedByCurrentWorker: pid === process.pid,
      processGroupId: stat.processGroupId,
    };
  } catch (error) {
    if (isNotFoundFsError(error)) return processNotFound("pid");
    if (error instanceof ProcessIdentityProbeError) return identityAmbiguous("pid", "invalid /proc identity");
    return identityAmbiguous("pid", "identity probe unavailable");
  }
}

async function findLinuxByExactName(name: string): Promise<ProcessIdentity[]> {
  const entries = await readdir("/proc", { withFileTypes: true });
  const numericEntries = entries.filter((entry) => /^\d+$/u.test(entry.name));
  if (numericEntries.length > MAX_PROCESS_SCAN) throw new ProcessIdentityProbeError("linux process scan limit");
  const target = normalizeProcessName(name, false);
  const matches: ProcessIdentity[] = [];
  let probeFailure = false;
  for (const entry of numericEntries) {
    const pid = Number(entry.name);
    try {
      const identity = await inspectLinuxPid(pid);
      if (isToolError(identity)) {
        if (!isNotFoundError(identity)) probeFailure = true;
      } else if (normalizeProcessName(identity.name, false) === target) {
        matches.push(identity);
      }
    } catch {
      probeFailure = true;
    }
  }
  if (matches.length === 0 && probeFailure) throw new ProcessIdentityProbeError("linux identity enumeration");
  return matches;
}

interface PsIdentityLine {
  pid: number;
  name: string;
  startedAt: string;
  processGroupId: number;
}

/** 解析 macOS ps 的 pid/comm/lstart/pgid 固定列输出。 */
export function parsePsIdentityOutput(output: string): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\S+)\s+(.+?)\s+(\d+)$/u);
    if (!match) throw new ProcessIdentityProbeError("macOS ps record");
    const record: PsIdentityLine = {
      pid: Number(match[1]),
      name: match[2],
      startedAt: match[3].trim(),
      processGroupId: Number(match[4]),
    };
    identities.push(toProcessIdentity(record.pid, record.name, record.startedAt, "macos", record.processGroupId));
    if (identities.length > MAX_PROCESS_SCAN) throw new ProcessIdentityProbeError("macOS process scan limit");
  }
  return identities;
}

async function queryMacProcess(args: string[]): Promise<string> {
  try {
    return (
      await safeExecFile("ps", args, {
        timeout: PROCESS_PROBE_TIMEOUT_MS,
        kind: "identity-probe",
        tree: false,
      })
    ).stdout;
  } catch {
    throw new ProcessIdentityProbeError("macOS ps command");
  }
}

async function findMacByExactName(name: string): Promise<ProcessIdentity[]> {
  const output = await queryMacProcess(["-axo", "pid=,comm=,lstart=,pgid="]);
  const target = normalizeProcessName(name, false);
  return parsePsIdentityOutput(output).filter((identity) => identity.name === target);
}

async function inspectMacPid(pid: number): Promise<ProcessIdentity | ToolError> {
  try {
    const output = await queryMacProcess(["-p", String(pid), "-o", "pid=,comm=,lstart=,pgid="]);
    return parsePsIdentityOutput(output)[0] ?? processNotFound("pid");
  } catch (error) {
    if (error instanceof ProcessIdentityProbeError && error.operation === "macOS ps command") {
      return identityAmbiguous("pid", "identity probe unavailable");
    }
    return identityAmbiguous("pid", "invalid ps identity");
  }
}

async function getLinuxProcessGroupId(): Promise<number | null> {
  try {
    const stat = parseProcStat(await readFile(`/proc/${process.pid}/stat`, "utf8"));
    return stat.processGroupId;
  } catch {
    return null;
  }
}

async function getMacProcessGroupId(): Promise<number | null> {
  try {
    const output = await queryMacProcess(["-p", String(process.pid), "-o", "pgid="]);
    const group = Number(output.trim());
    return Number.isSafeInteger(group) && group > 0 ? group : null;
  } catch {
    return null;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForUnixIdentityExit(
  expected: ProcessIdentity,
  inspect: (pid: number) => Promise<ProcessIdentity | ToolError>,
  tree: boolean,
): Promise<ProcessTerminationResult> {
  const deadline = Date.now() + PROCESS_EXIT_WAIT_MS;
  while (Date.now() < deadline) {
    const current = await inspect(expected.pid);
    if (isNotFoundError(current)) return;
    if (isToolError(current)) return terminationFailed("pid", tree, "post-termination identity probe failed");
    if (!sameProcessIdentity(expected, current)) return identityAmbiguous("pid", "identity changed after termination");
    await delay(25);
  }
  return terminationFailed("pid", tree, "target remains alive");
}

async function terminateUnixIdentity(
  identity: ProcessIdentity,
  force: boolean,
  tree: boolean,
  inspect: (pid: number) => Promise<ProcessIdentity | ToolError>,
  ownGroup: () => Promise<number | null>,
): Promise<ProcessTerminationResult> {
  const current = await inspect(identity.pid);
  if (isToolError(current)) return current;
  if (!sameProcessIdentity(identity, current)) return identityAmbiguous("pid", "identity changed before termination");

  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    if (tree) {
      const group = current.processGroupId;
      if (group === undefined || group <= 1) return terminationFailed("pid", true, "process group proof unavailable");
      const own = await ownGroup();
      if (own !== null && own === group) {
        return fail(ErrorCode.PROCESS_PROTECTED, "Cannot terminate the current process group", {
          retryable: false,
          param: "pid",
        });
      }
      process.kill(-group, signal);
    } else {
      process.kill(current.pid, signal);
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    return terminationFailed(
      "pid",
      tree,
      code === "ESRCH" ? "target disappeared during termination" : "termination signal failed",
    );
  }
  return waitForUnixIdentityExit(identity, inspect, tree);
}

async function terminateLinuxIdentity(
  identity: ProcessIdentity,
  force: boolean,
  tree: boolean,
): Promise<ProcessTerminationResult> {
  return terminateUnixIdentity(identity, force, tree, inspectLinuxPid, getLinuxProcessGroupId);
}

async function terminateMacIdentity(
  identity: ProcessIdentity,
  force: boolean,
  tree: boolean,
): Promise<ProcessTerminationResult> {
  return terminateUnixIdentity(identity, force, tree, inspectMacPid, getMacProcessGroupId);
}

class DefaultProcessIdentityProvider implements ProcessIdentityProvider {
  async findByExactName(name: string): Promise<ProcessIdentity[]> {
    if (IS_WIN) return findWindowsByExactName(name);
    if (IS_LINUX) return findLinuxByExactName(name);
    if (IS_MAC) return findMacByExactName(name);
    throw new ProcessIdentityProbeError("unsupported platform");
  }

  async inspectPid(pid: number): Promise<ProcessIdentity | ToolError> {
    if (IS_WIN) return inspectWindowsPid(pid);
    if (IS_LINUX) return inspectLinuxPid(pid);
    if (IS_MAC) return inspectMacPid(pid);
    return identityAmbiguous("pid", "unsupported platform");
  }

  async terminate(identity: ProcessIdentity, force: boolean, tree: boolean): Promise<ProcessTerminationResult> {
    if (IS_WIN) return terminateWindowsIdentity(identity, force, tree);
    if (IS_LINUX) return terminateLinuxIdentity(identity, force, tree);
    if (IS_MAC) return terminateMacIdentity(identity, force, tree);
    return terminationFailed("pid", tree, "unsupported platform");
  }
}

export const defaultProcessIdentityProvider: ProcessIdentityProvider = new DefaultProcessIdentityProvider();

/** 返回输入/identity 侧的保护结果，供系统工具在 provider 副作用前调用。 */
export function isProtectedInput(name: string | undefined, pid: number | undefined): boolean {
  const windowsAlias = IS_WIN && name && !name.toLowerCase().endsWith(".exe") ? `${name}.exe` : undefined;
  return (
    isCriticalProcess(name, pid) ||
    (windowsAlias !== undefined && isCriticalProcess(windowsAlias, pid)) ||
    pid === process.pid ||
    pid === process.ppid
  );
}
