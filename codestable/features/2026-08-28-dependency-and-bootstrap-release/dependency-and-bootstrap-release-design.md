---
doc_type: feature-design
feature: 2026-08-28-dependency-and-bootstrap-release
requirement: ""
roadmap: production-hardening
roadmap_item: dependency-and-bootstrap-release
status: approved
summary: 收敛生产依赖、SDK 兼容补丁、source/npm 双 bootstrap、可重复 package 验证和发布证据，解除当前 high 依赖审计与 stale build 发布阻断
tags: [production, dependency, release, npm, pnpm, bootstrap, supply-chain, package]
created: "2026-08-28"
last_reviewed: "2026-08-28"
---

# dependency-and-bootstrap-release 设计

> 本 feature 从 production-hardening roadmap 第 11 条起头。用户已明确把提交决策和审核执行全部交给代理，因此本稿在已有 roadmap 契约和历史 decision 约束下直接标记为 approved，随后进入 checklist 和实现。
>
> 本 feature 只处理依赖、安装、构建、npm package 和发布证据边界；不会把 shell 字符串改造成形式化 sandbox，也不会提前实现 process supervisor、路径 no-follow、秘密治理、网络 SSRF 或 CI 全量 conformance。

## 0. 术语约定

| 术语 | 定义 | 防冲突结论 |
|---|---|---|
| production dependency | 运行期由 package.json dependencies 声明并由 consumer 安装的依赖树 | devDependencies、机器全局依赖和其他 MCP checkout 不得作为运行时前置条件 |
| source bootstrap | 从源码 checkout 恢复开发/构建环境的显式 setup.bat → pnpm install → build → 可选 pwsh bootstrap 流程 | 只服务源码维护者；不把 setup.bat 当作 npm consumer 的安装步骤 |
| npm bootstrap | consumer 安装发布 tarball 后，通过 bin/build/index.js 启动的流程 | 不下载 pwsh，不要求 checkout、pnpm、source 或 package 内不存在的 setup.bat |
| SDK compatibility patch | postinstall 对 package 自有 @modelcontextprotocol/sdk 精确版本的 required:[] 兼容补丁 | 只定位 package-owned dependency；版本/布局/模式不匹配必须 fail-closed；不修改 consumer 的其他 SDK |
| release verifier | 零运行时依赖的 scripts/verify-package.mjs，执行 package manifest、实际 tarball 文件、入口 shebang、Node syntax、source map 和 SHA-256 检查 | 只做发布验证，不在 MCP server 运行期执行，不下载运行时组件 |
| clean consumer | 与源码 checkout 无关、使用重定向 cache/temp 的独立 npm consumer 目录 | 必须证明 npm install、postinstall、bin 或 build entry 和最窄启动 smoke 均可独立完成 |
| release evidence | 依赖 audit、冻结 lockfile、package manifest/tarball 清单、SBOM、SHA-256 和 provenance/构建身份的可追溯输出 | evidence 是发布门禁输入；不把本地“命令执行过”写成已产生的 provenance |

## 1. 决策与约束

### 需求摘要

**做什么**：把当前“能在维护者 checkout 中构建”收敛为可重复的生产发布链路，解除 lockfile 中的 high 传递依赖、stale build 进入发布物、source/npm 安装说明混淆、postinstall 可能误改 consumer 依赖和缺少 package 完整性证据等问题。

**为谁**：项目维护者、CI/release runner、npm consumer、MCP host 和需要审查供应链证据的安全审计者。

**成功标准**：

