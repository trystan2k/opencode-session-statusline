# opencode-session-statusline

A session status row for the [OpenCode](https://opencode.ai) v2 TUI — main
sessions and subagent views:

```
GLM-5.3-Flash Z.AI Coding Plan · max | ctx ██▏········▏ 19% — 188.7k | in 5.6M | out 183.9k | ████████▎····▏ ↯ 4.1 · μ 25 tok/s | 3h59m
```

By default it claims the **`app` slot** — the bottom strip of the window, on
its own row directly above OpenCode's usage line — and renders for the session
on screen, main ones included. `app` is deliberate: in the composer tab views
(`Subagents`, `Shell`, `Terminals`) OpenCode replaces the prompt footer with
the tab panel, so a footer claim would disappear exactly where a running
subagent is being watched.

## Install

```sh
opencode plugin add opencode-session-statusline
```

That's it — restart the TUI and the row appears. The command records the
package in your global config's `plugins` array; `opencode plugin list` should
show it.

Prefer a config entry? Add the package to `plugins` in `opencode.json(c)`:

```jsonc
{
  "plugins": ["opencode-session-statusline"]
}
```

Or, if you connect to a remote server and want the row regardless, the
TUI-only config `cli.json`:

```json
{
  "plugins": ["opencode-session-statusline"]
}
```

## Options

Defaults are fine for normal use. To set options, use the object form of a
config entry in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-session-statusline",
      "options": {
        // "all" (default: every session view, main included) or
        // "subagents" (only child-session views)
        "scope": "subagents",
        // "app" (default: bottom strip, same place as the status line),
        // "composer" (above the prompt) or "footer" (prompt footer)
        "placement": "composer"
      }
    }
  ]
}
```

| Option      | Values                            | Default | Meaning                                                        |
| ----------- | --------------------------------- | ------- | -------------------------------------------------------------- |
| `scope`     | `"all"` \| `"subagents"`          | `all`   | Show the row in every session view, or only child-session views |
| `placement` | `"app"` \| `"composer"` \| `"footer"` | `app` | Where the row lives                                          |

`footer` sits on the prompt footer row, which the composer tab views replace;
`composer` sits directly above the prompt; `app` survives every tab view.

## What each figure means

| Figure      | Source                                                              |
| ----------- | ------------------------------------------------------------------- |
| Model       | last assistant message's model (or the session's), resolved to the catalogue display name, drawn in the base ink |
| provider    | the catalogue's provider display name, in the muted ink             |
| `· max`     | the model's effort/variant, in the gold ink the prompt footer uses  |
| `ctx` gauge | eleven cells; filled in proportion to the context used              |
| `ctx %`     | tokens of the **last request** divided by the model's context window |
| `— 151.6k`  | tokens that percentage is made of (the last request's total)         |
| `in`/`out`  | cumulative session input and output tokens                           |
| speed gauge | eleven cells; scales to the session's high-water mark (≥ 40 tok/s)   |
| `↯ 4.1`     | sliding estimate over the last few seconds of streamed deltas        |
| `μ 25`      | the current turn's exact mean: folded output tokens over decode time |
| duration    | session creation to the moment it went idle; live while running      |

Sections are separated by `|`. Colours follow the active theme; the context
gauge and percentage turn yellow at 70% and red at 90%. The speed segment reads
green at 50 tok/s and above, amber below, and a resting `↯ 0.0` between turns
draws in the muted ink rather than an alarm colour.

The speed segment is the usage line's meter, ported: deltas from
`session.text/reasoning/tool.input.delta` land in 100 ms buckets, each output
class converts at its own calibrated characters-per-token ratio, a step's
decode clock advances only while tokens arrive, finished steps fold into the
turn's exact mean, and the gauge animates on the same 250 ms cadence. A session
this process never watched (a resume, a restart) rebuilds its settled figure
from the message records.

## Requirements

- OpenCode v2 (tested against 2.2.1). No global installs — the host provides
  the plugin SDK, Solid and OpenTUI at runtime.

## Known issues

- OpenCode's TUI skips its Solid JSX transform for files under a `node_modules`
  tree — exactly where npm/git-installed packages live — so raw `.tsx` TUI
  entries fail to load from an install (upstream:
  [anomalyco/opencode#33884](https://github.com/anomalyco/opencode/issues/33884)).
  This package therefore ships no JSX syntax: the TUI part imports the TUI SDK,
  Solid and the OpenTUI JSX runtime through the host's virtual runtime modules
  and builds the row with `jsx()` directly, so it renders no matter where it is
  installed from. Verified on OpenCode 2.2.1 installed via
  `opencode plugin add` from GitHub.
- Keep exactly one copy of the plugin. Loading the same plugin id from two
  sources (for example a leftover directory in `~/.config/opencode/plugins/`
  alongside the configured package) makes one of them show up as
  "Plugin failed" in `/plugins`.

## Development

```sh
npm install       # dev dependencies only (types); nothing is needed at runtime
npm run check     # typecheck
npm pack          # inspect the publishable tarball
```

- `src/index.ts` — the server part: a no-op `Plugin.define` whose only job is
  giving the plugin its id and anchoring discovery.
- `src/tui.tsx` — the TUI part: event wiring, meter seeding and rendering.

Publish with `npm publish` (the package is unscoped, so no `--access` flag is
needed).

## License

[MIT](LICENSE) © Trystan2k
