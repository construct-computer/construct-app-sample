/**
 * Hello World — Reference MCP app for the Construct App Store.
 *
 * Demonstrates the minimal MCP server pattern:
 *   - Read JSON-RPC requests from stdin (line-delimited)
 *   - Write JSON-RPC responses to stdout
 *   - Expose tools via initialize, tools/list, tools/call
 */

import * as readline from 'node:readline';

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'hello',
    description: 'Say hello to someone. Returns a friendly greeting.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name of the person to greet' },
      },
      required: ['name'],
    },
  },
  {
    name: 'echo',
    description: 'Echo back the input text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to echo back' },
      },
      required: ['text'],
    },
  },
  {
    name: 'timestamp',
    description: 'Get the current UTC timestamp.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

// ─── Tool handlers ───────────────────────────────────────────────────────────

function handleToolCall(name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  switch (name) {
    case 'hello': {
      const who = (args.name as string) || 'World';
      return { content: [{ type: 'text', text: `Hello, ${who}! 👋 I'm the Hello World app running on the Construct App Store.` }] };
    }
    case 'echo': {
      const text = (args.text as string) || '';
      return { content: [{ type: 'text', text }] };
    }
    case 'timestamp': {
      return { content: [{ type: 'text', text: new Date().toISOString() }] };
    }
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

// ─── JSON-RPC handler ────────────────────────────────────────────────────────

function handleRequest(req: { id?: number; method: string; params?: Record<string, unknown> }): object | null {
  const { id, method, params } = req;

  // Notifications (no id) — acknowledge silently
  if (id == null) return null;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'hello-world', version: '1.0.0' },
        },
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };

    case 'tools/call': {
      const toolName = (params as { name: string }).name;
      const toolArgs = (params as { arguments?: Record<string, unknown> }).arguments || {};
      const result = handleToolCall(toolName, toolArgs);
      return { jsonrpc: '2.0', id, result };
    }

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ─── Main loop: read stdin, write stdout ─────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line: string) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    const response = handleRequest(req);
    if (response) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  } catch {
    // Malformed JSON — send parse error if we can extract an id
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    }) + '\n');
  }
});
