/**
 * The host's virtual runtime modules. OpenCode loads published plugin files
 * from under a `node_modules` tree, where its Solid JSX transform does not
 * run; importing the TUI SDK, Solid and the OpenTUI JSX runtime through these
 * virtual ids binds the plugin to the host's own instances, so reactivity and
 * rendering work no matter where the package is installed from. The specifiers
 * are `opentui:runtime-module:` + `encodeURIComponent(module)`.
 */
declare module "opentui:runtime-module:%40opencode%2Fplugin%2Ftui" {
  export * from "@opencode/plugin/tui"
}

declare module "opentui:runtime-module:solid-js" {
  export * from "solid-js"
}

declare module "opentui:runtime-module:%40opentui%2Fsolid%2Fjsx-runtime" {
  export function jsx(type: any, props: any, key?: any): any
}
