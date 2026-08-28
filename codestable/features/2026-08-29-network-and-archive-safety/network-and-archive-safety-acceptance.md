---
doc_type: feature-acceptance
feature: 2026-08-29-network-and-archive-safety
requirement:
roadmap: production-hardening
roadmap_item: network-and-archive-safety
status: done
summary: 对照设计完成 SSRF/zip 防护验收；纯 Node 下载客户端与 ZIP 解压器全部落地（SSRF 校验、直连已验证 IP、逐跳 redirect、双路预算、staging 两阶段解压），三轮反向审计修复 validateTarget 告警误判与取消映射缺陷，门禁全绿后回写 CodeStable
tags: [production, hardening, ssrf, redirect, download, zip-slip, zip-bomb, archive, egress, acceptance]
created: "2026-08-29"
last_reviewed: "2026-08-29"
---

# network-and-archive-safety 验收

> 验收方式：用户已授权代理代为执行整个 CodeStable 流程（含验收与多轮审计），本报告由代理对照 approved design 逐场景核对后出具。
> 验收日期：2026-08-29
> 对应 design：`network-and-archive-safety-design.md`；checklist 11 checks 全部 passed。

## 1. 交付对照

| design 交付 | 落地 | 证据 |
|---|---|---|
| `src/network-policy.ts`（URL/SSRF/redirect/客户端） | ✅ | classifyIp 分类矩阵（restricted/forbidden/normal，IPv4-mapped 归一）、parseUrlPolicy（凭据拒绝）、validateTarget（IP 字面量零 DNS / lookup all）、downloadToFile（直连已验证 IP + servername=SNI、逐跳重验、staging 字节计数） |
| `src/zip-policy.ts`（manifest/两阶段解压） | ✅ | EOCD/ZIP64 定位 + CD 解析、validateMemberName（traversal/驱动器号/绝对路径/保留设备名/控制字符/超长）、classifyEntry（symlink/device 拒绝）、加密 flag 拒绝、stored/deflate 流式解压 + 实时计数 |
| `download_file` 换纯 Node 客户端 | ✅ | `Invoke-WebRequest`/`curl` 不再使用；`getDownloadSpec`/`getExtractSpec` 保留未调用（platform.ts 兼容面） |
| `extract_archive` 换 ZIP 读取器 | ✅ | 阶段一 manifest 全量校验零写入 → 阶段二 staging 解压（`.etmcp-extract-*`）→ 顶层逐项 rename（-Force 语义）→ 清 staging |
| `compress_archive` 输入预算 | ✅ | measureSourceTree 有界预演（member/byte 双上限），spawn 前拒绝 |
| `network_info` egress | ✅ | ping/dns target 经 validateTarget；默认 allow-private 诊断不受影响；deny-private 下 restricted 拒绝 |
| 配置表（9 个环境变量） | ✅ | README 全量文档；envInt strict 解析 |
| proxy 不支持 | ✅ | 纯 node:http/https 零代理变量读取；README 声明 |
| security.ts 零改动 | ✅ | validateUrl/validateHost 复用未修改 |

## 2. 验收场景核对（design §5 场景 1-10）

