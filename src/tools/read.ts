import { Type } from "typebox";
import type { ZigpollClient } from "../api.js";
import { stripHtml, truncate } from "../aggregate.js";
import { text, type ZigpollTool } from "../types.js";

function itemLabel(item: any): string {
  return stripHtml(item.title ?? item.name) || "(untitled)";
}

export function readTools(client: ZigpollClient): ZigpollTool[] {
  return [
    {
      name: "zigpoll_list_accounts",
      description:
        "List the Zigpoll accounts available to the configured API key. Use this first to find the account_id other tools need.",
      parameters: Type.Object({}),
      async execute() {
        const data = await client.get("/accounts");
        const accounts: any[] = data.data ?? data ?? [];
        const lines = accounts.map((a) => `- ${itemLabel(a)} — id: ${a._id}`);
        return text(
          accounts.length ? `Zigpoll accounts:\n${lines.join("\n")}` : "No Zigpoll accounts found.",
          { accounts },
        );
      },
    },
    {
      name: "zigpoll_list_polls",
      description:
        "List surveys (polls) in a Zigpoll account, newest first, with their IDs and status.",
      parameters: Type.Object({
        account_id: Type.Optional(
          Type.String({ description: "Zigpoll account ID. Omit to use the configured default account." }),
        ),
        limit: Type.Optional(Type.Number({ description: "Max polls to return (default 10)." })),
      }),
      async execute(_id, params) {
        const accountId = client.resolveAccountId(params.account_id);
        const data = await client.get("/polls", { accountId });
        const polls: any[] = (data.data ?? data ?? []).slice(0, params.limit ?? 10);
        const lines = polls.map((p) => {
          const status = p.isArchived ? "archived" : p.isVisible ? "live" : "hidden";
          return `- ${itemLabel(p)} — id: ${p._id} (${status})`;
        });
        return text(
          polls.length ? `Polls in account ${accountId}:\n${lines.join("\n")}` : `No polls found in account ${accountId}.`,
          { polls },
        );
      },
    },
    {
      name: "zigpoll_get_poll",
      description: "Get full details for one survey (poll): title, status, slides, and settings.",
      parameters: Type.Object({
        poll_id: Type.String({ description: "Poll ID. Use zigpoll_list_polls to find it." }),
      }),
      async execute(_id, params) {
        const data = await client.get("/poll", { pollId: params.poll_id });
        const poll = data.data ?? data;
        const slides: any[] = poll.slides ?? [];
        const status = poll.isArchived ? "archived" : poll.isVisible ? "live" : "hidden";
        const slideLines = slides.map(
          (s, i) => `  ${i + 1}. ${stripHtml(s.title) || "(untitled)"} [${s.type}] — id: ${s._id}`,
        );
        const body = [
          `**${itemLabel(poll)}** — id: ${poll._id} (${status})`,
          slides.length ? `Slides:\n${slideLines.join("\n")}` : "No slides yet.",
        ].join("\n");
        return text(body, { poll });
      },
    },
    {
      name: "zigpoll_list_responses",
      description:
        "List individual survey responses (one page). For aggregate stats prefer zigpoll_response_summary. Provide at least one of account_id, poll_id, or slide_id.",
      parameters: Type.Object({
        account_id: Type.Optional(Type.String()),
        poll_id: Type.Optional(Type.String()),
        slide_id: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ description: "Responses per page (default 50, max 1000)." })),
        cursor: Type.Optional(Type.String({ description: "Pagination cursor from a previous call." })),
        created_after: Type.Optional(Type.String({ description: "ISO 8601 date lower bound." })),
        created_before: Type.Optional(Type.String({ description: "ISO 8601 date upper bound." })),
      }),
      async execute(_id, params) {
        const filter: Record<string, unknown> = {};
        if (params.slide_id) filter.slideId = params.slide_id;
        else if (params.poll_id) filter.pollId = params.poll_id;
        else filter.accountId = client.resolveAccountId(params.account_id);
        const data = await client.get("/responses", {
          ...filter,
          limit: Math.min(params.limit ?? 50, 1000),
          startCursor: params.cursor,
          createdAfter: params.created_after ? new Date(params.created_after).getTime() : undefined,
          createdBefore: params.created_before ? new Date(params.created_before).getTime() : undefined,
        });
        const responses: any[] = data.data ?? [];
        const lines = responses.map((r) => {
          const when = r.createdAt ? new Date(r.createdAt).toISOString() : "unknown time";
          return `- [${when}] ${truncate(stripHtml(r.response) || "No answer")}`;
        });
        const footer = data.hasNextPage
          ? `\nMore available — pass cursor: ${data.endCursor}`
          : "\nNo more pages.";
        return text(
          (responses.length ? `${responses.length} responses:\n${lines.join("\n")}` : "No responses found.") + footer,
          { responses, hasNextPage: data.hasNextPage, endCursor: data.endCursor },
        );
      },
    },
  ];
}
