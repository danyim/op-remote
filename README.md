# @wyattjoh/op-remote

CLI and MCP server for remote 1Password secret access with Telegram-based
approval. Designed for AI agents (Claude Code, etc.) that need secrets at
runtime without exposing them in plaintext config files or conversation context.

## How it works

1. At startup, the **MCP server** (`op-remote serve --env-file=.env.tpl`)
   reads the project's `.env.tpl` and uses `op run` to resolve every `op://`
   reference into its own process environment. This happens once, while the
   user is present to authenticate with 1Password. **No `.env.tpl` means no
   secrets are loaded and the pipeline is inert**, so each project that needs
   remote secret access must provide one.
2. The server exposes a `request_token` MCP tool that returns a one-time token
   and Unix socket path.
3. The **CLI** (`op-remote run`) is called by the agent with the token, the
   same `.env.tpl`, and the command to run. It connects to the MCP server's
   Unix socket to request the secrets named in the file.
4. The MCP server sends a **Telegram approval request** with inline buttons
   (Approve, Reject, Auto-Approve, Stop). The approver can also reply with a
   reason when rejecting.
5. On approval, secrets are injected into the subprocess environment. All
   stdout/stderr output is **masked** to prevent secret leakage.

## Install

### Claude Code Plugin (Recommended)

Install via the plugin marketplace:

```shell
/plugin marketplace add wyattjoh/claude-code-marketplace
/plugin install op-remote@wyattjoh-marketplace
```

