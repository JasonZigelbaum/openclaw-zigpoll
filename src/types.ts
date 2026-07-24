export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

export interface ZigpollTool {
  name: string;
  description: string;
  parameters: unknown;
  execute(id: string, params: any): Promise<ToolResult>;
}

export function text(markdown: string, details?: unknown): ToolResult {
  return { content: [{ type: "text", text: markdown }], details };
}
