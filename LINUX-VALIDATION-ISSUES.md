# LINUX-VALIDATION-ISSUES.md — Linux VPS 跑通完整测试的问题收集

> **目的**：记录从 2026-08-29 起，在这台 Linux VPS 上把本项目从"依赖损坏"修复到"完整测试跑通"全过程中发现的全部问题、证据与处置。
> **维护规则**：每发现一个问题立即追加条目（含证据命令与输出摘要）；每修复一个就回填状态与修复方式；全部问题 closed 且完整测试通过后，在文末记录最终验证证据。
> **对应 STATUS.md 事项**：§5 第 5 条"Linux 验证由用户自行在 VPS 处理"的执行记录。

## 0. 环境基线（2026-08-29 采集）

| 项 | 值 | 备注 |
|---|---|---|
| 机器 | Linux VPS（`Linux 5.15.0-187-generic x86_64`，Ubuntu 系） | 非开发主机（开发主机为 Windows） |
| Node | v26.7.0 | 满足 `engines >= 20`；但 CI 验证矩阵为 Node 20/22/24，26 是矩阵外版本（风险见 P-06） |
| pnpm | **未安装**（corepack 也不存在） | 项目锁定 pnpm 11.21.0；仅有 npm/npx |
| 代码状态 | HEAD `3b946b1`；`build/` 与 `src/` 同步（同批次 21:31 时间戳） | `git status` 有 `M es_tool/es.exe`（见 P-05） |
| node_modules 来源 | **从 Windows 开发机原样拷贝** | 这是一系列问题的总根因（见 P-01） |

## 1. 问题清单

| ID | 问题 | 层级 | 状态 |
|---|---|---|---|
| P-01 | node_modules 为 Windows 拷贝，pnpm 链接视图全毁，服务端无法启动 | 阻塞 | fixed |
| P-02 | 平台原生包仅有 win32 版本，无 Linux 版本 | 阻塞 | fixed |
| P-03 | `typescript/lib/_tsc.js` 被截断，tsc 无法运行 | 阻塞 | fixed |
| P-04 | `node_modules/.bin` shim 全部丢失执行权限 | 阻塞（连带） | fixed |
| P-05 | `git status` 显示 `es_tool/es.exe` 被修改 | 观察 | closed（非问题） |
| P-06 | Node 26 不在 CI 验证矩阵（20/22/24）内 | 风险 | closed（非因素，见详情） |
| P-07 | pnpm 11 strictDepBuilds 默认 true：`pnpm run` 预检重跑 install 因 esbuild 构建脚本被忽略而 exit 1 | 阻塞 | fixed |
| P-08 | VPS 缺少 `zip`/`unzip`（Linux 归档工具的系统依赖） | 环境 | fixed |
| P-09 | 16 个单测为 Windows 耦合（缺平台守卫/平台感知夹具），Linux 上必挂 | 测试套件平台缺口 | fixed（issue `2026-08-29-linux-test-platform-guards`） |
| P-10 | e2e-latency 两次首跑失败（tools/list 213ms>200ms、compress_archive） | 噪声/环境 | closed |
| P-11 | 共享 VPS 高负载下 tools/list 冷调用延迟边缘越限（200ms 阈值单次采样），gate release 模式 test 阶段被阻断 | 环境性能 | closed（定性为环境边界，见详情） |
| P-12 | 主 coverage 门禁在 Linux 低于阈值（statements 79% < 80%）：Windows 专属分支不执行所致 | by-design | closed（门禁归 Windows/CI，项目既定分工） |

## 2. 问题详情

### P-01 node_modules 链接结构损坏，服务端无法启动【阻塞】

- **现象**：`node build/index.js` 启动即崩。
- **证据**：
  - MCP initialize 探针（initialize + tools/list 经 stdio 注入）无任何输出；
  - stderr 报 `ERR_MODULE_NOT_FOUND: Cannot find package 'zod-to-json-schema' imported from .../@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js`；
  - `find node_modules -xtype l | wc -l` → **0**：整个 node_modules 没有任何符号链接。pnpm 依赖 `.pnpm` 虚拟 store + 符号链接视图组织依赖，跨机器拷贝后链接全部丢失；
  - `.pnpm/@modelcontextprotocol+sdk@1.29.0/node_modules/` 这一 peer 依赖视图目录整体缺失，导致 SDK 无法解析 `zod-to-json-schema`（store 内包体尚在）。
