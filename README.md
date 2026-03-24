# DevTools — Construct Sample App

> **This is the reference app for [Construct](https://construct.computer).** Use it as a starting point for building your own apps. Every pattern you need is demonstrated here.

A developer toolkit with six tools: JSON formatter, Base64, hash generator, UUID generator, timestamp converter, and URL encoder. Each tool works through both the AI assistant (via MCP) and a visual GUI.

## Quick Start — Build Your Own App

Copy this repo's structure. A Construct app needs three things:

```
my-app/
├── manifest.json     ← Metadata, tools, permissions
├── server.ts         ← MCP server (Deno, reads stdin, writes stdout)
└── ui/index.html     ← Optional GUI (loaded in a sandboxed iframe)
```

### 1. `manifest.json` — Declare your app

```json
{
  "id": "my-app",
  "name": "My App",
  "version": "1.0.0",
  "description": "What your app does in one line.",
  "author": { "name": "You" },
  "entry": "server.ts",
  "runtime": "deno",
  "transport": "stdio",
  "icon": "icon.png",
  "permissions": {},
  "categories": ["utilities"],
  "tags": ["example"],
  "tools": [
    { "name": "my_tool", "description": "What it does — the AI reads this" }
  ]
}
```

Required fields: `id`, `name`, `version`, `description`, `entry`, `runtime`, `transport`, `tools`.

Add `ui` if your app has a GUI:
```json
"ui": {
  "type": "static",
  "entry": "ui/index.html",
  "width": 560,
  "height": 620
}
```

### 2. `server.ts` — Handle tool calls

Your server is a Deno process that speaks JSON-RPC 2.0 over stdio. Three methods are required:

| Method | What to return |
|---|---|
| `initialize` | Protocol version + capabilities |
| `tools/list` | Your tool definitions (name, description, inputSchema) |
| `tools/call` | The result of running a tool |

Minimal example:

```typescript
import * as readline from 'node:readline';

const TOOLS = [{
  name: 'my_tool',
  description: 'Does something useful.',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The input' },
    },
    required: ['input'],
  },
}];

function handleToolCall(name, args) {
  if (name === 'my_tool') {
    return { content: [{ type: 'text', text: `Result: ${args.input}` }] };
  }
  return { content: [{ type: 'text', text: 'Unknown tool' }], isError: true };
}

function handleRequest(req) {
  if (req.id == null) return null; // notification
  switch (req.method) {
    case 'initialize':
      return { jsonrpc: '2.0', id: req.id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'my-app', version: '1.0.0' },
      }};
    case 'tools/list':
      return { jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } };
    case 'tools/call':
      return { jsonrpc: '2.0', id: req.id, result:
        handleToolCall(req.params.name, req.params.arguments || {}) };
    default:
      return { jsonrpc: '2.0', id: req.id,
        error: { code: -32601, message: 'Method not found' } };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const res = handleRequest(JSON.parse(line));
  if (res) process.stdout.write(JSON.stringify(res) + '\n');
});
```

See [`server.ts`](server.ts) in this repo for a fully annotated version with error handling, async tools, and multiple tool handlers.

### 3. `ui/index.html` — Build the GUI (optional)

Load the Construct SDK, then call your MCP tools through the bridge:

```html
<link rel="stylesheet" href="/api/sdk/construct.css">
<script src="/api/sdk/construct.js"></script>

<script>
  // Call a tool and get the text result
  var result = await construct.tools.callText('my_tool', { input: 'hello' });

  // Update the window title
  construct.ui.setTitle('My App — Result');

  // Run code when the SDK is ready
  construct.ready(function() {
    // safe to use construct.* here
  });
</script>
```

**SDK features used in this app:**

| Feature | What it does | Used in |
|---|---|---|
| `construct.tools.callText(name, args)` | Call an MCP tool, get text result | Every tool button |
| `construct.ui.setTitle(title)` | Update the window title bar | Tab switching |
| `construct.ready(fn)` | Run code when SDK + DOM are ready | Init |
| CSS variables (`--c-bg`, `--c-surface`, etc.) | Theme-aware colors | All styles |
| `.btn`, `.btn-secondary`, `.badge` | Pre-built components | Buttons, labels |
| `.fade-in` | Entry animation | Container |

The SDK also supports a **reactive mode** with data-binding directives (`data-bind`, `data-on-click`, `data-show`, etc.) via `construct.app()` — see the [SDK docs](https://construct.computer) for details.

## Project Structure

```
construct-app-hello-world/
├── manifest.json      # App metadata — Construct reads this to launch your app
├── server.ts          # MCP server — handles tool calls from AI + GUI
├── icon.png           # App icon (256x256)
├── ui/
│   └── index.html     # GUI — tabbed interface calling tools via the SDK
├── README.md          # This file
└── .gitignore
```

## Publish to the App Registry

1. Push your app to a public GitHub repo
2. Fork [construct-computer/app-registry](https://github.com/construct-computer/app-registry)
3. Add `apps/my-app.json` with your repo URL and commit SHA
4. Open a pull request — CI validates your manifest and code
5. Once merged, your app appears in the Construct App Registry

See the full guide at [registry.construct.computer/publish](https://registry.construct.computer/publish).

## Credits

- App icon from [macosicons.com](https://macosicons.com/?icon=x3sldgkYgZ)
- Built for the [Construct](https://construct.computer) platform
