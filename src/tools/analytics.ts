import { Type } from "typebox";
import { DEFAULT_MAX_RESULTS, ZigpollError, type ZigpollClient } from "../api.js";
import {
  answerDistribution,
  bucketByPeriod,
  dateRange,
  fetchSlideMap,
  formatDistribution,
  groupBySlide,
  slideLabel,
  stripHtml,
  truncate,
  type SlideInfo,
  type TrendPeriod,
} from "../aggregate.js";
import { text, type ZigpollTool } from "../types.js";

const scopeParams = {
  poll_id: Type.Optional(Type.String({ description: "Analyze all slides of this poll." })),
  slide_id: Type.Optional(Type.String({ description: "Analyze a single slide (question)." })),
  start_date: Type.Optional(Type.String({ description: "ISO 8601 start of the date range." })),
  end_date: Type.Optional(Type.String({ description: "ISO 8601 end of the date range." })),
  max_results: Type.Optional(
    Type.Number({ description: `Max responses to analyze (default ${DEFAULT_MAX_RESULTS}).` }),
  ),
};

function scopeFilter(params: any): Record<string, unknown> {
  if (params.slide_id) return { slideId: params.slide_id };
  if (params.poll_id) return { pollId: params.poll_id };
  throw new ZigpollError("Provide poll_id or slide_id.");
}

async function fetchScopedResponses(client: ZigpollClient, params: any): Promise<any[]> {
  return client.fetchAll("/responses", scopeFilter(params), {
    startDate: params.start_date,
    endDate: params.end_date,
    maxResults: params.max_results,
  });
}

async function slidesForScope(client: ZigpollClient, params: any): Promise<Map<string, SlideInfo>> {
  return params.poll_id ? fetchSlideMap(client, params.poll_id) : new Map();
}

export function analyticsTools(client: ZigpollClient): ZigpollTool[] {
  return [
    {
      name: "zigpoll_response_summary",
      description:
        "Summarize survey responses: totals, answer distribution with percentages, and date range. Breaks results down per slide when given a poll_id.",
      parameters: Type.Object(scopeParams),
      async execute(_id, params) {
        const [responses, slides] = await Promise.all([
          fetchScopedResponses(client, params),
          slidesForScope(client, params),
        ]);
        if (!responses.length) return text("No responses found for that scope and date range.");
        const { first, last } = dateRange(responses);
        const sections: string[] = [
          `**${responses.length} responses** (${first?.slice(0, 10)} → ${last?.slice(0, 10)})`,
        ];
        const detailGroups: Record<string, unknown> = {};
        for (const [slideId, group] of groupBySlide(responses)) {
          const distribution = answerDistribution(group);
          sections.push(
            `### ${slideLabel(slideId, slides)} — ${group.length} responses\n${formatDistribution(distribution)}`,
          );
          detailGroups[slideId] = { count: group.length, distribution };
        }
        return text(sections.join("\n\n"), { total: responses.length, first, last, slides: detailGroups });
      },
    },
    {
      name: "zigpoll_analyze_trends",
      description:
        "Show how survey response volume changes over time, bucketed by hour, day, week, or month.",
      parameters: Type.Object({
        ...scopeParams,
        group_by: Type.Optional(
          Type.Union(
            [Type.Literal("hour"), Type.Literal("day"), Type.Literal("week"), Type.Literal("month")],
            { description: "Time bucket size (default day)." },
          ),
        ),
      }),
      async execute(_id, params) {
        const responses = await fetchScopedResponses(client, params);
        if (!responses.length) return text("No responses found for that scope and date range.");
        const period = (params.group_by ?? "day") as TrendPeriod;
        const buckets = bucketByPeriod(responses, period);
        const peak = Math.max(...buckets.values());
        const lines = [...buckets.entries()].map(([key, count]) => {
          const bar = "█".repeat(Math.max(1, Math.round((count / peak) * 20)));
          return `- ${key}: ${count} ${bar}`;
        });
        return text(
          `**${responses.length} responses by ${period}:**\n${lines.join("\n")}`,
          { period, buckets: Object.fromEntries(buckets) },
        );
      },
    },
    {
      name: "zigpoll_get_insights",
      description:
        "Fetch Zigpoll's AI-generated insights for an account, poll, or slide — themes and takeaways derived from responses.",
      parameters: Type.Object({
        account_id: Type.Optional(Type.String()),
        poll_id: Type.Optional(Type.String()),
        slide_id: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        const filter: Record<string, unknown> = {};
        if (params.slide_id) filter.slideId = params.slide_id;
        else if (params.poll_id) filter.pollId = params.poll_id;
        else filter.accountId = client.resolveAccountId(params.account_id);
        const insights = await client.fetchAll("/insights", filter, { maxResults: 1000 });
        if (!insights.length) {
          return text("No insights yet — Zigpoll generates them as responses come in.");
        }
        const lines = insights.map((i: any) => {
          const body = stripHtml(i.text ?? i.insight ?? i.summary ?? i.title) || JSON.stringify(i);
          return `- ${truncate(body, 400)}`;
        });
        return text(`**${insights.length} insights:**\n${lines.join("\n")}`, { insights });
      },
    },
    {
      name: "zigpoll_compare_polls",
      description:
        "Compare performance across surveys: response volume, unique participants, and activity dates. Pass poll_ids, or an account_id to compare every poll in the account.",
      parameters: Type.Object({
        account_id: Type.Optional(Type.String()),
        poll_ids: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, params) {
        let polls: any[];
        if (params.poll_ids?.length) {
          polls = await Promise.all(
            params.poll_ids.map(async (pollId: string) => {
              const data = await client.get("/poll", { pollId });
              return data.data ?? data;
            }),
          );
        } else {
          const accountId = client.resolveAccountId(params.account_id);
          const data = await client.get("/polls", { accountId });
          polls = data.data ?? data ?? [];
        }
        if (!polls.length) return text("No polls to compare.");

        const rows = await Promise.all(
          polls.map(async (poll) => {
            const responses = await client.fetchAll("/responses", { pollId: poll._id });
            const participants = new Set(
              responses.map((r) => r.participantId ?? r.participant).filter(Boolean),
            );
            const { first, last } = dateRange(responses);
            return {
              id: String(poll._id),
              title: stripHtml(poll.title) || "(untitled)",
              responses: responses.length,
              participants: participants.size,
              first,
              last,
            };
          }),
        );
        rows.sort((a, b) => b.responses - a.responses);
        const table = [
          "| Poll | Responses | Participants | First | Last |",
          "| --- | --- | --- | --- | --- |",
          ...rows.map(
            (r) =>
              `| ${r.title} | ${r.responses} | ${r.participants} | ${r.first?.slice(0, 10) ?? "—"} | ${r.last?.slice(0, 10) ?? "—"} |`,
          ),
        ].join("\n");
        return text(table, { polls: rows });
      },
    },
  ];
}
