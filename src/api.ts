const API_BASE_URL = "https://v1.zigpoll.com";
const MAX_RETRIES = 3;
const PAGE_LIMIT = 5000;

export const DEFAULT_MAX_RESULTS = 10000;

// Endpoints that must be scoped to an account, poll, or slide before querying.
const SCOPED_ENDPOINTS = ["/responses", "/participants", "/slides", "/insights"];

export interface ZigpollClientOptions {
  apiKey: string;
  defaultAccountId?: string;
}

export interface FetchAllOptions {
  startDate?: string;
  endDate?: string;
  maxResults?: number;
  onPage?: (items: any[]) => void;
}

export class ZigpollError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A date-only string (e.g. "2026-07-01") means "through end of that day" when
// used as a range end.
export function toEpochMs(value: string, endOfDay = false): number {
  const iso = endOfDay && value.length <= 10 ? `${value}T23:59:59.999Z` : value;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) throw new ZigpollError(`Invalid date: "${value}". Use ISO 8601, e.g. 2026-07-01.`);
  return ms;
}

export class ZigpollClient {
  constructor(private readonly opts: ZigpollClientOptions) {}

  resolveAccountId(accountId?: string): string {
    const resolved = accountId ?? this.opts.defaultAccountId;
    if (!resolved) {
      throw new ZigpollError(
        "No account_id provided and no defaultAccountId configured. Call zigpoll_list_accounts to find one.",
      );
    }
    return resolved;
  }

  private async request(url: URL, init: RequestInit, endpoint: string): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        ...init,
        headers: { Authorization: this.opts.apiKey, ...init.headers },
      });
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 200 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        let detail = await response.text();
        try {
          detail = JSON.parse(detail).error ?? detail;
        } catch {
          // keep raw body
        }
        throw new ZigpollError(
          `Zigpoll API error: ${response.status} ${response.statusText} on ${endpoint} - ${detail}`,
        );
      }
      return response.json();
    }
  }

  async get(endpoint: string, params: Record<string, unknown> = {}): Promise<any> {
    if (
      SCOPED_ENDPOINTS.includes(endpoint) &&
      !params.slideId && !params.pollId && !params.accountId
    ) {
      throw new ZigpollError(`${endpoint} requires a slide_id, poll_id, or account_id.`);
    }
    const url = new URL(API_BASE_URL + endpoint);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    return this.request(url, { method: "GET" }, endpoint);
  }

  async post(endpoint: string, body: Record<string, unknown> = {}): Promise<any> {
    const url = new URL(API_BASE_URL + endpoint);
    return this.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      endpoint,
    );
  }

  // Cursor-paginated fetch. For /responses, date bounds are pushed to the API
  // as createdAfter/createdBefore; other endpoints filter in memory.
  async fetchAll(
    endpoint: string,
    params: Record<string, unknown> = {},
    options: FetchAllOptions = {},
  ): Promise<any[]> {
    const { startDate, endDate, onPage } = options;
    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    const pageParams: Record<string, unknown> = { ...params, limit: PAGE_LIMIT };

    let startMs: number | undefined;
    let endMs: number | undefined;
    if (startDate) startMs = toEpochMs(startDate);
    if (endDate) endMs = toEpochMs(endDate, true);
    if (endpoint === "/responses") {
      if (startMs !== undefined) pageParams.createdAfter = startMs;
      if (endMs !== undefined) pageParams.createdBefore = endMs;
    }

    const collected: any[] = [];
    let cursor: string | undefined;
    let total = 0;
    while (total < maxResults) {
      const page = await this.get(endpoint, { ...pageParams, startCursor: cursor });
      let items: any[] = page.data ?? [];
      if (endpoint !== "/responses" && (startMs !== undefined || endMs !== undefined)) {
        items = items.filter((item) => {
          const ms = new Date(item.createdAt).getTime();
          return (startMs === undefined || ms >= startMs) && (endMs === undefined || ms <= endMs);
        });
      }
      const room = maxResults - total;
      if (items.length > room) items = items.slice(0, room);
      total += items.length;
      if (onPage) onPage(items);
      else collected.push(...items);
      if (!page.hasNextPage || !page.endCursor) break;
      cursor = page.endCursor;
    }
    return onPage ? [] : collected;
  }
}
