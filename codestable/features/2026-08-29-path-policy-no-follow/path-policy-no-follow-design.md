---
doc_type: feature-design
feature: 2026-08-29-path-policy-no-follow
roadmap: production-hardening
roadmap_item: path-policy-no-follow
status: approved
summary: 新增共享 PathPolicy（read 用 real 解析重验、写/删/移 no-follow、原子 staging 写、state/temp 根防替换），统一接入 files/manage/session/temp，关闭 SEC-03 的 symlink 与 TOCTOU 缺口
tags: [production, hardening, path, symlink, no-follow, toctou, atomic-write, acceptance-gate]
created: "2026-08-29"
last_reviewed: "2026-08-30"
depends_on: [2026-08-28-hardening-contract-and-profiles]
---

# path-policy-no-follow 设计

> 阶段：阶段 1（设计定稿）
> 创建日期：2026-08-29
> 状态依据：roadmap 第 5 条；用户已授权代理代为执行 CodeStable 全流程，design 由代理按 roadmap 既定范围审定并批准。
> 关联归档：SEC-03（本 feature 主目标）、SEC-06 的 path 子项（session cwd / state/temp/page-cache 统一进入 PathPolicy）；DEC-001 与 not-sandbox 决策不受影响。

## 0. 术语约定

- real 解析：`fs.realpath` 的结果；目标不存在时为 null，以"存在的最近祖先的 real + 剩余段"作为写路径的解析产物。
- allow-symlink（读语义）：目标可以是 symlink，但必须解析到 real 并对 real 重跑完整校验（forbidden/sensitive），随后**以 real 路径执行 I/O**，把 lexical 校验与实际打开之间的窗口收窄到 realpath→open。
- no-follow（写语义）：目标本身是 symlink 时拒绝操作（不跟随、也不经由链接落盘）；目标不存在时校验父目录 real。
- 原子写：同目录 exclusive staging（`wx`）+ `fs.rename` 替换；rename 失败时回退 truncate-write 到 real 并记录 logger.warn。

## 1. 决策与约束

### 需求摘要（来自 roadmap 第 5 条 + audit SEC-03/SEC-06.path）

- 将 realpath/parent realpath 校验收敛为共享 helper，替代 files/manage 内的零散 `validatePath`+`validateRealPath` 组合。
- read/list/info 统一"real 解析 + 重验 + 用 real 打开"；写/删/移统一 no-follow 语义；write_file 覆写走原子 staging。
- session 恢复 cwd 增加 real 解析重验；state/temp 根在创建/使用前检查"存在但为 symlink/非目录"的替换迹象。
- 补 symlink、父目录替换、递归删除 reparse point、并发替换测试。

### 明确不做

- 不修改 `DANGEROUS_PATTERNS`、`HARD_BLOCK_PATTERNS`、`hardBlock`、safeguard 模式逻辑（`security.ts` 的 `validatePath`/`isForbiddenPath`/`isSensitivePath` 复用而不改动其判定）。
- 不实现 OS 级 openat/目录句柄（Node 无该能力；real 打开是当前平台的最佳收窄）。
- 不做下载/归档内容的 path 注入（Zip Slip 归 `network-and-archive-safety`）。
- 不改 `MCP_STATE_DIR` 解析与迁移协议（state-dir 迁移已有 no-follow；本 feature 只补根替换检查）。
- 不引入新环境变量与新运行时依赖。

### 现状证据与根因

