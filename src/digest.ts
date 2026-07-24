import { Type } from "typebox";
import type { ZigpollClient } from "./api.js";
import { stripHtml, truncate } from "./aggregate.js";
import { text, type ZigpollTool } from "./types.js";

// Guardrails. The digest tool is designed to be driven by OpenClaw cron on an
// interval the user controls, so every protection lives here rather than in
// the scheduler: a floor between API checks, a bounded lookback window, a
// single capped page per check, and a cooldown that backs off exponentially
// after repeated upstream failures.
const MIN_CHECK_INTERVAL_MS = 60 * 1000;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_LOOKBACK_DAYS = 30;
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_PER_CHECK_CEILING = 1000;
const DEFAULT_MAX_PER_CHECK = 500;
const FAILURES_BEFORE_COOLDOWN = 3;
const COOLDOWN_BASE_MS = 5 * 60 * 1000;
const COOLDOWN_MAX_MS = 60 * 60 * 1000;

export interface DigestConfig {
  lookbackDays?: number;
  maxResponsesPerCheck?: number;
}

interface DigestState {
  watermark: number;
  lastRunAt: number;
  failures: number;
  nextAllowedAt: number;
}

// Persists digest watermarks in the gateway's SQLite-backed keyed store when
// available, falling back to process memory (worst case after a restart: one
// digest re-covers the bounded lookback window).
class DigestStateStore {
  private readonly memory = new Map<string, DigestState>();
  private keyed: any;

  constructor(api: any, private readonly logger?: { warn(msg: string): void }) {
    try {
      this.keyed = api?.runtime?.state?.openKeyedStore?.({ namespace: "zigpoll-digest" });
    } catch {
      this.keyed = undefined;
    }
  }

  async get(key: string): Promise<DigestState | undefined> {
    if (this.keyed) {
      try {
        const raw = await this.keyed.lookup(key);
        if (raw != null) return typeof raw === "string" ? JSON.parse(raw) : (raw as DigestState);
      } catch {
        // fall through to memory
      }
    }
    return this.memory.get(key);
  }