- **影响**：运行时（服务端）与全部开发命令均不可用。
- **根因**：node_modules 不可跨机器/跨平台拷贝；pnpm 布局尤其如此（Windows 上的 junction/hardlink 拷贝后不保留）。
- **修复方式**：删除后在本机 `pnpm install --frozen-lockfile` 全新安装（前置：安装 pnpm 11.21.0，需联网）。
- **修复结果（2026-08-29）**：`npm i -g pnpm@11.21.0` 装入 `/opt/node-26.7.0/bin`（不在 PATH，按 npm 同款方式软链到 `/usr/local/bin`）→ `rm -rf node_modules && pnpm install --frozen-lockfile` 成功，postinstall patch 重新打上（输出从 `patched` 变为后续的 `already applied`）→ MCP 探针 initialize 正常、`tools/list` 返回 27 个工具。
- **状态**：fixed

### P-02 平台原生包仅有 win32 版本【阻塞】

- **现象/证据**：`node_modules/.pnpm` 中平台相关包只有 `@biomejs/cli-win32-x64@2.4.15`、`@esbuild+win32-x64@0.28.2`、`@rolldown+binding-win32-x64-msvc@1.1.4`、`lightningcss-win32-x64-msvc@1.32.0`；Linux 版本计数为 0。esbuild 包内是 `esbuild.exe`（PE32+ Windows 可执行文件）。
- **影响**：即使补回纯 JS 依赖，biome（lint）、vitest 链路（esbuild/rolldown/lightningcss）在 Linux 上也无法运行。
- **修复方式**：随 P-01 全新安装自动解决（pnpm 按当前平台拉取对应原生包）。
- **修复结果（2026-08-29）**：重装后 `.pnpm` 出现 4 个 linux-x64 包（biome/esbuild/rolldown/lightningcss），`pnpm run lint` 通过（129 文件 0 问题）。
- **状态**：fixed

### P-03 typescript `_tsc.js` 被截断【阻塞】

- **现象/证据**：`node node_modules/typescript/bin/tsc --noEmit` 直接 `SyntaxError: missing ) after argument list`；`_tsc.js` 仅 1,835,008 字节（TS 5.8 正常约 3.4 MB），文件结尾停在半个 token（`parseOptional(156 /* TypeKeywo`）。
- **影响**：类型检查与构建不可用。
- **根因**：跨机器拷贝不完整（传输截断）。
- **修复方式**：随 P-01 全新安装自动解决。
- **修复结果（2026-08-29）**：重装后 `tsc --version` 正常（5.9.3），`pnpm run build` + `pnpm exec tsc --noEmit` 均通过。
- **状态**：fixed

### P-04 .bin shim 丢失执行权限【连带】

- **现象/证据**：`node_modules/.bin/tsc` 等 shim 权限为 `-rw-r--r--`，直接执行报 Permission denied。
- **修复方式**：随 P-01 全新安装自动解决（pnpm 重建 shim 并赋权）。已验证 shim 恢复 `-rwxr-xr-x`。
- **状态**：fixed

### P-05 `git status` 显示 `es_tool/es.exe` 被修改【已排除】

- **排查**：`sha256sum es_tool/es.exe` = `5101b3a6…b342`，与 `src/es-integrity.ts` 的 `ES_EXE_SHA256` 锁定值**一致**；内容为 Windows PE32+ 无变化。判定为跨机器拷贝造成的 stat/mode 噪声，非真实修改。
- **附加说明**：es.exe 是 Windows-only 开发 fixture，Linux 运行时本就解析不到（`search_files` 走 native 兜底），不影响本机验证。
- **状态**：closed（非问题）

### P-07 pnpm 11 strictDepBuilds 导致 `pnpm run` 预检失败【阻塞→fixed】