Then configure the Telegram credentials via the plugin's user config. The
plugin's MCP config is pre-wired with `--env-file=.env.tpl`, so each project
that uses op-remote only needs a `.env.tpl` at its root listing the project's
`op://` secret references (see [Project `.env.tpl`](#project-envtpl-required)
below).

### npm (global)

```bash
npm install -g @wyattjoh/op-remote
```

Or with Bun:

```bash
bun install -g @wyattjoh/op-remote
```

## Configuration

### Environment variables

| Variable                          | Required    | Description                                                                      |
| --------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `REMOTE_OP_APPROVAL_PROVIDER`     | No          | Approval channel: `telegram` (default) or `slack`                                |
| `REMOTE_OP_TELEGRAM_BOT_TOKEN`    | If telegram | Telegram bot token for sending approval requests                                 |
| `REMOTE_OP_TELEGRAM_CHAT_ID`      | If telegram | Telegram chat ID to send approval messages to                                    |
| `REMOTE_OP_TELEGRAM_APPROVER_IDS` | No          | Comma-separated Telegram user IDs allowed to approve/reject (all users if unset) |
| `SLACK_BOT_TOKEN`                 | If slack    | Slack bot token (`xoxb-...`) for posting approval requests                       |
| `SLACK_APP_TOKEN`                 | If slack    | Slack app-level token (`xapp-...`, Socket Mode, `connections:write`)             |
| `SLACK_CHANNEL_ID`                | If slack    | Slack channel ID to send approval messages to (bot must be a member)             |
| `SLACK_APPROVER_IDS`              | No          | Comma-separated Slack user IDs allowed to approve/reject (all users if unset)    |
| `REMOTE_OP_TIMEOUT`               | No          | Approval timeout in seconds (default: `120`)                                     |

When installed as the Claude Code plugin, the Telegram variables above are
supplied via the plugin's user config and do not need to be set manually.

### Slack provider setup

To use Slack for approvals instead of Telegram, set
`REMOTE_OP_APPROVAL_PROVIDER=slack` and configure a Slack app:

1. Create an app at https://api.slack.com/apps (or reuse an existing one).
2. Under **Socket Mode**, enable **Enable Socket Mode** and generate an
   **app-level token** with the `connections:write` scope — that's your
   `SLACK_APP_TOKEN`. Slack allows up to 10 concurrent Socket Mode
   connections per app (one per app-level token), so a second app-level token
   for the same app works alongside an existing consumer such as a bot
   gateway without disrupting it.
3. Under **OAuth & Permissions**, add the `chat:write` bot scope (add
   `chat:write.public` if the bot posts to public channels without being
   invited), install the app to your workspace, and copy the **bot token**
   (`xoxb-...`) — that's your `SLACK_BOT_TOKEN`.
4. Invite the bot to the channel you want approvals in
   (`/invite @your-app`) and use that channel's ID as `SLACK_CHANNEL_ID`
   (right-click the channel > **View channel details** > copy the channel ID,
   or via the API).
5. Optionally set `SLACK_APPROVER_IDS` to restrict who may respond.

Approval messages render as a Block Kit card with **Approve** / **Reject** /
**Auto-Approve** / **Stop** buttons; Reject/Stop open a modal to capture a
reason. Messages are updated in place on every decision, and secrets never
appear in Slack — only variable names, the command, and the working
directory.

### Project `.env.tpl` (required)

Every project that wants remote secret access must have a `.env.tpl` file at
its root. The plugin's MCP config passes `--env-file=.env.tpl` to
`op-remote serve`, so at server startup the file is read and all `op://`
references are resolved via `op run` into the server's process environment.
The resolved secrets are what later requests from `op-remote run` draw from.

```
# Plain values are passed through directly
DATABASE_HOST=localhost
DATABASE_PORT=5432

# op:// references are resolved once at server startup
DATABASE_PASSWORD=op://Development/my-app-db/password
API_KEY=op://Development/my-app-api/credential
```

The same file format is consumed in two places:

- **MCP server startup** reads it to resolve `op://` references up front
  (requires an interactive `op` session, so this happens while the user is
  present).
- **`op-remote run`** reads it to know which variable names to request from
  the server and which plain values to pass through directly.

Lines with `op://` values become secret requests. All other key-value pairs
are injected as plain environment variables. Comments and blank lines are
ignored. If `.env.tpl` is missing, the server starts normally but has no
secrets to serve, so no `op-remote run` invocation will succeed.

## MCP client configuration

If you are not using the Claude Code plugin, add the server to your
`.mcp.json` or `~/.claude/.mcp.json`. Pass `--env-file=.env.tpl` so the server
loads the project's secrets at startup:

```json
{
  "mcpServers": {
    "op-remote": {
      "command": "op-remote",
      "args": ["serve", "--env-file=.env.tpl"],
      "env": {
        "REMOTE_OP_TELEGRAM_BOT_TOKEN": "your-bot-token",
        "REMOTE_OP_TELEGRAM_CHAT_ID": "your-chat-id"
      }
    }
  }
}
```

The server will shell out to `op run --env-file=.env.tpl` internally to
resolve the project's `op://` references, so `op` must be installed and
authenticated at server start.

To keep the Telegram credentials out of plaintext config as well, wrap the
whole command in `op run` and point the Telegram env vars at 1Password
references:

```json
{
  "mcpServers": {
    "op-remote": {
      "command": "op",
      "args": ["run", "--no-masking", "--", "op-remote", "serve", "--env-file=.env.tpl"],
      "env": {
        "REMOTE_OP_TELEGRAM_BOT_TOKEN": "op://Development/op-remote-telegram/bot-token",
        "REMOTE_OP_TELEGRAM_CHAT_ID": "op://Development/op-remote-telegram/chat-id"
      }
    }
  }
}
```

Here the outer `op run` resolves the Telegram references in `env` before
spawning `op-remote serve`, and the server then performs its own
`op run --env-file=.env.tpl` pass to load the project's secrets at startup.
`--no-masking` is required because the MCP server speaks JSON-RPC over stdio,
and `op run`'s default stdout masking would corrupt that stream if any
resolved secret happened to match a protocol byte sequence.

## Usage

### Agent workflow

The agent calls the `request_token` MCP tool, then uses the returned token and
socket path to run commands with secrets:

```bash
op-remote run \
  --token=TOKEN \
  --sock=SOCKET_PATH \
  --env-file=.env.tpl \
  --reason="Running database migration" \
  -- npm run migrate
```

### MCP tools

| Tool                   | Description                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `request_token`        | Returns a one-time token and Unix socket path for authenticating with the CLI              |
| `resume`               | Request to resume a stopped session (requires approval via the configured provider)        |
| `disable_auto_approve` | Turn off auto-approval, requiring approval via the configured provider for future requests |

### Approval buttons

When a secret access request is sent to the approval channel, the approver sees:

- **Approve** - allow this single request
- **Reject** - deny the request (prompts for a reason — a reply in Telegram, a modal in Slack)
- **Auto-Approve** - approve this and all future requests in the session
- **Stop** - reject and halt the session entirely (the agent is instructed to stop)

## Security

- **One-time tokens** prevent replay attacks. Each token can only be used once.
- **Unix socket permissions** are set to `0600`, restricting access to the current user.
- **Output masking** replaces secret values in stdout/stderr with `<redacted>`.
- **Token reservation** prevents concurrent use of the same token.
- **Approver restrictions** optionally limit who can approve requests via Telegram user IDs.
- **Timeout** ensures abandoned requests don't hang indefinitely.

## Development

```bash
bun install
bun run build              # transpile to dist/ (Node.js target)
bun run lint               # oxlint
bun run fmt                # oxfmt
bun run typecheck          # tsc --noEmit
bun test                   # run tests
```

## License

MIT
