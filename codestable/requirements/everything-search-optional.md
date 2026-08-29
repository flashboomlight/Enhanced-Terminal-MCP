---
doc_type: requirement
slug: everything-search-optional
pitch: Windows 上有 Everything 时加速搜索，没有时也能正常搜索，而且不会自动下载未知程序
status: current
last_reviewed: "2026-08-29"
implemented_by:
  - 2026-08-21-publish-es-optional
  - 2026-08-29-search-and-adaptive-correctness
tags: [windows, search, everything, supply-chain, fallback]
---

# Windows Everything 可选搜索

## 用户故事

- 作为 Windows 用户，我希望机器上有 Everything 时可以获得更快的文件名搜索。
- 作为没有安装 Everything 的用户，我希望普通文件搜索仍然可用，而不是整个搜索功能失效。
- 作为部署人员，我希望服务只使用我明确提供并通过校验的 `es.exe`，不会在后台下载或执行未知文件。
- 作为排查问题的人，我希望知道 Everything 为什么不可用，以及应该配置哪里。

## 为什么需要

Windows 上的 Everything 可以提供很快的文件名搜索，但它不是每台机器都有，也不应该因为安装 MCP 服务就自动带入或下载一个额外的二进制文件。普通搜索需要继续可用，同时错误配置不能被静默隐藏，否则用户很难判断实际使用了哪个程序。

## 怎么解决

服务会优先使用用户明确配置的 Everything 程序；没有明确配置时，再检查项目状态目录中的本地程序。程序只有在文件类型和固定完整性校验都通过后才会执行。普通文件搜索在没有可用程序时自动使用原生搜索；专用 Everything 搜索会返回清楚的失败原因和配置提示。

## 边界

- 只支持 Windows 上的 Everything CLI；其他系统继续使用原有搜索能力。
- 服务不会下载、安装或升级 Everything；用户需要自己提供经过信任的 `es.exe`。
- 显式配置的路径无效时会直接报告错误，不会偷偷改用另一个隐藏路径。
- `search_files` 可以在没有 Everything 时走原生搜索；`everything_search` 没有可用程序时不会伪装成空结果。
- 仓库中的 `es_tool/es.exe` 只用于开发和测试，不是生产默认路径，也不进入 npm 发布包。
