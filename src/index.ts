import { Plugin } from "@opencode/plugin"

/**
 * Server part. It has no behaviour of its own; it exists so OpenCode's plugin
 * discovery finds the directory and loads the TUI part (`tui.tsx`) with it.
 */
export default Plugin.define({
  id: "opencode-session-statusline",
  setup() {},
})