1. 保持现有 SDK wire/API 兼容基线：@modelcontextprotocol/sdk 继续精确锁定 1.29.0；在不跨到 1.30.0 的前提下，刷新其声明范围内的传递依赖到当前已修复版本，pnpm audit --prod --audit-level=high 通过。
2. pnpm-lock.yaml 是唯一 active lockfile，pnpm install --frozen-lockfile 可重放，运行期不依赖 patch-package、pnpm、全局 node_modules 或机器专属 store 路径。
3. postinstall 只修改由本 package 依赖解析得到的 SDK；SDK 未安装时允许安装流程继续，SDK 已安装但版本、布局或补丁模式不满足时退出码为 1；不联网、不写 source checkout 外的任意依赖、不吞掉兼容回退。
4. source bootstrap 与 npm bootstrap 在 README 中明确分段；setup.bat 只属于源码 checkout，npm consumer 只需要 npm install 或 npx/全局 bin，运行期不下载 pwsh。
5. pack 前自动 clean build；发布 package 包含入口、声明、source map、README、CHANGELOG、LICENSE 和 SDK patch，不含 src、tests、lockfile、node_modules、.etmcp、setup.bat、Everything fixture、bundled pwsh 或机器路径。
6. release verifier 对实际 npm tarball 输出通过/失败的结构化检查和 SHA-256；Node 20+ 可以对 build/index.js 做 syntax smoke，source map 不依赖 npm 包外缺失的 src 文件。
7. clean npm consumer 在非 C 盘 cache/temp 下安装 tarball，postinstall 只补丁 package-owned SDK，并能脱离源码 checkout 启动 build/index.js；SBOM、checksum 和 provenance 作为后续 canonical CI gate 可消费的 evidence。

### 明确不做

- 不升级到 @modelcontextprotocol/sdk 1.30.0。已有 command-risk-gated-confirmation 设计记录了新 wire 模型和客户端生态兼容评估，SDK 跨版本升级另立 feature；本 feature 只在 1.29.0 的声明范围内刷新传递依赖。
- 不引入新的运行时依赖、打包器、二进制下载器、postinstall 网络安装器或远程 bootstrap。
- 不把 postinstall 当作安全沙箱；它只修复已知的 MCP schema 兼容性。
- 不在本 feature 中固定 CI action SHA、实现完整 MCP conformance、hostile-input corpus、SBOM 服务上传或云端 provenance 签发；本 feature 定义可重复命令和 evidence 形状，阻断 CI 由 security-and-mcp-conformance-gates 承接。
- 不把所有低/中危 audit advisory 通过删依赖或错误豁免隐藏；当前发布阻断针对 high/critical，剩余 advisory 必须完整记录其路径、影响和后续处理。
- 不将 setup.bat、scripts/ensure-pwsh.ps1 或 bundled pwsh 复制进 npm package。源码安装仍可由 setup.bat 显式联网安装固定 hash 的 pwsh，npm 运行期继续只发现本地已有候选。

### 现状证据与根因

截至 2026-08-28 的初始审计：

- package.json 精确锁定 SDK 1.29.0，但 pnpm-lock.yaml 解析出 body-parser 2.2.2、fast-uri 3.1.2、ip-address 10.2.0、hono 4.12.27 和 @hono/node-server 1.19.14；pnpm audit --prod 返回 4 high、6 moderate、2 low。
- SDK 1.29.0 的依赖声明仍允许修复版本：body-parser >=2.3.0、fast-uri >=3.1.5、ip-address >=10.3.1，Hono/adapter 也有同一主版本内的修复版本；因此无需绕过既有 SDK wire 兼容决策。
- package.json 没有 prepack；npm/pnpm pack 可以复用一个旧的 build/，所以源码和发布物可能不一致。
- tsconfig 当前生成的 JavaScript source map 没有 sourcesContent，而 package files 只发布 build/，导致 npm tarball 内 source map 指向包外 ../src 文件。
- README 的 Quick Start 把 npm install 和源码 checkout 才存在的 setup.bat 放在同一段，npm consumer 无法按文档完成安装。
- 当前 postinstall 通过 INIT_CWD/npm_config_local_prefix 扫描多个 node_modules 根；在 consumer 有另一个 SDK 时存在误改非 package-owned 依赖的范围风险。模式失配只 warning 且退出 0，也可能让 required:[] 兼容性回退静默。
- npm pack --dry-run 已能看到 build 与基本文档，但没有验证 manifest 约束、入口可执行性、source map 自包含性、tarball checksum 或 clean consumer 独立启动。