- **现象**：全新安装后 `pnpm run build` 尚未执行构建就先跑 deps-status 预检（`verifyDepsBeforeRun`），预检重跑 `pnpm install`，而 pnpm 11 默认 `strictDepBuilds=true`：依赖的构建脚本（esbuild postinstall）未被批准时 install 直接 exit 1（`ERR_PNPM_IGNORED_BUILDS`），进而所有 `pnpm run *` 命令全部被阻断。
- **排查**：①全局 `config.yaml` 写 `onlyBuiltDependencies` 被 pnpm 显式忽略（警告：该键只能放项目级 `pnpm-workspace.yaml`）；②`allowBuilds` 写全局 config.yaml 同样不生效（同属项目级设置）；③pnpm 11.0 起 `approve-builds` 支持位置参数，但其写入目标是项目级 `pnpm-workspace.yaml`，会改变仓库契约。
- **修复（2026-08-29）**：机器级处置——全局 `/root/.config/pnpm/config.yaml` 写 `strictDepBuilds: false`（降级为警告，esbuild 的 postinstall 实际不需要：`@esbuild/linux-x64` 包直接带 ELF 二进制，已验证可用）。仓库文件零改动。
- **补记（本地噪声）**：pnpm 11.21 每次 install 会在项目根再生 `pnpm-workspace.yaml` scaffold（内容仅 `allowBuilds: {esbuild: "set this to true or false"}` 占位提示）。不入库：已写入本机 `.git/info/exclude`（只影响本机 git status，不改仓库）。若维护者想在仓库级根治，可正式提交 `allowBuilds: {esbuild: true}` 的 pnpm-workspace.yaml——属仓库契约变更，留给维护者决策。
- **注意**：开发机（Windows）没踩到是因为该机的 pnpm 全局配置/历史批准状态不同；若换机重装还会再现，处置方法即本条。
- **状态**：fixed

### P-08 VPS 缺少 `zip`/`unzip`【环境→fixed】

- **现象**：`tests/e2e-latency.test.ts > compress_archive` 报 `expected true to be falsy`（工具返回 isError）；`upgrades-r2 > getExtractSpec` 报 `spawn zip ENOENT`。`which zip unzip` 均无（curl 有）。
- **背景**：Linux 下 `compress_archive`/`extract_archive` 走 `src/platform.ts` 的 Unix spec，依赖系统 `zip`/`unzip` 二进制；README 的环境依赖只写了 Windows 侧（pwsh/Everything），Linux 侧这条隐含依赖未文档化。
- **修复（2026-08-29）**：`apt-get install -y zip unzip` 后两测试通过。
- **状态**：fixed

### P-09 16 个单测 Windows 耦合【测试套件平台缺口→open】

全量测试首跑 8 文件 18 失败（814 过/15 跳过/847 总），修复 P-08 后剩 16 个，全部位于单测层，**逐一核查后确认代码行为正确、是测试本身缺平台守卫或平台感知夹具**（项目测试套件历史上只在 Windows 跑；CI ubuntu 仅 lint/tsc）：

| 文件 | 失败数 | 根因 |
|---|---|---|
| `tests/unit/shell.test.ts` | 4 | pwsh bundled/显式路径解析是 Windows 概念；`C:\…` 相对路径判定、`cmd` 引号断言均为 win32 语义 |
| `tests/unit/upgrades-r2.test.ts` | 5 | 断言 `getCompressSpec`/`getDownloadSpec` 返回 `powershell.exe`（Linux 正确返回 `zip`/`curl`）；Everything dir_path 过滤依赖 es.exe（Windows PE 二进制，Linux 无法执行） |
| `tests/unit/upgrades.test.ts` | 1 | 直接 `spawn powershell.exe` |
| `tests/unit/infra.test.ts` | 3 | spawnStream 用例硬编码 `cmd.exe` |
| `tests/unit/platform.extended.test.ts` | 1 | `force 参数独立影响` 断言 args 长度不同——Unix `kill -15/-9` 信号恒显式、长度恒为 2（`src/platform.ts:87-88`），断言仅 Windows taskkill 成立；同文件相邻用例都有 `IS_WIN` 守卫，独此条没有 |
| `tests/unit/tools/system.test.ts` | 1 | `kill_process csrss.exe` 期望 `PROCESS_PROTECTED`：关键进程名单分平台（`src/safeguard.ts:44,57`），csrss.exe 只在 Windows 名单；Linux 上正确落到 normal 确认层返回 `SAFETY_BLOCKED` |
| `tests/unit/state-dir.test.ts` | 1 | 用 `\\invalid\path\for\state` 当"必然失败"路径——反斜杠在 Linux 是合法文件名字符，mkdir 成功（非 root 权限问题，已核查排除） |

