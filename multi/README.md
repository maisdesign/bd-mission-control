# Mission Control — multi-project shell

A zero-dependency Node server that shows every beads project on one machine in a single page.
Each project gets a tab hosting the regular bd-mission-control panel (`../dist/orchestration.html`),
fed by a fresh `bd export` of that project's tracker.

The page text is currently in Italian.

## What it shows

- **Overview**: every project that has a beads tracker under the configured `scanRoots`, plus any
  project with a live Claude Code session. A switch hides the projects without an open session.
- **Project tabs**: one per project with a session, pinned in the config, or opened from the overview.
- **Epic filter**: a menu on each tab restricts the panel to one epic (hierarchical ids plus
  transitive parent-child links).

Session data comes from the Claude Code session registry (`sessions/<pid>.json` under each profile).

## Run

Requires Node 18+ and `bd` on `PATH`. Build the panel once from the repository root (`npm run build`)
so `dist/orchestration.html` exists.

```
node multi/server.mjs
```

On Windows, `start-mission-control.cmd` starts the server hidden (if it is not already running) and
opens the browser; `stop-mission-control.cmd` stops it. Both scripts assume port 8766 on 127.0.0.1:
change them if your config uses another port.

## Configure

Copy `mission-control.config.example.json` to `mission-control.config.json` (ignored by Git: it holds
paths and addresses of one machine). Every key is optional; the defaults are at the top of `server.mjs`.

| Key | Meaning |
|---|---|
| `port`, `host` | Where to listen. `host` may be a list; add a LAN address to share the page on the network. |
| `pinned` | Project folders that always get a tab. |
| `scanRoots`, `scanDepth` | Folders searched for beads trackers. |
| `scanExclude` | Tracker folders never shown, even with an open session. |
| `trackers` | Map "folder where sessions open" → "folder that contains `.beads`". |
| `labels` | Map slug → displayed name. |
| `hideSessions` | `true` hides paths, sessions and the machine name from `/api/state`. |
| `bd` | Path of the `bd` executable. |

Listening on a LAN address exposes project names, bead titles and (unless `hideSessions` is on)
local paths and session names to anyone on that network. There is no authentication.