## 2. 设计方案

### 2.1 依赖和 lockfile

1. 保留 package.json 中 @modelcontextprotocol/sdk: 1.29.0 以及与其一致的 exact override；保留 zod v3 兼容决策。
2. 只刷新 SDK 依赖范围内的传递依赖，并将安全修复版本写入 pnpm-lock.yaml。若仅刷新 lockfile 不能稳定得到修复版本，才在现有 overrides 位置增加最小、带原因的精确 override；每个 override 都要有 audit 路径和兼容性测试证据。
3. 不把 E:/pnpm/v11 或任何维护者机器路径写入 package.json、pnpm-lock.yaml、源码、package 或报告中的契约字段。
4. 增加 audit:prod 脚本，使用 pnpm audit --prod --audit-level=high；不通过降低 audit level、删除报告或 continue-on-error 解除 high/critical。
5. 依赖升级后必须执行 build、tsc、lint、全量 test、latency、tools coverage、package verifier 和 clean consumer；SDK patch 单测必须同时覆盖旧 fixture、幂等、布局消失、模式失配和 package-owned 定位。
6. package scripts 中引用的维护时可执行文件必须在 devDependencies 中显式声明；当前 dev 入口依赖 tsx，因此补齐 tsx devDependency 和 lockfile，不能依赖其他 MCP checkout 或全局安装。

### 2.2 SDK patch 链

postinstall 继续使用零依赖 scripts/apply-mcp-sdk-patch.mjs，但收敛为以下流程：

1. 从 packageRoot 的 Node module resolution 解析 @modelcontextprotocol/sdk/server/mcp.js，再向上定位其 package.json；只把解析到的依赖视为 package-owned SDK。删除 INIT_CWD 和 npm_config_local_prefix 的宽泛扫描作为主路径。
2. 如果 package-owned SDK 不存在，输出可审计的 skipped/not-found 并保持退出码 0；正常 npm/pnpm 安装依赖成功时不应依赖这个分支。
3. 如果存在但版本不是 1.29.0，或者 dist/esm、dist/cjs 的目标布局均不存在，输出 ERROR 并退出 1。
4. ESM/CJS 目标都按“已应用 → 可精确匹配并应用 → 模式失配”顺序处理。模式失配不再只是 warning 继续安装，而是退出 1，避免运行时 schema 兼容回退；只要目标 flavor 不存在但另一个 flavor 存在，仍按 SDK 发布布局正常处理。
5. 脚本只写目标 SDK 的 mcp.js，并通过同目录临时文件 + 原子替换提交；失败尽力清理临时文件，不联网、不创建工具二进制、不改变 package.json、lockfile 或其他 consumer 依赖。

### 2.3 source/npm 双 bootstrap

| 场景 | 入口 | 依赖 | 网络 | 成功信号 |
|---|---|---|---|---|
| 源码维护 | setup.bat | Node 20+、Corepack/pnpm 11.21.0、checkout | 显式 setup 阶段可下载固定 pwsh | frozen install、build、可选 pwsh probe 全部成功 |
| npm consumer | npm install enhanced-terminal-mcp 或 npx enhanced-terminal-mcp@4.0.0 | Node 20+、npm；安装脚本允许执行 | install/start 不下载 pwsh 或其他 runtime | bin/build/index.js 存在、shebang 正确、MCP stdio 启动 smoke 成功 |
| npm consumer 无 pwsh | 同上 | Windows PowerShell 5.1 或 PATH 中 pwsh，按平台现状 | 运行期零网络 | shell resolver 记录本地 fallback，不把缺少 bundled pwsh 报成 package 损坏 |