- **处置**：维护者选定 (b)——走 issue `2026-08-29-linux-test-platform-guards` 补平台守卫。修复手法：Windows 语义断言加 `skipIf(!IS_WIN)`（shell×4、upgrades-r2×5、upgrades×1），机制跨平台用例改平台感知（infra×3 选 `/bin/sh -c`、platform.extended×1 断言信号值 `-15`→`-9`、system×1 按平台选关键进程名 `csrss.exe`/`init`、state-dir×1 用 ENOTDIR 必失败路径）；**未改任何 `src/` 源码**。
- **修复结果（2026-08-29）**：`pnpm test` **69/69 文件、822 过 / 25 跳过 / 0 失败**；`pnpm run test:coverage:tools` **7/7、89 过 / 11 跳过 / 0 失败**；tsc、lint 同步全绿。
- **状态**：fixed

### P-10 e2e-latency 首跑两项失败【噪声→closed】

- `tools/list` 首跑 213ms > 200ms 阈值；P-08 修复后整文件重跑 24/24 全过（tools/list 也在阈值内）。判定为 VPS 首次加载噪声；项目约定 latency 在 CI 本就是 advisory，非阻塞。
- **状态**：closed（后续高负载复现见 P-11）

### P-11 高负载下 tools/list 延迟边缘越限【环境性能→open】

- **现象**：`pnpm run gate`（release 模式）test 阶段 = 全量 vitest（含 e2e-latency），并行 worker 把 VPS CPU 打满时，`tools/list should respond within threshold` 实测 284ms/314ms > 200ms 阈值，test 阶段判 failed，后续阶段（coverage/latitude/audit/package/consumer）全部 skipped。同用例在空闲窗口单跑/全量跑均在阈值内（本日 5 次独立运行 4 次通过）。
- **根因定性**：`tests/e2e-latency.test.ts:121-135` 对冷调用单次采样、无预热无重试；阈值 200ms 是按开发机/CI runner 性能标定的**发布契约**，不为迁就 VPS 而改。项目既有政策已承认其噪声性（CI 中 latency 明确 advisory）。
- **边界**：这不是代码回归——同负载下 Windows 开发机 gate 11/11 全绿（STATUS §5.3 证据）；VPS 为共享 vCPU，首次全量并行时 CPU 竞争导致冷调用变慢。
- **处置**：空闲窗口重跑 gate 仍复现（284ms→299ms/316ms，gate 全量并行负载下稳定越限）；但同一文件空闲单跑 24/24 全过、tools/list 158ms。**定性为共享 vCPU 负载竞争的环境边界**，非代码回归（同一 commit 在 Windows 开发机 gate 11/11 全绿）。
- **最终结论**：release 级 gate 以维护者 Windows 本机/CI 为准（项目既定分工：CI 中 latency 即 advisory）；Linux 侧验证准线 = `pnpm test` 全绿 + 跨平台 e2e 面 + gate 其余阶段单跑等效验证（全部通过，见 §3）。
- **状态**：closed（环境边界，已定性）

### P-12 主 coverage 门禁 Linux 低于阈值【by-design→closed】

