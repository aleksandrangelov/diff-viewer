# dv

A terminal diff viewer for reviewing what Claude Code changed, with inline comments that are sent back to Claude.

Run `dv` in a second terminal next to Claude Code. Browse the diff, comment on lines, ranges or whole files, and
submit the review. Claude gets it as soon as it finishes its current turn, or attached to your next prompt if it
is idle.

## Setup

```sh
npm install
npm run build
npm link             # puts `dv` on your PATH
dv install           # adds the delivery hooks to ~/.claude/settings.json (backs it up first)
```

Use `dv install --project` to install into `.claude/settings.local.json` of the current repo instead, and
`dv uninstall [--project]` to remove the hooks. Restart running Claude Code sessions afterwards.

## Usage

```sh
dv                 # uncommitted changes vs HEAD, untracked files included
dv --base main     # everything since the branch left main
dv -s              # only what changed since your last submitted review
```

| Key | Action |
| --- | --- |
| `j`/`k`, `ctrl-d`/`ctrl-u`, `g`/`G` | move, half page, top/bottom |
| `{` / `}` | previous / next hunk |
| `n` / `p` (or `]` / `[`), `tab` | next / previous file, focus the file list |
| `v` | start a range selection |
| `c` or `enter` | comment on the line or selection (edits when on a comment) |
| `C` | comment on the whole file |
| `e` / `d` / `u` | edit / delete / undo delete |
| `S` | submit the review, with an optional overall note |
| `s` | toggle between all changes and changes since your last review |
| `r`, `?`, `q` | refresh, help, quit |

While typing a comment: `enter` saves, `alt-enter` or `ctrl-j` adds a newline, `ctrl-e` opens `$EDITOR`, and
`esc` cancels.

The view refreshes on its own as files change. Draft comments are saved as you go, so quitting doesn't lose them,
and they follow the code they quote when Claude's edits shift line numbers. If the quoted code disappears, the
comment is shown at the top of the file marked as outdated.

## How delivery works

Submitting writes the review to `.git/diff-viewer/pending/`, inside the git dir so it never shows up in the diff.
It also pins the reviewed tree under `refs/diff-viewer/last-review`, which is what `dv -s` diffs against.

`dv install` registers two Claude Code hooks:

- **Stop** (`dv hook stop`): when Claude finishes a turn and a review is pending, the hook blocks the stop and
  hands Claude the review, so it keeps working on your comments.
- **UserPromptSubmit** (`dv hook prompt`): if Claude was idle when you submitted, the review is attached as
  context to whatever you type next. Sending something like "address the review" is enough.

Each review is delivered exactly once; it moves to `.git/diff-viewer/delivered/`. The hooks do nothing outside
git repos or when nothing is pending, and errors never block Claude. Reviews longer than Claude Code's 10k
character hook limit are written to a file, and Claude is told to read it.

## Development

```sh
npm test           # vitest: parser, rows/selection, formatting, install merge, hooks against real git repos
npm run typecheck
```
