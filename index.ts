import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ZigpollClient } from "./src/api.js";
import { digestTools, type DigestConfig } from "./src/digest.js";
import { actionTools } from "./src/tools/actions.js";
import { analyticsTools } from "./src/tools/analytics.js";
import { readTools } from "./src/tools/read.js";

export default definePluginEntry({
  id: "zigpoll",
  name: "Zigpoll",
  description:
    "Query survey results, run response analytics, and build and distribute Zigpoll surveys.",
  register(api: any) {
    const config = (api.pluginConfig ?? {}) as {
      apiKey?: string;
      defaultAccountId?: string;
      digest?: DigestConfig;
    };
    if (!config.apiKey) {
      api.logger.warn(
        "zigpoll: no apiKey configured under plugins.entries.zigpoll.config — Zigpoll tools are disabled. " +
          "Create a key at app.zigpoll.com under Settings > Manage Integrations > API Key.",
      );
      return;
    }
    const client = new ZigpollClient({
      apiKey: config.apiKey,
      defaultAccountId: config.defaultAccountId,
    });

    for (const tool of [
      ...readTools(client),
      ...analyticsTools(client),
      ...digestTools(client, api, config.digest),
    ]) {
      api.registerTool(tool);
    }
    // Tools that create content or contact people are opt-in via tools.allow.
    for (const tool of actionTools(client)) {
      api.registerTool(tool, { optional: true });
    }
  },
});
