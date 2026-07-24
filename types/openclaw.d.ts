// Minimal ambient types so the plugin typechecks without the openclaw gateway
// installed. At runtime the real SDK from the host gateway is used.
declare module "openclaw/plugin-sdk/plugin-entry" {
  export function definePluginEntry<T>(entry: T): T;
}