- **现象**：`pnpm run test:coverage` statements 79% < 80% 阈值（branches 71.59% / functions 81.94% / lines 81.96%）。
- **根因**：阈值按 Windows 全量执行标定；Linux 上 Windows 专属分支天然不执行（P-09 守卫跳过的 25 条用例覆盖的 shell.ts pwsh/bundled 解析、cmd 调用构造、PowerShell 归档 spec、Everything 路径等），覆盖率结构性下降。
- **依据**：AGENTS.md 既定分工——CI 的 ubuntu job 只跑 lint/tsc，覆盖门禁归 windows Node 22/24 job；主 coverage 门禁本就不以 Linux 为运行目标。工具层专属门禁 `test:coverage:tools` 在 Linux 正常通过（89/89）。
- **处置**：不改阈值、不改插桩范围（均属发布契约）；记录为平台边界。
- **状态**：closed（by-design）

### P-06 补记（closed）

全量失败逐条核查后全部可归因于平台耦合/环境缺失，无一条与 Node 26 相关；矩阵外版本风险本条关闭，后续若出现无法归类的失败再重开。

## 3. 修复与验证计划（目标：完整测试跑通）

1. [x] 安装 pnpm 11.21.0（`npm i -g pnpm@11.21.0` → `/opt/node-26.7.0/bin`，按 npm 同款软链到 `/usr/local/bin`）
2. [x] 删除损坏的 node_modules，`pnpm install --frozen-lockfile` 全新安装（postinstall patch 自动重打成功）
3. [x] `pnpm run build` + `pnpm exec tsc --noEmit`（均通过；途中解决 P-07）
4. [x] `pnpm run lint`（129 文件 0 问题）
5. [x] `pnpm test`（全量：847 用例；P-09 修复后 **822 过 / 25 跳过 / 0 失败，69/69 文件全绿**）
6. [x] `pnpm run test:coverage:tools`（**89 过 / 11 跳过 / 0 失败**，P-09 同族用例已随守卫修复）
7. [x] gate 逐阶段等效验证（release gate 整体因 P-11 环境边界在 test 阶段阻断，逐阶段单跑补齐证据）：
   - build ✓ / typecheck ✓ / lint ✓（gate 内三阶段均 passed）
   - test：`pnpm test` 全绿（822/822）；e2e-latency 空闲单跑 24/24（tools/list 158ms）
   - coverage-main：79% < 80%（P-12，by-design 归 Windows）；coverage-tools ✓ 89/89
   - dependency-audit ✓（0 漏洞）/ package-verifier ✓（ok:true）/ pack-consumer + clean-consumer ✓（ok:true，含 startupSmoke）
8. [x] 回填最终验证证据并同步 STATUS.md

### 最终验证证据（2026-08-29，Linux VPS，Node v26.7.0，pnpm 11.21.0）

- 服务端冒烟：initialize OK（enhanced-terminal-mcp 4.0.0）、`tools/list` 返回 27 个工具
- `pnpm run build` ✓、`pnpm exec tsc --noEmit` ✓、`pnpm run lint` ✓（129 文件 0 问题）
- `pnpm test`：**69/69 文件，822 过 / 25 跳过 / 0 失败 / 847 总**（跳过项均为 P-09 新增的 Windows 专属守卫用例及既有 skip）
- `pnpm run test:coverage:tools`：**7/7 文件，89 过 / 11 跳过 / 0 失败 / 100 总**
- 跨平台 e2e 面全绿：`platform-smoke`、`mcp-conformance` 8/8、`hostile-input`、`e2e-latency` 24/24、`safeguard` 25/25、`command-risk-gated`、`tool-visibility`
- gate 逐阶段等效证据见 §3 第 7 步；release 模式整跑唯一阻断点为 P-11（环境边界）

## 4. 收口状态

**全部问题 closed**（P-01~P-08 修复，P-05 非问题排除，P-09 经 issue `2026-08-29-linux-test-platform-guards` 修复，P-10 噪声复测通过，P-11/P-12 定性为平台/环境边界）。Linux VPS 上完整测试已跑通：`pnpm test` 与 `pnpm run test:coverage:tools` 全绿。

> 过程中每遇到一个新问题，追加到 §1/§2（编号 P-11 起），修复后回填状态。
