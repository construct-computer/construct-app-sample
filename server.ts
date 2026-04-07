/**
 * DevTools — Construct app built with the ConstructApp SDK pattern.
 *
 * Six developer tools: JSON formatter, Base64, hashing, UUID generator,
 * timestamp converter, and URL encoder. Each works through both the AI
 * assistant (MCP) and the visual GUI.
 *
 * MCP endpoint: POST /mcp
 * Health check: GET /health
 */

// ── Inlined SDK (will be replaced with import once published) ───────────────

interface ContentBlock {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

interface RequestContext {
  userId?: string;
  auth?: { access_token: string; user_id: string; [key: string]: unknown };
  isAuthenticated: boolean;
  request: Request;
}

interface ParameterSchema {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  items?: ParameterSchema;
  properties?: Record<string, ParameterSchema>;
  required?: string[];
  [key: string]: unknown;
}

interface ToolDefinition {
  description: string;
  parameters?: Record<string, ParameterSchema>;
  inputSchema?: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: RequestContext) => Promise<string | ToolResult>;
}

interface ConstructAppOptions { name: string; version: string }
interface JsonRpcRequest { jsonrpc: string; method: string; params?: Record<string, unknown>; id?: string | number | null }

class ConstructApp {
  readonly name: string;
  readonly version: string;
  private tools = new Map<string, ToolDefinition>();

  constructor(options: ConstructAppOptions) { this.name = options.name; this.version = options.version; }

  tool(name: string, definition: ToolDefinition): this { this.tools.set(name, definition); return this; }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/mcp' && request.method === 'POST') return this.handleMcp(request);
    if (url.pathname === '/health') return new Response('ok');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-construct-user, x-construct-auth' } });
    return new Response('Not found', { status: 404 });
  }

  private extractContext(request: Request): RequestContext {
    const ctx: RequestContext = { isAuthenticated: false, request };
    const userId = request.headers.get('x-construct-user');
    if (userId) ctx.userId = userId;
    const authHeader = request.headers.get('x-construct-auth');
    if (authHeader) { try { const auth = JSON.parse(authHeader); ctx.auth = auth; ctx.isAuthenticated = !!auth.access_token; } catch {} }
    return ctx;
  }

  private getToolsList() {
    return Array.from(this.tools.entries()).map(([name, def]) => ({
      name, description: def.description,
      inputSchema: def.inputSchema ?? { type: 'object' as const, properties: def.parameters ?? {} },
    }));
  }

  private async handleMcp(request: Request): Promise<Response> {
    const ctx = this.extractContext(request);
    let rpc: JsonRpcRequest;
    try { rpc = (await request.json()) as JsonRpcRequest; } catch { return Response.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }); }
    if (rpc.id === undefined || rpc.id === null) return new Response(null, { status: 204 });

    switch (rpc.method) {
      case 'initialize': return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: this.name, version: this.version } } });
      case 'tools/list': return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: this.getToolsList() } });
      case 'tools/call': return this.handleToolCall(rpc, ctx);
      default: return Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `Unknown method: ${rpc.method}` } });
    }
  }

  private async handleToolCall(rpc: JsonRpcRequest, ctx: RequestContext): Promise<Response> {
    const params = rpc.params ?? {};
    const toolName = params.name as string;
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = this.tools.get(toolName);
    if (!tool) return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true } });
    try {
      const result = await tool.handler(toolArgs, ctx);
      const content: ContentBlock[] = typeof result === 'string' ? [{ type: 'text', text: result }] : result.content;
      const isError = typeof result === 'string' ? false : result.isError;
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content, ...(isError && { isError }) } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: `Error: ${message}` }], isError: true } });
    }
  }
}

// ── App Setup ───────────────────────────────────────────────────────────────

const app = new ConstructApp({ name: 'devtools', version: '2.0.0' });

// ── Tools ───────────────────────────────────────────────────────────────────

app.tool('json_format', {
  description: 'Format, minify, or validate a JSON string.',
  parameters: {
    json: { type: 'string', description: 'The JSON string to process' },
    mode: { type: 'string', enum: ['format', 'minify', 'validate'], description: 'Operation mode (default: format)' },
    indent: { type: 'number', description: 'Indent spaces for format mode (default: 2)' },
  },
  handler: async (args) => {
    const input = args.json as string;
    const mode = (args.mode as string) || 'format';
    const indent = (args.indent as number) || 2;
    const parsed = JSON.parse(input);

    if (mode === 'validate') {
      const type = Array.isArray(parsed) ? 'array' : typeof parsed;
      const keys = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.keys(parsed).length : 0;
      const items = Array.isArray(parsed) ? parsed.length : 0;
      let info = `\u2713 Valid JSON (${type})`;
      if (keys > 0) info += ` \u2014 ${keys} key${keys > 1 ? 's' : ''}`;
      if (items > 0) info += ` \u2014 ${items} item${items > 1 ? 's' : ''}`;
      info += `\nSize: ${input.length} chars \u2192 ${JSON.stringify(parsed).length} chars minified`;
      return info;
    }

    return mode === 'minify' ? JSON.stringify(parsed) : JSON.stringify(parsed, null, indent);
  },
});