  async set(key: string, state: DigestState): Promise<void> {
    this.memory.set(key, state);
    if (this.keyed) {
      try {
        await this.keyed.register(key, JSON.stringify(state));
      } catch {
        this.logger?.warn("zigpoll: keyed store write failed; digest watermark held in memory only");
        this.keyed = undefined;
      }
    }
  }
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function minutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60000))} min`;
}

export function digestTools(client: ZigpollClient, api: any, config: DigestConfig = {}): ZigpollTool[] {
  const store = new DigestStateStore(api, api?.logger);
  const lookbackMs =
    clamp(config.lookbackDays, DEFAULT_LOOKBACK_DAYS, 1, MAX_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000;
  const maxPerCheck = clamp(config.maxResponsesPerCheck, DEFAULT_MAX_PER_CHECK, 1, MAX_PER_CHECK_CEILING);

  return [
    {
      name: "zigpoll_response_digest",
      description:
        "Check for new survey responses since the last digest and summarize them. Designed for scheduled (cron) runs: it remembers what it already reported, stays quiet when there is nothing new, and rate-limits itself. Returns 'No new responses' when nothing happened — in that case do not message the user.",
      parameters: Type.Object({
        account_id: Type.Optional(
          Type.String({ description: "Account to watch. Omit to use the configured default." }),
        ),
        poll_id: Type.Optional(Type.String({ description: "Watch a single poll instead of the whole account." })),
        reset: Type.Optional(
          Type.Boolean({ description: "Reset the watermark and start fresh from the last 24 hours." }),
        ),
      }),
      async execute(_id, params) {
        const now = Date.now();
        const filter: Record<string, unknown> = params.poll_id
          ? { pollId: params.poll_id }
          : { accountId: client.resolveAccountId(params.account_id) };
        const stateKey = params.poll_id ? `poll:${params.poll_id}` : `account:${filter.accountId}`;

        let state = (!params.reset && (await store.get(stateKey))) || {
          watermark: now - FIRST_RUN_LOOKBACK_MS,
          lastRunAt: 0,
          failures: 0,
          nextAllowedAt: 0,
        };

        // Guardrail: failure cooldown (exponential backoff even under external cron).
        if (now < state.nextAllowedAt) {
          return text(
            `Zigpoll digest is cooling down after ${state.failures} failed checks — next check allowed in ${minutes(state.nextAllowedAt - now)}. No new data. Do not message the user.`,
            { skipped: "cooldown", nextAllowedAt: state.nextAllowedAt },
          );
        }
        // Guardrail: floor between API checks, regardless of cron cadence.
        if (now - state.lastRunAt < MIN_CHECK_INTERVAL_MS) {
          return text(
            "Zigpoll digest already ran less than a minute ago — skipping this check. No new data. Do not message the user.",
            { skipped: "min-interval" },
          );
        }
        // Guardrail: bounded lookback, even after long gateway downtime.
        const createdAfter = Math.max(state.watermark, now - lookbackMs);

        let page: any;
        try {
          // Guardrail: one capped page per check — never a pagination loop.
          page = await client.get("/responses", { ...filter, createdAfter, limit: maxPerCheck });
        } catch (error) {
          const failures = state.failures + 1;
          const overrun = Math.max(0, failures - FAILURES_BEFORE_COOLDOWN);
          const nextAllowedAt =
            failures >= FAILURES_BEFORE_COOLDOWN
              ? now + Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** overrun)
              : 0;
          await store.set(stateKey, { ...state, lastRunAt: now, failures, nextAllowedAt });
          throw error;
        }

        const responses: any[] = page.data ?? [];
        if (!responses.length) {
          await store.set(stateKey, { ...state, lastRunAt: now, failures: 0, nextAllowedAt: 0 });
          return text(
            `No new Zigpoll responses since ${new Date(createdAfter).toISOString()}. Do not message the user.`,
            { newResponses: 0 },
          );
        }

        const newestMs = Math.max(...responses.map((r) => new Date(r.createdAt).getTime() || 0));
        await store.set(stateKey, {
          watermark: newestMs + 1,
          lastRunAt: now,
          failures: 0,
          nextAllowedAt: 0,
        });

        const byPoll = new Map<string, any[]>();
        for (const r of responses) {
          const pollId = String(r.pollId ?? "unknown");
          let bucket = byPoll.get(pollId);
          if (!bucket) byPoll.set(pollId, (bucket = []));
          bucket.push(r);
        }
        let pollTitles = new Map<string, string>();
        if (!params.poll_id && byPoll.size) {
          try {
            const polls = await client.get("/polls", { accountId: filter.accountId });
            pollTitles = new Map(
              (polls.data ?? polls ?? []).map((p: any) => [String(p._id), stripHtml(p.title) || "(untitled)"]),
            );
          } catch {
            // titles are cosmetic — fall back to IDs
          }
        }

        const sections = [...byPoll.entries()].map(([pollId, group]) => {
          const title = pollTitles.get(pollId) ?? `Poll ${pollId}`;
          const samples = group
            .slice(0, 3)
            .map((r) => `  - ${truncate(stripHtml(r.response) || "No answer")}`);
          return `- **${title}**: ${group.length} new response(s)\n${samples.join("\n")}`;
        });
        const capNote =
          responses.length >= maxPerCheck || page.hasNextPage
            ? `\n\n_Showing the ${responses.length} most recent — more arrived than one check reports. Use zigpoll_response_summary for the full picture._`
            : "";
        return text(
          `**${responses.length} new Zigpoll response(s)** since ${new Date(createdAfter).toISOString()}:\n${sections.join("\n")}${capNote}`,
          { newResponses: responses.length, polls: Object.fromEntries([...byPoll.entries()].map(([k, v]) => [k, v.length])) },
        );
      },
    },
  ];
}
