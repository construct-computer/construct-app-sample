[![Construct App](https://img.shields.io/badge/Construct-App-6366f1)](https://construct.computer)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

# Construct App: Text Tools

A reference app for [Construct](https://construct.computer) that ships nine everyday developer utilities. It demonstrates the recommended pattern for building a Construct app: register MCP tools via `ConstructApp`, wire them to a grouped GUI, and serve locally with Cloudflare Workers. Fork this repo as a starting point for your own app.

## Tools

| Tool | Description |
|---|---|
| `slugify` | Convert a string into a URL-safe slug |
| `word_count` | Count words, characters, and lines |
| `reverse` | Reverse a string by Unicode code point (emoji-safe) |
| `json_format` | Format, minify, or validate a JSON string |
| `base64` | Encode or decode Base64 |
| `hash` | Generate SHA-1 / SHA-256 / SHA-384 / SHA-512 hashes |
| `uuid` | Generate one or more v4 UUIDs |
| `timestamp` | Convert between Unix timestamps and ISO 8601 dates |
| `url_encode` | URL-encode or decode a string |

Every tool is available to both the AI assistant (via MCP) and the visual GUI.

## Getting Started

```bash
# Clone
git clone https://github.com/construct-computer/construct-app-sample.git
cd construct-app-sample

# Install dependencies
pnpm install

# Start the dev server (runs on localhost:8787)
pnpm dev
```

## Project Structure

```
construct-app-sample/
├── manifest.json          App metadata — Construct reads this to install your app
├── server.ts              MCP server — registers tools using ConstructApp
├── wrangler.toml          Cloudflare Workers config
├── tsconfig.json          TypeScript config (server)
├── ui/
│   ├── index.html         GUI — grouped tool buttons calling tools via the SDK
│   ├── app.js             UI logic with construct.* bridge calls
│   ├── construct.d.ts     TypeScript types for the construct.* globals
│   ├── jsconfig.json      JS project config (enables autocomplete in UI code)
│   └── icon.svg           App icon (256x256)
├── package.json
└── README.md
```

- **`manifest.json`** -- declares your app's name, description, icon, categories, and UI dimensions.
- **`server.ts`** -- the MCP server. Uses `ConstructApp` to register tools with `app.tool(name, definition)`. Each handler returns a string or a `ToolResult`. Asset serving, CORS, and `/ui/*` rewriting are handled automatically by the SDK.
- **`ui/index.html`** -- the GUI. Loads the Construct SDK (`construct.js` + `construct.css`) from the registry and organises tools into labelled groups.
- **`ui/app.js`** -- UI logic. Calls tools via `construct.tools.call(name, args)` and renders results.
- **`ui/construct.d.ts`** -- TypeScript ambient types for the `construct.*` globals injected into the iframe. Provides autocomplete in `app.js`.

## Adding a New Tool

Register the tool in `server.ts`:

```typescript
app.tool('my_tool', {
  description: 'What the AI sees when deciding whether to use this tool.',
  parameters: {
    input: { type: 'string', description: 'The input value' },
    mode: { type: 'string', enum: ['a', 'b'], description: 'Operation mode' },
  },
  handler: async (args) => {
    const input = args.input as string;
    return `Result: ${input}`;
  },
});
```

Add a button in `ui/index.html` inside the appropriate group:

```html
<button data-tool="my_tool">My Tool</button>
<!-- or with extra args: -->
<button data-tool="my_tool" data-args='{"mode":"a"}'>My Tool (A)</button>
```

The tool is automatically available to both the AI assistant and the GUI.

## Testing

Test the MCP endpoint directly with curl:

```bash
# Health check
curl http://localhost:8787/health

# List tools
curl -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Call a tool
curl -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"uuid","arguments":{"count":3}}}'
```

## Testing in Construct

With the dev server running:

1. Open Construct → **Settings** → **Developer**
2. Toggle **Developer Mode** on
3. Under **Connect Dev Server**, paste `http://localhost:8787` and click **Connect**

Construct calls your server's `/health` and `/mcp` endpoints to register the app, and opens your UI in a sandboxed window. The agent can now call your tools.

For remote testing, expose your dev server with [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/app-network/create-tunnel/):

```bash
cloudflared tunnel --url http://localhost:8787
```

Use the resulting `https://…trycloudflare.com` URL in the Connect Dev Server field.

## How It Works

### Dev mode (`wrangler dev`)

- The SDK's `fetch()` handler automatically adds CORS headers to every response, rewrites `/ui/*` requests to match the published URL structure, and serves static files from `ui/` via the Cloudflare ASSETS binding.
- The Construct desktop fetches the HTML, strips the `<script src="…construct.js">` / `<link href="…construct.css">` tags, and injects its own bridge that exposes `construct.tools`, `construct.ui`, `construct.state`, and `construct.agent`.

### Published mode (registry)

At deploy time, the registry CI bundles `server.ts` into the shared registry worker. The app is then reachable at `https://text-tools-<nanoid>.apps.construct.computer`:

- `POST /mcp` → MCP JSON-RPC dispatched to the bundled handler
- `GET  /ui/` → proxied from GitHub raw content at the pinned commit
- `GET  /icon` → proxied icon

## Publishing

Publish to the [Construct App Registry](https://registry.construct.computer):

1. Push to a public GitHub repo
2. Fork [construct-computer/app-registry](https://github.com/construct-computer/app-registry)
3. Add `apps/text-tools.json`:

```json
{
  "repo": "https://github.com/construct-computer/construct-app-sample",
  "versions": [
    { "version": "0.1.0", "commit": "<40-char SHA>", "date": "2026-04-16" }
  ]
}
```

4. Open a pull request — CI validates your manifest, and once merged your app appears in the registry

See the full guide at [registry.construct.computer/publish](https://registry.construct.computer/publish).

## SDK Reference

The Construct SDK is injected into your app's iframe. Key APIs:

| API | Description |
|---|---|
| `construct.ready(callback)` | Run code when the SDK bridge is ready |
| `construct.tools.call(name, args)` | Call a tool, get the full result object |
| `construct.tools.callText(name, args)` | Call a tool, get just the text result |
| `construct.ui.setTitle(title)` | Update the window title bar |
| `construct.ui.getTheme()` | Get the current theme (dark/light + accent) |
| `construct.ui.close()` | Close the app window |
| `construct.state.get()` / `.set(state)` | Read/write persistent app state |
| `construct.state.onUpdate(callback)` | Subscribe to state changes |
| `construct.agent.notify(message)` | Send a message to the AI agent |

CSS variables (`--c-bg`, `--c-surface`, `--c-text`, `--c-accent`, etc.) and utility classes (`.btn`, `.badge`, `.fade-in`) are provided by `construct.css` for theme-aware styling.

## Links

- [App SDK](https://www.npmjs.com/package/@construct-computer/app-sdk)
- [Create a new app](https://www.npmjs.com/package/@construct-computer/create-construct-app)
- [App Store](https://registry.construct.computer)
- [Developer Docs](https://registry.construct.computer/publish)
