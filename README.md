# Zigpoll for OpenClaw

Official [Zigpoll](https://www.zigpoll.com) plugin for [OpenClaw](https://openclaw.ai). Ask your agent about survey results, run response analytics, and build and distribute surveys — from WhatsApp, Telegram, Discord, or any channel your OpenClaw gateway is connected to.

> Prefer MCP? Zigpoll also runs a hosted MCP server at `https://mcp.zigpoll.com/mcp` that works with any MCP client, including OpenClaw. See [Connect Zigpoll to OpenClaw](https://docs.zigpoll.com/integrations/mcp-openclaw) for that path. This native plugin is the deeper integration: server-side API-key config (no browser OAuth dance), curated tools, and opt-in gating for actions that contact people.

## Install

```bash
openclaw plugins install clawhub:zigpoll/openclaw-plugin
# or from npm
openclaw plugins install npm:@zigpoll/openclaw-plugin
```

## Configure

1. Get an API key from your [Zigpoll dashboard](https://app.zigpoll.com): **Settings → Manage Integrations → API Key → Add Key** (under **Private Keys**).
2. Add it to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json5
{
  plugins: {
    entries: {
      zigpoll: {
        enabled: true,
        config: {
          apiKey: "YOUR_ZIGPOLL_API_KEY",
          // Optional: skip account_id in every request.
          // Find yours by asking the agent to "list my Zigpoll accounts".
          defaultAccountId: "..."
        }
      }
    }
  }
}
```

3. Restart the gateway and ask your agent: *"List my Zigpoll accounts."*

## Tools

Read and analytics tools are always available:

| Tool | What it does |
| --- | --- |
| `zigpoll_list_accounts` | List accounts available to the API key |
| `zigpoll_list_polls` | List surveys in an account with status |
| `zigpoll_get_poll` | Full details for one survey, including slides |
| `zigpoll_list_responses` | Page through individual responses |
| `zigpoll_response_summary` | Answer distributions and totals, per slide |
| `zigpoll_analyze_trends` | Response volume over time (hour/day/week/month) |
| `zigpoll_get_insights` | Zigpoll's AI-generated insights |
| `zigpoll_compare_polls` | Compare volume and participation across surveys |
| `zigpoll_response_digest` | New-responses check-in for scheduled runs (see below) |

Action tools are **optional** — they create content or contact people, so OpenClaw only exposes them after you allowlist them:

| Tool | What it does |
| --- | --- |
| `zigpoll_create_poll` | Create a survey (starts hidden) |
| `zigpoll_create_slide` | Add a question to a survey |
| `zigpoll_publish_poll` | Make a survey live |
| `zigpoll_send_survey` | Send a survey by email or SMS |
| `zigpoll_survey_link` | Generate a shareable survey link |

Enable the ones you want:

```json5
{
  tools: {
    allow: ["zigpoll_create_poll", "zigpoll_create_slide", "zigpoll_publish_poll"]
  }
}
```

## Proactive digests (scheduled check-ins)

Get new survey responses pushed to your chat instead of asking. Pair the `zigpoll_response_digest` tool with OpenClaw's built-in [cron scheduler](https://docs.openclaw.ai/automation/cron-jobs):

```bash
openclaw cron add --every 15m \
  "Run zigpoll_response_digest. If it reports new responses, summarize them for me. If it says there is nothing new, stay silent." \
  --name "Zigpoll digest" \
  --session isolated \
  --announce
```

Or a daily morning brief:

```bash
openclaw cron add "0 8 * * *" \
  "Run zigpoll_response_digest and give me a morning summary of new survey responses, highlighting anything negative." \
  --name "Zigpoll morning brief" \
  --session isolated \
  --announce
```

The digest tool remembers what it already reported (persisted in the gateway's state store), so each run only covers genuinely new responses.

### Built-in guardrails

The tool protects the Zigpoll API no matter how aggressively it is scheduled:

- **Rate floor** — at most one API check per minute per watched scope; extra cron ticks are skipped without any API call.
- **Bounded lookback** — after downtime it looks back at most `digest.lookbackDays` (default 7, max 30), never "everything ever."
- **Capped fetch** — one page of at most `digest.maxResponsesPerCheck` (default 500, max 1000) per check; no pagination loops.
- **Failure backoff** — after 3 consecutive failed checks it enters a cooldown that doubles from 5 minutes up to 1 hour, and resets on the first success.

Tune the caps in the plugin config:

```json5
{
  plugins: {
    entries: {
      zigpoll: {
        config: {
          apiKey: "...",
          digest: { lookbackDays: 3, maxResponsesPerCheck: 200 }
        }
      }
    }
  }
}
```

## Example prompts

- "Summarize the responses for my NPS survey from the last 30 days"
- "How did response volume trend week over week?"
- "Compare performance across my post-purchase surveys"
- "Create a post-purchase survey with a star rating and an open-ended follow-up, then publish it"

## Development

```bash
npm install
npm run typecheck
```

For a local install into your gateway during development:

```bash
openclaw plugins install ./openclaw-zigpoll
```

## Links

- [Zigpoll docs](https://docs.zigpoll.com)
- [Zigpoll API reference](https://apidocs.zigpoll.com)
- [Ideas for using Zigpoll with AI agents](https://docs.zigpoll.com/tutorials/zigpoll-mcp-use-cases)

## License

MIT
