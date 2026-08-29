---
doc_type: feature-design
feature: 2026-08-29-linux-fd-search
status: approved
summary: 为 search_files 在非 Windows 平台接入可选 fd/fdfind 引擎加速（解析链：显式 env fail-closed → PATH fd → fdfind → 不可用走原生兜底），镜像 Everything 的 M3 可选运行时模式，不新增工具、不动安全核心
tags: [linux, search, fd, optional-runtime, cross-platform, fallback]
created: "2026-08-29"
---

# Linux fd 搜索加速 设计

## 1. 背景与目标

`search_files` 的平台不对称：Windows 有 Everything 引擎（亚 10ms），非 Windows 只有 `native-search.ts` 递归遍历（大目录树慢一个量级）。本 feature 在非 Windows 侧接入可选的 [fd](https://github.com/sharkdp/fd) 引擎，对标 Everything 的 M3 可选运行时模式（feature `2026-08-21-publish-es-optional`）。

**目标**：
- 非 Windows 上 `search_files` 自动使用 fd 加速（装上即加速，零配置）；
- fd 不可用时行为与现状逐字节一致（原生兜底）；
- 显式配置错误 fail-closed（同 Everything 显式路径语义）。

**非目标（防范围蔓延）**：
- 不新增 MCP 工具（`everything_search` 保持 Windows-only；fd 只是 `search_files` 的引擎层）；
- 不支持 plocate/locate 等其他后端；不接入 Windows（Windows 已有 Everything）；
- 不做 SHA-256 锁定——fd 来自系统包管理器/PATH，信任模型与既有 `grep` 调用一致（`src/tools/search.ts:421` 已 PATH 直调 grep）；运行期绝不下载；
- 不动 `native-search.ts`、不动 `everything_search`、不动安全核心。

## 2. 方案总览

```
search_files (非 Windows)
  └─ resolveFd()                       // 新增 src/fd-resolver.ts，进程级缓存
       ├─ ENHANCED_TERMINAL_FD_PATH    // 显式：fail-closed（不可用 → VALIDATION_ERROR）
       ├─ PATH: fd                     // 隐式
       ├─ PATH: fdfind                 // 隐式（Debian/Ubuntu 包名）
       └─ unavailable                  // 隐式：debug 日志后走原生兜底（现状行为）
  └─ fd 可用 → execFileManaged(fd, args) // 接入 supervisor/cancellation，镜像 Everything 执行段
       ├─ 成功 → 结果（stderr 非空 → complete=false + FD_PARTIAL_ERRORS warning）
       └─ 失败 → FD_EXEC_FAILED warning → 原生兜底（与 Everything 执行失败同语义）
  └─ 原生兜底（nativeSearchFiles，不变）
```

## 3. 模块设计

### 3.1 `src/fd-resolver.ts`（新增）

```ts
export const FD_PATH_ENV = "ENHANCED_TERMINAL_FD_PATH";
export type FdSource = "explicit" | "path";
export type FdResolution =
  | { available: true; source: FdSource; path: string }
  | { available: false; source: FdSource; diagnostic: FdDiagnostic };

export interface ResolveFdOptions {
  env?: NodeJS.ProcessEnv;
  which?: (name: string) => Promise<string | null>;   // 默认：PATH 扫描 + access(X_OK)，不 spawn
  probeVersion?: (file: string) => Promise<string | null>; // 默认：fd --version
}
export async function resolveFd(options?: ResolveFdOptions): Promise<FdResolution>;
export function resetFdResolverCache(): void; // 测试用
```

- **解析顺序**：`ENHANCED_TERMINAL_FD_PATH`（必须 isAbsolute + 是文件 + `--version` 探测成功；任一失败 → `available:false, source:"explicit"`，reason 区分 `explicit_path_missing/not_file/probe_failed`）→ `which("fd")` → `which("fdfind")`（探测失败记录 attempted 后继续）→ `available:false, source:"path"`（reason `fd_not_on_path`）。
- **进程级缓存**：镜像 `getShellSpec`——首次解析（成功或失败）后缓存到进程退出；改 env/装 fd 需重启；`resetFdResolverCache()` 供测试。
- **诊断不泄密**：diagnostic 只含 reason/env_name/source，不含 PATH 原值（沿 es-integrity 的 `attempted` 非敏感先例）。

### 3.2 `src/tools/search.ts` 的 search_files 改动（最小侵入）

在 `IS_WIN` 块之后、原生兜底之前插入 `!IS_WIN` 的 fd 段：

- resolution `available:false` 且 `source:"explicit"` → `fail(VALIDATION_ERROR, ..., param: "ENHANCED_TERMINAL_FD_PATH")`（复用 esResolutionFailure 的同构写法，新增 `fdResolutionFailure`）；
- `search_files` 的 `description` 同步补一句 fd（"...uses fd when available on Linux/macOS"）；`max_depth` 的 describe 微调为"native 兜底默认 5；引擎路径（Everything/fd）默认全树，显式传值时下发"——纯描述文本微调，schema 形状不变；
- 隐式不可用 → `logger.debug` 后落原生兜底（与 Everything 隐式不可用同语义）；
- 可用 → `execFileManaged(fdPath, args, { maxBuffer: 10MiB, timeoutMs: 10000, signal, requestId, scopeId, kind: "fd-search" })`；
  - 参数：`["--color=never", "--absolute-path", "--glob", "--ignore-case", "--no-ignore", "--max-results", String(maxR), ...(显式 max_depth 时 ["--max-depth", String(max_depth)]), "--", pattern, dir_path]`
    - 实现修正：设计稿原写 `--absolute-paths`，fd 实际 flag 是单数 `--absolute-path`（fd 10.4.2 实测拒绝复数形，exit 2；已被真实冒烟测试钉死）；
    - `--glob`+`--ignore-case`：对齐 `globToRegex` 的大小写不敏感 glob 语义；
    - `--no-ignore`：关闭 gitignore 过滤（native walk 不读 gitignore，对齐）；
    - 不加 `--hidden`：fd 默认跳过 dot 条目，与 native 跳过 dot 目录近似（残余差异：native 会匹配普通目录下的 dot 文件，fd 不会——记录为已知语义差，见 §5）；
    - `--max-depth` 仅用户显式传 `max_depth` 时下发（引擎路径默认全树，对齐 Everything；`max_depth` 的 schema 描述同步微调）；
    - pattern/dir_path 走 argv 数组 + `--` 终止选项解析，无 shell 拼接；
  - 输出：按行 trim/filter，封顶 maxR（`--max-results` 已限，slice 兜底）；fd 以 dir_path 为根搜索，无需 Everything 式的前缀再过滤；
  - stderr 非空 → `complete=false` + `pushWarning(FD_PARTIAL_ERRORS, {count: 非空行数})`（fd 遍历错误写 stderr、退出码仍 0；镜像 PS 的 ETMCP_PARTIAL_ERRORS 计数思路）；
  - 异常（非零退出/超时/ENOENT 竞态）→ `FD_EXEC_FAILED` warning + 原生兜底（`context.signal.aborted` → `Errors.cancelled`，不变）。
- `truncated = matches.length >= maxR`（与 Everything 路径同款启发式）。

### 3.3 `src/partial-result.ts`

`WARNING_CODES` 追加两个常量：`FD_EXEC_FAILED`、`FD_PARTIAL_ERRORS`。`searchWarningSchema.code` 是 `z.string()`，schema 无需改——纯增量，不触碰错误码兼容表。

## 4. 安全与契约核对

- **注入面**：fd 全部参数走 execFile argv 数组，无 shell；pattern 有 `SEARCH_BUDGET` 既有上限与 handler 层同源校验；dir_path 过 `validatePath`（既有，不动）。
- **信任模型**：PATH 解析的 fd 与既有 PATH 直调 grep 同级；显式 env fail-closed。运行期不下载（写进 diagnostic，对齐 es 的 `download_performed:false` 口径）。
- **输出契约**：`search_files` 的 outputSchema 字段（matches/total/search_ms/truncated/complete/warnings）不变；warning code 枚举是开放 string。
- **profile 面**：fd 段只读，与 CapabilityPolicy 无新交互；sandboxed-production 下行为不变（无后端 fail-closed 在入口层）。

## 5. 已知语义差（显式记录，不视为缺陷）

| 项 | Everything(Win) | fd(非 Win) | native 兜底 |
|---|---|---|---|
| dot 条目 | 全含 | 全跳过（fd 默认） | 跳过 dot 目录、匹配 dot 文件 |
| gitignore | 不过滤 | 不过滤（`--no-ignore`） | 不过滤 |
| max_depth 默认 | 全树 | 全树（显式传则下发） | 默认 5 |
| 结果序 | 索引序 | fd 遍历序 | 遍历序 |

## 6. 测试设计

新增 `tests/unit/fd-resolver.test.ts`（全注入，无真实 fd 依赖）+ 新增 `tests/unit/tools/search-fd.test.ts`（**不**改动既有 search.test.ts）：

1. **fd-resolver 平台中立**：resolver 模块自身不引入 `IS_WIN`（解析链在各平台语义一致），其单测在全平台运行——避免新增 src 行在 Windows 主 coverage 失守。
2. **search-fd 段全平台可跑**：`search.ts` 的 fd 调用点有 `!IS_WIN` 门，若用 `skipIf(IS_WIN)` 则 Windows 的 tools-coverage 会因 fd 分支行未执行而掉 floor。改为在新测试文件内 `vi.mock("../../src/platform.js", ...{ IS_WIN: false })`（沿既有文件 mock process-supervisor 的同款手法），让 fd 分支在 Windows CI 下也被真实执行。
3. 用例：
   - 解析链：显式命中/显式缺失 fail-closed/显式非绝对路径/PATH fd 命中/PATH 仅 fdfind 命中/全缺失不可用/探测失败继续下一候选/进程级缓存与 reset；
   - search_files fd 段：args 构造逐字段断言（glob/ignore-case/no-ignore/max-results/`--`/显式 max_depth 才下发）；结果封顶与换行解析；stderr 非空 → complete=false + FD_PARTIAL_ERRORS(count)；exec 失败 → FD_EXEC_FAILED + 原生兜底命中真实文件；显式配置错误 → VALIDATION_ERROR 且不落兜底；abort → CANCELLED；
4. 真实 fd 集成冒烟：探测 PATH 存在 fd/fdfind 才执行（不存在则 skip），验证真实输出命中临时目录夹具。
5. **fd 版本退化**：探测只验 `--version` 可运行；过旧 fd 缺 `--max-results` 等参数时走 exec 失败 → 原生兜底（安全降级，不单独识别版本号）。

## 7. 回写清单

README（Linux Notes 加 fd 段 + env 表加 `ENHANCED_TERMINAL_FD_PATH` 行）、ARCHITECTURE.md（search 条目 + 术语表）、CHANGELOG [Unreleased]、STATUS.md、AGENTS.md 关键技术事实（一行）。

## 8. 验收标准

- `pnpm run gate`（release）全绿；fd 单测全过（Linux）且 Windows 侧 skip 不破坏既有断言；
- fd 存在时 search_files 走 fd（日志/结果路径可证），不存在时与现状一致；
- 显式 `ENHANCED_TERMINAL_FD_PATH` 错误时 fail-closed，无静默兜底；
- 工具数不变（27/26），`tools/list` 契约不变。