- `security.ts:216-243` `validateRealPath`：目标不存在直接放行（写新文件时父目录从未被校验）；只拦 forbidden/sensitive real，不拒绝"目标本身是 symlink"。
- `files.ts`：`read_file:62`、`list_directory:267`、`file_info:363`、`make_directory:405` 只有 lexical `validatePath`——symlink 指向 `.ssh`/系统目录可被读/列；`write_file:168-207` 有 real 检查但 `mkdir(dirname)` 与 `writeFile` 用原始路径（父目录替换 + TOCTOU），非原子。
- `manage.ts`：`delete_path:59-67`、`copy_move:108-111` 有 real 检查，但 `rm/unlink/cp/rename`（:121-188）仍用原始路径执行；非递归 unlink 会跟随 symlink 删除目标文件。
- `session.ts:225-243`：恢复 cwd 只做 lexical 校验，symlink cwd 可把后续命令导向敏感目录。
- `state-dir.ts` 迁移已具备 no-follow（`lstatOrNull`/symlink-skipped）；temp/page-cache 根缺少"存在但为 symlink"检查。

## 2. 设计方案

### 2.1 新模块 `src/path-policy.ts`

职责单一：路径解析策略与落盘 helper；判定函数全部复用 `security.ts`，不复制黑名单。

- `interface PathResolution { requested: string; real: string; existed: boolean }`
- `resolveForRead(targetPath, operation)`：lexical `validatePath` → `realpath`（**失败/不存在时放行**，沿用 `validateRealPath` 的"交给后续操作自然 ENOENT"既有契约，错误码不变）→ real 重跑 `isForbiddenPath`/`isSensitivePath`（含既有 audit 记录语义）→ 返回 real。用于 read_file / list_directory / file_info（copy_move 源）。
- `resolveForWrite(targetPath, operation)`：lexical 校验 → 目标 `lstat`：
  - 存在且是 symlink → 拒绝（`PATH_FORBIDDEN`，reason "no-follow"）；
  - 存在 → realpath 重验后返回 real；
  - 不存在 → **沿祖先链向上对最近存在的祖先做 realpath 重验**（拦截"深层缺失路径经 symlink 祖先穿透进敏感/系统目录"的路径——不只是直接父目录；重验通过后 real 取祖先 real + 剩余段，工具层落盘不再经过 symlink 段）；**整条链都不存在 → 放行**（mkdir recursive 建新链是合法场景），real 取 `path.resolve(targetPath)`。
- `atomicWriteFile(realPath, data, encoding)`：同目录 exclusive staging（`fs.open(staging, "wx")` + 写入 + close）→ `fs.rename(staging, realPath)`（libuv 在 Windows 使用 MOVEFILE_REPLACE_EXISTING，可替换存在文件且不跟随目标 reparse point）→ rename 失败时回退 `fs.writeFile(realPath, data)` truncate 写并 `logger.warn`；任何失败路径清理 staging。
- `assertSafeStateRoot(root)`：root 存在但 `lstat` 为 symlink 或非目录 → `CONFIG_INVALID` 语义的结构化拒绝；不存在放行（懒创建仍由调用方执行）。

### 2.2 files.ts 接入

- `read_file` / `list_directory` / `file_info`：`resolveForRead` 替换 `validatePath`，后续 stat/open/read/list 全部使用 real。
- `write_file`：覆写与追加都先 `resolveForWrite`；覆写走 `atomicWriteFile(real)`；追加经 real `appendFile`；父目录缺失时以父 real `mkdir`（保持既有 recursive 语义）。
- `make_directory`：对 `dirname` 做父 real 校验后 `mkdir(real + basename)`。

### 2.3 manage.ts 接入

- `delete_path`：非递归且目标是 symlink → 仅 `unlink` 链接本身（删除链接不落盘、无越权面）；其余经 `resolveForWrite` 后对 real 执行 `rm`/`unlink`。
- `copy_move`：源走 `resolveForRead`；目标走 `resolveForWrite`；`cp`/`rename` 以解析后的 real 执行；目标父目录创建以父 real 进行。

### 2.4 session / state 根接入

- `session.ts` 恢复 cwd：lexical 校验通过后 `realpathSync` 重验（real 仍须通过 `isForbiddenPath`/`isSensitivePath`；解析失败视为无效 cwd 并拒绝恢复，行为与现有"拒绝非法 cwd"一致）。
- `ensureStateDir` 成功后对 `.etmcp` 根执行 `assertSafeStateRoot`；TempManager 首次创建 temp 根前同样检查（page-cache 根嵌套于 temp 之下，随 temp 根受保护）。

