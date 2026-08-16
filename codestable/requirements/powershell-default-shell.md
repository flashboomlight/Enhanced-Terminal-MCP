---
doc_type: requirement
slug: powershell-default-shell
pitch: Windows 上的命令执行默认提供稳定的 PowerShell 体验，同时保留明确可用的兼容选择。
status: current
last_reviewed: 2026-08-16
implemented_by:
  - ARCHITECTURE
tags: [windows, command-execution, powershell]
---

# Windows 默认 PowerShell 命令执行

## 用户故事

- 作为 Windows 用户，我希望直接执行命令时默认获得现代 PowerShell 语义和稳定的中文输出，不必先手工配置 shell。
- 作为部署人员，我希望项目能优先使用固定、可验证的便携 PowerShell；安装失败时不会留下半成品，也不会让服务在运行期偷偷联网。
- 作为需要兼容旧脚本的维护者，我希望能够明确切换到 Windows PowerShell 5.1 或 `cmd.exe`，并知道切换配置何时生效。

## 为什么需要

原来的 Windows 默认命令路径依赖 `cmd.exe`，而部分工具又单独使用 PowerShell，导致同一个服务里的命令语义、编码和可复现性不一致。部署环境缺少统一的 PowerShell 版本时，还容易出现中文乱码或“本机能跑、换机器失效”的情况。

## 怎么解决

Windows 命令执行会按固定顺序寻找可用的 PowerShell，优先使用项目携带的可验证版本，再使用系统已有版本，并在必要时回退到 Windows PowerShell 5.1。命令输出统一按 UTF-8 处理，同时保留 `MCP_SHELL=cmd` 和 `MCP_SHELL=powershell` 作为明确的兼容选择。配置在服务进程内保持稳定，修改后通过重启生效。

## 边界

- 只改变 Windows 的默认命令执行选择，Unix 仍使用原有 shell 行为。
- 服务运行期间不下载或自动升级 PowerShell；便携版本需要通过显式的 Windows setup 流程安装。
- 用户显式指定的 PowerShell 路径无效时会报告错误，不会静默改用另一个执行器。
- 选择 `cmd` 只保证旧的 cmd 执行路径仍可用，不承诺 PowerShell 语法与 cmd 语法互相兼容。
- 若机器没有可用的 PowerShell 且未选择 `cmd` 兼容档，命令执行会返回可操作的配置错误。