app.tool('base64', {
  description: 'Encode or decode a Base64 string.',
  parameters: {
    text: { type: 'string', description: 'The text to encode or decode' },
    mode: { type: 'string', enum: ['encode', 'decode'], description: 'Operation mode (default: encode)' },
  },
  handler: async (args) => {
    const text = args.text as string;
    const mode = (args.mode as string) || 'encode';
    if (mode === 'decode') {
      return new TextDecoder().decode(Uint8Array.from(atob(text), c => c.charCodeAt(0)));
    }
    return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  },
});

app.tool('hash', {
  description: 'Generate a hash of the given text.',
  parameters: {
    text: { type: 'string', description: 'Text to hash' },
    algorithm: { type: 'string', enum: ['SHA-256', 'SHA-1', 'SHA-384', 'SHA-512'], description: 'Hash algorithm (default: SHA-256)' },
  },
  handler: async (args) => {
    const text = args.text as string;
    const rawAlgo = (args.algorithm as string) || 'SHA-256';
    const algorithm = rawAlgo.toUpperCase().replace(/^SHA(\d)/, 'SHA-$1');
    const data = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest(algorithm, data);
    const hex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${algorithm}: ${hex}`;
  },
});

app.tool('uuid', {
  description: 'Generate one or more v4 UUIDs.',
  parameters: {
    count: { type: 'number', description: 'Number of UUIDs to generate (default: 1, max: 50)' },
  },
  handler: async (args) => {
    const count = Math.min(Math.max(1, (args.count as number) || 1), 50);
    return Array.from({ length: count }, () => crypto.randomUUID()).join('\n');
  },
});

app.tool('timestamp', {
  description: 'Convert between Unix timestamps and ISO 8601 dates.',
  parameters: {
    value: { type: 'string', description: 'A Unix timestamp or ISO date string. Omit for current time.' },
  },
  handler: async (args) => {
    const value = args.value as string | undefined;
    let date: Date;
    if (!value || value.trim() === '') {
      date = new Date();
    } else {
      const num = Number(value);
      if (!isNaN(num)) {
        date = new Date(num > 1e12 ? num : num * 1000);
      } else {
        date = new Date(value);
        if (isNaN(date.getTime())) {
          return { content: [{ type: 'text' as const, text: `Cannot parse: "${value}". Provide a Unix timestamp or ISO date.` }], isError: true };
        }
      }
    }
    const unixSec = Math.floor(date.getTime() / 1000);
    const unixMs = date.getTime();
    const now = Date.now();
    const diff = now - date.getTime();
    const abs = Math.abs(diff);
    const suffix = diff >= 0 ? 'ago' : 'from now';
    let relative = 'just now';
    if (abs >= 31_536_000_000) relative = `${Math.floor(abs / 31_536_000_000)} years ${suffix}`;
    else if (abs >= 2_592_000_000) relative = `${Math.floor(abs / 2_592_000_000)} months ${suffix}`;
    else if (abs >= 86_400_000) relative = `${Math.floor(abs / 86_400_000)} days ${suffix}`;
    else if (abs >= 3_600_000) relative = `${Math.floor(abs / 3_600_000)} hours ${suffix}`;
    else if (abs >= 60_000) relative = `${Math.floor(abs / 60_000)} minutes ${suffix}`;

    return [
      `ISO 8601:    ${date.toISOString()}`,
      `Unix (sec):  ${unixSec}`,
      `Unix (ms):   ${unixMs}`,
      `Relative:    ${relative}`,
    ].join('\n');
  },
});

app.tool('url_encode', {
  description: 'URL-encode or decode a string.',
  parameters: {
    text: { type: 'string', description: 'The string to encode or decode' },
    mode: { type: 'string', enum: ['encode', 'decode'], description: 'Operation mode (default: encode)' },
  },
  handler: async (args) => {
    const text = args.text as string;
    const mode = (args.mode as string) || 'encode';
    return mode === 'decode' ? decodeURIComponent(text) : encodeURIComponent(text);
  },
});

export default app;