1. **SSRF 默认拒绝** ✅ `tests/unit/network-policy.test.ts`：deny-private 默认下 127.0.0.1/10.x/192.168.x/169.254.169.254/[::1]/100.64.0.1 全部 `SSRF_BLOCKED`（连接前拒绝）；allow-private 下本地 http server 下载成功、字节计数正确、无 staging 残留。
2. **URL 校验** ✅ ftp/file 协议拒绝、`user:pass@` 凭据拒绝（`URL_INVALID`）、端口/hostname 解析正确。
3. **redirect 逐跳重验** ✅ 本地链 302→200 跟随成功（hits=2 证明逐跳）；`MCP_DOWNLOAD_MAX_REDIRECTS=2` 循环 → `RESOURCE_LIMIT`；forbidden 目标（224.0.0.1）在 allow-private 下仍被拒。
4. **预算三路径** ✅ 100 字节预算下 10000 字节响应 → `RESOURCE_LIMIT`；1000ms deadline 慢流 → `TIMEOUT`；AbortSignal 80ms 取消 → `CANCELLED`；三者 staging 均清理。
5. **恶意成员** ✅ `../evil.txt` manifest 阶段拒绝且 outDir 零写入；`C:\`、绝对路径、UNC、`CON`/`NUL.txt` 保留设备名、控制字符、超长名单测覆盖；symlink（unix mode）/加密 flag（bit0/bit6）拒绝。
6. **zip bomb 双路** ✅ CD 谎报展开 5000（member budget=1024）manifest 拒绝；CD 谎报 100 但 deflate 实际展开 10MB → 实时计数拦截 + staging 清理；declaredExpanded=100MiB/declaredCompressed=100KiB（ratio 1024>200）manifest 拒绝。
7. **正常 zip** ✅ stored+deflate 混合、嵌套目录、UTF-8 中文名解压成功（extracted=3、bytes 精确）；local header 名与 CD 不一致 → `ARCHIVE_FAILED`；`MCP_ARCHIVE_MAX_INPUT_BYTES=10` 的 compress 源在 spawn 前被 `RESOURCE_LIMIT` 拒绝且无产物。
8. **e2e 自兼容** ✅ latency 套件 compress→extract 真实流程通过（Compress-Archive 产物被新解压器消费）；反斜杠 entry 名归一化处理。
9. **network_info egress** ✅ `MCP_SSRF_MODE=deny-private` 下 ping 127.0.0.1 → `SSRF_BLOCKED`（spawn 前）；默认模式诊断不受影响（allow-private 分类单测覆盖）。
10. **兼容与门禁** ✅ 最终 `pnpm run gate` EXIT=0：build/tsc/lint 全绿、全量 56 文件 736 用例、latency 24/24、tools coverage 58.27/47.88/65/61.78（阈值 55/45/60/55）；`git diff --check` 通过；既有 709 用例零删改（新增 27 + archive 错误映射保持）。

## 3. 代用户三轮反向审计记录

- **轮 1（checklist 证据核对）**：发现 3 个验收场景缺直接测试证据（ratio 守卫、compress spawn 前预算、network_info egress 拒绝）→ 各补一条用例闭环。
- **轮 2（对抗复查）**：发现真实缺陷——`validateTarget` 把非法 `MCP_SSRF_MODE` 的回落告警当作致命错误返回（导致配置打错字后 download/network_info 全部不可用，与"回落默认"设计不符）→ 改为告警随结果回传、由调用方记录后按回落模式继续；补 TS 判别联合 `kind` 判别符消除 narrowing 缺陷。
- **轮 3（断言与二进制对抗）**：测试自建 ZIP 构造器两处布局缺陷（缺 versionNeeded、缺 internalAttr 位）被解析器正确识别为损坏——反向证明解析器对错位字节不宽容；取消路径缺陷——`req.destroy(err)` 的错误对象在 res 流上退化为 ECONNRESET 导致映射成 `EXECUTION_FAILED`，改为按 abort/deadline 状态优先判定；并修复 req error 先于流清理 settle 的竞态（CANCELLED 时 staging 残留）。
- 终轮无新问题，审计停止。

## 4. 行为收紧记录（预期内，非回归）

- `download_file` 默认拒绝 restricted 范围目标（云 metadata/内网/loopback），redirect 不再盲随；100 MiB 字节上限 + 总 deadline 生效。
- `extract_archive` 拒绝 traversal/链接/设备/加密/超预算归档；解压不再依赖外部 unzip/Expand-Archive 的隐式行为。
- `compress_archive` 超预算源树在 spawn 前拒绝。
- `network_info` 在显式 deny-private 下拒绝 restricted 目标（默认不改变本机诊断体验）。

## 5. 归属与遗留

- `network_info`/`process_list`/`get_system_info` 的 capability 准入矩阵（sandboxed profile 禁用/租户化）→ `tool-wrapper-and-surface-contract`。
- extract 压缩数据以 entry 为粒度整读（上界为归档文件尺寸）；流式压缩数据读取可作后续优化，不构成安全缺口（预算双路生效）。
- ZIP 写入侧仍走外部命令（无 zip-bomb 面）；`getDownloadSpec`/`getExtractSpec` 保留未调用，platform.ts 兼容面收敛建议归 `cs-refactor`。
- Windows 长路径/设备名在 staging 阶段由校验层拒绝（CON/NUL 等），reparse point 依赖 rename 既有语义（design §4 已声明）。

## 6. 结论

REL-04/SEC-07 的本 feature 范围内交付全部落地并通过门禁；roadmap 第 7 条标记 `done`，剩余 planned 条目：#8 audit-health（依赖已满足）、#9 tool-wrapper（依赖已满足）、#10 search-correctness（等 #9）、#12 conformance-gates（等 #6/#7/#8/#9/#10）、#13 docs-closeout（等 #12）。
