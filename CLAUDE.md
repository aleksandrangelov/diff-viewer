# dv

Terminal diff viewer (TypeScript, Ink 8 / React 19, shiki) whose review comments are delivered to Claude Code
sessions. README.md covers usage and the delivery design; this file covers what matters when changing it.

## Commands

```sh
npm run build      # esbuild bundle to dist/ (ESM, code-split); tsc is typecheck only
npm run typecheck
npm test           # vitest; the integration and session tests run dist/cli.js, so build first
```

## The build is live

`dv install` points the user's global Claude Code hooks and the `dv` MCP server at this checkout's
`dist/cli.js`. Every `npm run build` changes what the user's open Claude sessions run, so never leave `dist/`
broken, and keep the review and session file formats backwards compatible (old pending reviews have no `target`).

## Invariants

- **Hooks never get in Claude's way.** `runHook` never throws, prints nothing unless it delivers a review, and
  `cli.ts` sets `process.exitCode` instead of calling `process.exit()` so piped hook output isn't cut off.
- **`dv mcp` stdout is the JSON-RPC stream.** Anything else written there corrupts it; diagnostics go to stderr.
- **Each review is delivered once.** The rename from `pending/` to `delivered/` is the claim, shared by the hooks
  and the channel server. Read before renaming, and only treat a review as yours once the rename succeeds.
- **A session is its Claude process.** Hooks and `dv mcp` walk up the process tree (`ps`) to the nearest `claude`
  process, through shells and node version-manager shims; `{pid, started}` guards against pid reuse. Claude's
  `session_id` is informational only: it changes on `/clear`.
- **Only push to idle sessions.** A channel message sent mid-turn is folded into the running turn and can be
  ignored, so `dv mcp` waits for the hooks to record `idle`. The Stop hook records `busy` when it hands over a
  review, since Claude keeps working.
- **A push is acknowledged by the UserPromptSubmit hook**, which Claude runs for each channel message it accepts.
  Without an ack, the review goes back to pending, but only once the session is idle and the timeout has passed.

## Testing against real Claude

Unit tests stand in for Claude with a shell script named `claude`. For changes to delivery, also check against
real sessions: drive `claude --dangerously-load-development-channels server:dv` in a pty (Python `pty` + `pyte`
worked well), accept the folder-trust and dev-channel prompts, write a targeted review into
`.git/diff-viewer/pending/`, and read the screen. Reap killed sessions (`waitpid`), or `ps` still lists them as
zombies and they look alive.