### 2.5 错误语义

- 复用既有 `PATH_FORBIDDEN` / `PATH_NOT_FOUND` / `CONFIG_INVALID`，不新增错误码；拦截继续按现有 `safety.block` audit 语义记录（path-policy 内统一调用现有 `validatePath` 的审计路径，避免第二套日志）。
- 工具输出契约不变：错误仍是统一 ToolResult envelope；成功结果的字段不新增。

## 3. 挂载点

| 文件 | 变更 |
|------|------|
| `src/path-policy.ts`（新增） | resolveForRead/resolveForWrite/atomicWriteFile/assertSafeStateRoot |
| `src/tools/files.ts` | 5 个工具切换到 real 语义；write_file 原子写 |
| `src/tools/manage.ts` | delete/copy_move 切换到 real 语义；symlink unlink 例外 |
| `src/session.ts` | cwd 恢复 real 重验 |
| `src/state-dir.ts` / `src/temp-manager.ts` | 根替换检查接入 |
| `tests/unit/path-policy.test.ts`（新增） | symlink/父替换/原子写/根替换 单元 |
| `tests/unit/tools/files.test.ts`、`manage.test.ts`、`session.test.ts` | 行为收紧与兼容场景 |

## 4. 实现维度

- 维度档位：B+——一个新模块 + 五个文件的接入；判定逻辑复用 security.ts，不复制黑名单；不改执行链与安全核心判定。
- 兼容风险最高点是 read/list/info 的行为收紧（symlink→敏感/系统目录从"可读"变"拒绝"）：这是 feature 目的而非回归，acceptance 中以对比记录。
- Windows 特性：reparse point/junction 由 `lstat` 的符号链接位识别；rename 替换语义以真实测试验证。

## 5. 验收场景

1. read_file/list_directory/file_info 对指向敏感目录/系统目录的 symlink 返回 `PATH_FORBIDDEN`（原为可读——行为收紧）。
2. 对普通文件 symlink 的读取成功且返回真实内容（allow-symlink 语义保留）。
3. write_file 目标是 symlink → 拒绝（no-follow）；目标不存在且父目录是 symlink → 拒绝。
4. write_file 覆写走 staging+rename：内容替换成功、无 staging 残留；append 经 real 落盘。
5. 目标不存在时父目录被替换为 symlink 指向敏感目录 → 拒绝（父目录 realpath 重验）；深层缺失目标（目标与父均不存在、但更高层祖先为 symlink）指向敏感目录 → 拒绝（祖先链重验）；祖先为普通目录 → 放行且 real 解析到真实落点。
6. delete_path 非递归删除 symlink 仅移除链接本身；递归删除 reparse point 目录拒绝或安全移除链接层。
7. copy_move 源 symlink → 敏感目录被拒；目标 no-follow。
8. session 恢复 symlink/敏感 cwd 被拒绝，普通 cwd 恢复不变。
9. state/temp 根被 symlink 替换时拒绝并报 CONFIG_INVALID 语义错误；正常懒创建不受影响。
10. 既有兼容：全部现有单测/e2e/latency 通过；全量 gate、`git diff --check`、YAML 校验通过；安全核心文件零改动。

## 6. 反向检查与明确拒绝

- 不接受在 path-policy 复制或改写 forbidden/sensitive 黑名单（唯一来源仍是 security.ts）。
- 不接受"先校验后用原始路径执行"的旧模式残留（files/manage 的落盘调用点全部改用 real）。
- 不接受 staging 文件逃逸出目标目录（staging 必须同目录，保证 rename 同卷原子）。
- 不接受静默吞掉 realpath 失败：读语义放行给自然 ENOENT（契约不变），写语义在父目录存在时必须完成父链重验；缺失目标的祖先链重验只在"整条链都不存在"时放行。
