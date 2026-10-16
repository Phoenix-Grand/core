# kubuno-mcp

The protocol core of Kubuno's [Model Context Protocol](https://modelcontextprotocol.io)
server: it answers MCP's JSON-RPC 2.0 messages and leaves the list of tools, their
execution and the transport to the caller.

This crate is a workspace member of the core, used by the core only; it is not
published under a tag for modules.

---

## What it handles

| Method | Answer |
|---|---|
| `initialize` | protocol version `2025-06-18`, the `tools` capability, the server's name and version |
| `ping` | an empty result |
| `tools/list` | the tools returned by the provider |
| `tools/call` | the provider's result, as a single `text` content item with `isError` |
| a notification (no `id`, e.g. `notifications/initialized`) | no response |
| anything else | JSON-RPC error `-32601` (unknown method) |

A `tools/call` without a tool name returns `-32602` (invalid params).

## API

```rust
#[async_trait]
pub trait McpToolProvider: Send + Sync {
    async fn list_tools(&self) -> Vec<Tool>;
    async fn call_tool(&self, name: &str, arguments: Value, user_id: Uuid) -> ToolCallResult;
}

pub async fn handle_message(
    provider: &dyn McpToolProvider,
    user_id: Uuid,
    server_name: &str,
    server_version: &str,
    msg: &Value,
) -> Option<Value>;
```

- `Tool { name, description, input_schema, annotations }` - serialised with MCP's
  field names (`inputSchema`).
- `ToolCallResult::text(..)` / `ToolCallResult::error(..)` - the outcome of a call.
- `handle_message` returns `None` for notifications and `Some(response)` otherwise.

Every call carries the id of the user it runs for, so a provider can apply that
user's rights.

## How the core uses it

The core implements `McpToolProvider` over the tools the running modules declare at
registration, and executes a call by proxying it to the owning module. It serves
two endpoints over HTTP:

- `POST /mcp` - for MCP clients, authenticated by a personal Kubuno API token
  and nothing else (the token gives the user and its scope);
- `POST /internal/mcp` - for trusted modules acting on a user's behalf (the
  assistant, mid-conversation), authenticated by the module's internal secret,
  with the user named in `x-kubuno-user-id`.

Both answer `404` while the MCP server is switched off in the instance settings.
Tool annotations pass through untouched; Kubuno uses them for hints such as a
confirmation request or a tool meant to be dispatched in the client.

## License

[AGPL-3.0-or-later](../../LICENSE) © Kubuno contributors.
