# Third-Party Notices

Enhanced Terminal MCP uses and interoperates with third-party software. This file
records attribution and distribution boundaries for those components.

## Model Context Protocol TypeScript SDK

`@modelcontextprotocol/sdk` 1.29.0 (pinned exactly)

License: MIT
Copyright (c) 2024 Anthropic, PBC

The full license text ships with the package
(`node_modules/@modelcontextprotocol/sdk/LICENSE`). Note that the upstream
project has announced an MIT → Apache-2.0 licensing transition for later
versions; this notice covers the pinned 1.29.0, and the license of any future
upgrade must be re-checked at upgrade time.

Enhanced Terminal MCP applies a compatibility patch to
`@modelcontextprotocol/sdk` 1.29.0 at install time
(`scripts/apply-mcp-sdk-patch.mjs`, source diff in
`patches/@modelcontextprotocol+sdk+1.29.0.patch`). The upstream project retains
its original copyright and license; the changes in that patch are part of
Enhanced Terminal MCP.

## Zod

Zod is used as a runtime dependency and is distributed under the MIT License.

Copyright (c) 2020 Colin McDonnell.

## Everything (voidtools)

Enhanced Terminal MCP optionally interoperates with Everything and its
command-line interface (`es.exe`) by voidtools on Windows.

Everything and ES are **not** distributed as part of Enhanced Terminal MCP —
neither in the source repository nor in the npm package. Users who choose to
use this integration must obtain Everything/ES separately from voidtools and
point Enhanced Terminal MCP at their own copy via `ENHANCED_TERMINAL_ES_PATH`
or `<state-dir>/tools/es.exe`.

Everything is a product of voidtools / David Carpenter.

## PowerShell 7 (pwsh)

On Windows, the optional source-checkout bootstrap (`setup.bat` →
`scripts/ensure-pwsh.ps1`) can download a portable PowerShell 7 build from its
official release at a fixed version with SHA-256 verification. PowerShell is
open source under the MIT License (Copyright (c) Microsoft Corporation). No
PowerShell binary is vendored in this repository or in the npm package, and the
MCP server itself never downloads anything at runtime.
