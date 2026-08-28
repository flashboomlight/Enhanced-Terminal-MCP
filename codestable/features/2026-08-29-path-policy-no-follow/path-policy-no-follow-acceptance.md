---
doc_type: feature-acceptance
feature: 2026-08-29-path-policy-no-follow
requirement: ""
roadmap: production-hardening
roadmap_item: path-policy-no-follow
status: done
summary: 对照设计完成验收；新增共享 PathPolicy（read real 解析重验、write no-follow、原子 staging 写、根替换检查）并接入 files/manage/session/state/temp，两轮审计后 10 checks 全部通过，全量 678 用例与完整门禁全绿
tags: [production, hardening, path, symlink, no-follow, toctou, atomic-write, acceptance]
created: "2026-08-29"
last_reviewed: "2026-08-29"
---

# path-policy-no-follow 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-08-29
> 关联方案 doc：`codestable/features/2026-08-29-path-policy-no-follow/path-policy-no-follow-design.md`
> 关联 checklist：`codestable/features/2026-08-29-path-policy-no-follow/path-policy-no-follow-checklist.yaml`
> 验收授权：用户已明确由代理代为执行 CodeStable 全流程（含 commit 决策）；本报告按当前代码、静态检查、单元与工具层测试和完整质量门禁完成终审记录。

## 1. 接口契约核对

- [x] `src/path-policy.ts`（新增）：`resolveForRead`（lexical → realpath → real 重验；不存在放行给自然 ENOENT）、`resolveForWrite`（目标 symlink 直接 no-follow 拒绝；存在则 realpath 重验；不存在则父链 realpath 重验，父不存在放行给 mkdir recursive）、`atomicWriteFile`（同目录 exclusive staging `wx` + rename 替换，rename 失败回退 truncate 写并告警，失败路径清理 staging）、`assertSafeStateRoot`（存在但为 symlink/非目录时抛出）。判定函数全部来自 `security.ts`，黑名单唯一来源不变。
- [x] `files.ts`：read_file/list_directory/file_info 切换 `resolveForRead` 并以 real 执行 stat/read/readdir；write_file 切换 `resolveForWrite` + 覆写走 `atomicWriteFile`、追加经 real `appendFile`；make_directory 以父 real + basename mkdir；对外 envelope 的 `path` 字段保持请求路径，契约不变。
- [x] `manage.ts`：copy_move 源走读语义、目标走 no-follow 写语义，`cp`/`rename` 以 real 执行；delete_path 对 symlink 仅 `unlink` 链接本身（结果 `type: "link"`），其余以 real 执行 `rm`/`unlink`；SAFETY_META 经 path-policy 的 meta 参数透传，安全决策元数据不丢失。
- [x] `session.ts`：恢复 cwd 在 lexical 校验后增加 `realpathSync` + forbidden/sensitive 重验，symlink→敏感目录或不存在的 cwd 拒绝恢复。
- [x] `state-dir.ts`/`temp-manager.ts`：`ensureStateDir` 与 TempManager `ensureRoot` 在 mkdir 后执行 `assertSafeStateRoot`，page-cache 根嵌套于 temp 之下随其受保护。

## 2. 行为核对（10 checks）

- [x] read/list/info 对 symlink→`.ssh`/`.aws`/`.env` 等敏感目标返回 `PATH_FORBIDDEN`（行为收紧，原为可读）；普通 symlink 读取保留（allow-symlink 语义）。
- [x] write 目标 symlink 拒绝（no-follow）且真实文件不被篡改；父链 symlink→敏感目录拒绝；目标不存在时父 real + basename 解析。
- [x] 覆写经 atomic staging：内容替换成功、无 `.tmp-` 残留；append 经 real 落盘。
- [x] delete_path 非递归删文件 symlink 仅移除链接、目标内容保留；递归删除 junction 目录安全移除链接层（`type: "link"`），目标目录内容不受影响。
- [x] copy_move 源 symlink→敏感目录拒绝；目标 no-follow；real 执行。
- [x] session 恢复 symlink cwd 被拒绝回落默认 cwd，普通 cwd 恢复行为不变（既有 679 恢复测试全过）。
- [x] state/temp 根被 symlink/文件替换时抛错拒绝服务；正常懒创建不受影响（lazy-state-dir 测试全过）。
- [x] 黑名单唯一来源：path-policy 仅 import security 判定函数，零复制（grep 验证）。
- [x] files/manage 落盘调用点全部使用解析后路径（grep 逐点核对）；symlink unlink 为设计内特例。
- [x] build、`tsc --noEmit`、lint 0/0、全量 53 文件 678 用例、latency 24/24（gate 链）、tools coverage 60.74/49.63/65.97/64.51（底线 55/45/60/55）、`git diff --check`、YAML 校验全部通过；`DANGEROUS_PATTERNS`/`HARD_BLOCK_PATTERNS`/`hardBlock`/safeguard/command policy 零改动。

## 3. 验证证据

- `pnpm run build`：通过。`pnpm exec tsc --noEmit`：通过。`pnpm run lint`：0 errors, 0 infos。
- `pnpm test`：53 文件 678 用例全部通过（新增 `path-policy.test.ts` 14 用例、files 3 场景、manage 3 场景、session 1 场景）。
- `pnpm run test:latency`：24/24 达标（gate && 链）。
- `pnpm run test:coverage:tools`：Statements 60.74%、Branches 49.63%、Functions 65.97%、Lines 64.51%。
- 新增/受影响测试 3 连跑全绿；`git diff --check` 通过；feature 三份 YAML 过 `validate-yaml.py`。

## 4. 多轮审计记录（代用户执行）

- **Round A（横向取证）**：files/manage 全部落盘调用点改用解析后路径（17 处逐点核对）；path-policy 黑名单来源唯一；symlink unlink 特例与 no-follow 拒绝的边界确认；copy_move 的 SAFETY_META 透传链核对——未发现新问题。
- **Round B（场景映射与稳定性）**：10 个验收场景逐条映射证据；补充"递归删除 junction 目录仅移除链接层"用例；48 用例 3 连跑全绿。行为收紧（symlink→敏感目录从可读变拒绝）为 feature 目的，以对比记录。

## 5. 边界与后续

- realpath→open 之间仍存在理论 TOCTOU 窗口（Node 无 openat/目录句柄能力），已收窄到最小；OS 级语义归属未来 sandbox backend。
- `session_state.set_cwd` 的入口校验（utility.ts）与 SEC-06 的 capability/host-disclosure 归属 `tool-wrapper-and-surface-contract`。
- CI windows runner 需具备 symlink 创建权限（GitHub Actions runner 以管理员运行，满足）；如未来 runner 配置变化，symlink 用例需条件跳过。
- 下游解锁：`secret-redaction-and-state-protection` 与 `network-and-archive-safety`（依赖本条 + 第 1 条）现可开工。
