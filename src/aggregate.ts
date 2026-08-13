import type { ZigpollClient } from "./api.js";

export interface SlideInfo {
  title: string;
  type: string;
}

export interface AnswerCount {
  answer: string;
  count: number;
  percentage: number;
}

export function stripHtml(value: unknown): string {
  return String(value ?? "").replace(/<[^>]*>/g, "").trim();
}

export function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export async function fetchSlideMap(
  client: ZigpollClient,
  pollId: string,
): Promise<Map<string, SlideInfo>> {
  const data = await client.get("/slides", { pollId });
  const map = new Map<string, SlideInfo>();
  for (const slide of data.data ?? data ?? []) {
    map.set(String(slide._id), {
      title: stripHtml(slide.title) || "(untitled slide)",
      type: slide.type ?? "unknown",
    });
  }
  return map;
}

export function slideLabel(slideId: string, slides: Map<string, SlideInfo>): string {
  const info = slides.get(slideId);
  return info ? `${info.title} [${info.type}]` : `Slide ${slideId}`;
}

/* `response` is every option a participant chose compiled into one string. That
   is right for display and wrong for counting: tallying it buckets COMBINATIONS
   rather than options, so a five-option checkbox produces up to 31 distinct
   "answers" instead of five counts, and a matrix produces a near-unique string
   per respondent. The API's `answers` array carries the components — count
   those when present, and fall back to the string for single-answer questions
   and for older API builds that omit the field. */
export function answerValues(r: any): string[] {
  if (Array.isArray(r?.answers) && r.answers.length) {
    const values = r.answers
      .map((a: any) => {
        // A matrix entry is one answered row, so the row has to stay attached.
        if (a.rowTitle !== undefined || a.rowHandle !== undefined) {
          return `${a.rowTitle || a.rowHandle}: ${a.title ?? a.value ?? ""}`.trim();
        }
        if (a.rank !== undefined) return `#${a.rank} ${a.title ?? a.value ?? ""}`.trim();
        return stripHtml(a.value ?? a.title ?? "");
      })
      .filter(Boolean);
    if (values.length) return values;
  }

  const single = stripHtml(r?.response);
  return single ? [single] : [];
}

export function answerDistribution(responses: any[]): AnswerCount[] {
  const counts = new Map<string, number>();
  for (const r of responses) {
    const values = answerValues(r);
    if (!values.length) {
      counts.set("No answer", (counts.get("No answer") ?? 0) + 1);
      continue;
    }
    // One tally per selected option, so counts can exceed the response total.
    for (const value of values) {
      const answer = truncate(value);
      counts.set(answer, (counts.get(answer) ?? 0) + 1);
    }
  }
  const total = responses.length || 1;
  return [...counts.entries()]
    .map(([answer, count]) => ({ answer, count, percentage: Math.round((count / total) * 10000) / 100 }))
    .sort((a, b) => b.count - a.count);
}

export function groupBySlide(responses: any[]): Map<string, any[]> {
  const groups = new Map<string, any[]>();
  for (const r of responses) {
    const slideId = String(r.slideId ?? "unknown");
    let bucket = groups.get(slideId);
    if (!bucket) groups.set(slideId, (bucket = []));
    bucket.push(r);
  }
  return groups;
}

export type TrendPeriod = "hour" | "day" | "week" | "month";

export function periodKey(dateValue: unknown, period: TrendPeriod): string {
  const date = new Date(dateValue as string);
  if (Number.isNaN(date.getTime())) return "unknown";
  const iso = date.toISOString();
  switch (period) {
    case "hour":
      return `${iso.slice(0, 13)}:00`;
    case "day":
      return iso.slice(0, 10);
    case "week": {
      const monday = new Date(date);
      const offset = (monday.getUTCDay() + 6) % 7;
      monday.setUTCDate(monday.getUTCDate() - offset);
      return `week of ${monday.toISOString().slice(0, 10)}`;
    }
    case "month":
      return iso.slice(0, 7);
  }
}

export function bucketByPeriod(responses: any[], period: TrendPeriod): Map<string, number> {
  const buckets = new Map<string, number>();
  for (const r of responses) {
    const key = periodKey(r.createdAt, period);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return new Map([...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function dateRange(responses: any[]): { first?: string; last?: string } {
  let first: number | undefined;
  let last: number | undefined;
  for (const r of responses) {
    const ms = new Date(r.createdAt).getTime();
    if (Number.isNaN(ms)) continue;
    if (first === undefined || ms < first) first = ms;
    if (last === undefined || ms > last) last = ms;
  }
  return {
    first: first === undefined ? undefined : new Date(first).toISOString(),
    last: last === undefined ? undefined : new Date(last).toISOString(),
  };
}

export function formatDistribution(distribution: AnswerCount[], limit = 15): string {
  const lines = distribution
    .slice(0, limit)
    .map((d) => `- ${d.answer}: ${d.count} (${d.percentage}%)`);
  if (distribution.length > limit) {
    lines.push(`- …and ${distribution.length - limit} more distinct answers`);
  }
  return lines.join("\n");
}
