# patches/

## `@modelcontextprotocol+sdk+1.29.0.patch`

Compatibility patch for `@modelcontextprotocol/sdk` 1.29.0.

The upstream project retains its original copyright and license. The changes in
this patch are part of Enhanced Terminal MCP (MIT License).

The patch is applied at install time by the zero-dependency
`scripts/apply-mcp-sdk-patch.mjs` (`postinstall`), which resolves only the
package-owned SDK copy and fails closed on version, layout, or pattern drift.
See `THIRD_PARTY_NOTICES.md` for the full attribution summary.