README 要将 source checkout 和 npm consumer 分成两个互不混淆的小节，并明确 npm package 不包含 setup.bat、tools/pwsh 和 Everything fixture。MCP 配置示例优先使用 bin；源码开发示例才使用 node build/index.js。源码 pwsh bootstrap 使用固定版本/hash、120 秒下载超时、250 MB 下载上限和 staged reparse-point 拒绝；运行期仍零网络。

### 2.4 构建和 package 边界

1. 增加 prepack: npm run build。npm pack、pnpm pack 和 npm publish 前都先执行 clean build，防止删除/重命名源码后的孤儿 build 文件进入包。
2. tsconfig 增加 inlineSources，使发布的 JS source map 自包含 source content；不把整个 src/ 目录加入 npm package。
3. 增加 types: build/index.d.ts，保持 main/bin 指向 build/index.js；不新增 exports 限制，避免改变已有直接 build 子路径消费者。
4. package files 只保留 build/、scripts/apply-mcp-sdk-patch.mjs、README.md、CHANGELOG.md 和 LICENSE；clean-build.mjs 只属于源码 prepack，不属于 consumer 运行期。
5. 新增标准 MIT LICENSE 文件，使 license: MIT 有可交付的许可证文件。
6. 包内必须有 package.json、入口 JS、入口 d.ts、入口 source map、README、CHANGELOG、LICENSE 和 patch script；必须排除 src/、tests/、pnpm-lock.yaml、package-lock.json、node_modules/、.etmcp/、setup.bat、es_tool/、tools/pwsh/、机器路径。

### 2.5 可重复 release verifier

新增 scripts/verify-package.mjs，保持零运行时依赖，职责限定为：

1. 在项目内 non-C state/temp 目录创建短生命周期 pack destination。
2. 执行 npm pack --json --ignore-scripts 生成实际 tarball，解析 npm 返回的 files 清单。
3. 校验 manifest 的 name/version/main/bin/types/files/prepack/postinstall 和预期 package 内容。
4. 校验 build/index.js 的 Node shebang 和 node --check；校验发布的 JS source map 至少包含 sourcesContent，且不需要 package 外的源码才能调试。
5. 校验 forbidden path 零命中，计算实际 tarball SHA-256，并向 stdout 输出 stable JSON evidence；失败返回非零退出码。
6. 不把 checksum 写入源码或 package manifest；CI/release runner 可以将 stdout、tarball checksum、SBOM 和 provenance 作为同一 release evidence 保存。

package.json 不暴露源码侧 verifier script，避免 npm consumer 看到一个发布包内不存在的维护命令。维护者在源码 checkout 中使用 npm run build 后直接执行 node scripts/verify-package.mjs 和 node scripts/verify-clean-consumer.mjs。两个脚本都不负责发布、不上传、不签名，避免把本地验证误认为 provenance。

## 3. 挂载点

1. 依赖入口：package.json、pnpm-lock.yaml、audit:prod。
2. 安装兼容：scripts/apply-mcp-sdk-patch.mjs、tests/unit/sdk-patch.test.ts。
3. 构建/发布：tsconfig.json、package.json 的 prepack/files/types、scripts/verify-package.mjs。
4. Bootstrap 文档：README.md、setup.bat、CHANGELOG.md。
5. 许可证：LICENSE。
6. clean consumer 与 release evidence：scripts/verify-clean-consumer.mjs、scripts/verify-package.mjs、.etmcp/release 临时目录。

## 4. 实现维度

