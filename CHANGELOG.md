# Changelog

## 0.1.0 — 2026-10-29

Initial release.

- Status row for OpenCode v2 session views, drawn in the TUI `app` slot (the
  bottom strip of the window): model + provider + effort, an 11-cell context
  gauge with the context % and the tokens behind it, per-session in/out token
  totals, a token speed meter (sliding `↯` + turn mean `μ`) and the session
  duration.
- Renders for main sessions and subagent (child-session) views.
- Options: `scope` (`"all"` | `"subagents"`, default `"all"`) and `placement`
  (`"app"` | `"composer"` | `"footer"`, default `"app"`).
- The speed meter is a deliberate port of
  `@rashidrazak/opencode-status-line`'s rate maths, fed by the host's
  delta/step events; a session the process never watched (a resume, a
  restart) rebuilds its settled figure from the message records.