- 健壮性：L3。所有外部依赖、安装布局、manifest、tarball 内容和命令结果都有明确失败语义。
- 结构：modules。patch、package verifier、bootstrap 和 package metadata 分属独立职责。
- 性能：budgeted。验证只打包一次并在项目内临时目录清理；运行时不新增网络或依赖加载。
- 可读性：public。package/consumer 行为要能由 README、manifest 和 verifier 输出独立解释。
- 可演进性：stable。SDK 版本边界、发布文件边界和脚本输出字段不随普通依赖刷新而漂移。
- 可观测性：logged。postinstall 和 verifier 输出稳定、可搜索、无 secret；provenance 上传由 CI 负责。
- 可测试性：verified。单测、实际 tarball、clean consumer、audit 和全量门禁共同证明。
- 安全性：hardened。postinstall 权限范围收窄，依赖 high/critical 阻断，发布包无隐藏本地资产。
- 兼容性：backward-compatible。保留 SDK 1.29.0 wire/API 基线、npm consumer 和 source setup 两条路径。
- 幂等性：idempotent。重复 install、patch、build、pack verifier 不产生重复 lockfile 或持久化临时状态。

## 5. 验收场景

1. 当前 lockfile 的依赖 audit 初始结果可复现，更新后 high/critical 为 0；若仍有低/中危，报告完整保留 advisory、路径和决定。
2. SDK 仍为 1.29.0，zod 仍为 v3，依赖刷新没有引入 1.30 wire/API 变化。
3. pnpm install --frozen-lockfile 在源码 checkout 成功且不生成第二 lockfile。
4. npm clean consumer 安装 tarball 时 postinstall 能定位 package-owned SDK；consumer 根另有一个不同 SDK 时不修改它。
5. fresh SDK fixture patch 成功且第二次运行幂等。
6. SDK dist 布局消失、版本错误或模式失配时 postinstall 非零失败；SDK 完全不存在时仅跳过。
7. 修改源码后直接 npm/pnpm pack，prepack 自动 clean build；发布包不含旧 build 文件。
8. JS source map 含 sourcesContent；入口 JS 有 shebang，node --check 成功，types/main/bin 一致。
9. package files 清单不含 source、tests、lockfile、node_modules、state、setup.bat、es.exe、bundled pwsh 或机器路径。
10. release verifier 输出真实 tarball 文件数、manifest checks、入口检查、map 检查和 SHA-256；任一失败返回非零。
11. source setup.bat 在源码 checkout 中继续执行 frozen install/build，并将 pwsh 下载限制在显式 bootstrap；失败不输出成功。
12. npm consumer 不需要 setup.bat、pnpm、源码目录或 pwsh 下载即可启动；Windows 无 bundled pwsh 时按既有 fallback 运行。
13. repeated build/pack/install/verifier 后工作树没有第二 lockfile、未忽略的 tarball、state 或 cache 越界文件。
14. npm package 具有 MIT LICENSE，README 的 npm/source bootstrap、工具入口和 runtime network boundary 与实际包一致。
15. release evidence 可以由 verifier JSON、audit、lockfile、SBOM 和 CI provenance 组合生成；本地 checksum 不被误称为签名或 provenance。
16. pnpm run dev 的 tsx 入口在干净源码安装中可解析；缺少全局 tsx 不影响维护者启动，tsx 不进入 production dependencies 或 npm package。
17. ensure-pwsh.ps1 具备固定下载超时、大小上限和 staged executable reparse 检查；失败会清理 staging，不输出安装成功。

## 6. 反向检查与明确拒绝

- 不接受只升级 package.json 而不更新 pnpm-lock.yaml。
- 不接受只跑源码 test 而不检查实际 tarball 和 clean consumer。
- 不接受保留高危 advisory 后用“SDK 间接依赖”作为默认豁免理由。
- 不接受 postinstall 继续扫描/修改 consumer 不属于本 package 的 SDK。
- 不接受 npm README 继续要求 consumer 执行 package 内不存在的 setup.bat。
- 不接受把 build/旧文件、source map 外部引用、机器 store path 或状态目录发布出去。
- 不接受通过 --ignore-scripts 的 consumer 安装结果宣称 SDK compatibility patch 已生效；该边界必须在文档中明确。
- 不接受在本 feature 中升级 SDK 1.30.0、加入运行时 SBOM 库或把 CI provenance 伪装成本地签名。
