[![Construct App](https://img.shields.io/badge/Construct-App-6366f1)](https://construct.computer)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

# Construct App: DevTools

A reference app for [Construct](https://construct.computer) that ships six everyday developer utilities. It demonstrates the recommended pattern for building a Construct app: register MCP tools via `ConstructApp`, wire them to a tabbed GUI, and deploy to Cloudflare Workers. Fork this repo as a starting point for your own app.

## Tools

| Tool | Description |
|---|---|
| `json_format` | Format, minify, or validate a JSON string |
| `base64` | Encode or decode Base64 |
| `hash` | Generate SHA-1 / SHA-256 / SHA-384 / SHA-512 hashes |
| `uuid` | Generate one or more v4 UUIDs |
| `timestamp` | Convert between Unix timestamps and ISO 8601 dates |
| `url_encode` | URL-encode or decode a string |

Every tool is available to both the AI assistant (via MCP) and the visual GUI.

## Getting Started

```bash
# Fork and clone
gh repo fork construct-computer/construct-app-hello-world --clone
cd construct-app-hello-world

# Install dependencies
npm install

# Start the dev server (runs on localhost:8787)
npm run dev
```

## Project Structure

```
construct-app-hello-world/
├── manifest.json          App metadata — Construct reads this to install your app
├── server.ts              MCP server — registers tools using ConstructApp
├── wrangler.toml          Cloudflare Workers config
├── icon.png               App icon (256x256)
├── ui/
│   ├── index.html         GUI — tabbed interface calling tools via the SDK
│   └── construct.d.ts     TypeScript types for the construct.* globals
├── package.json
└── README.md
```

- **`manifest.json`** -- declares your app's name, description, icon, categories, and UI dimensions.
- **`server.ts`** -- the MCP server. Uses `ConstructApp` to register tools with `app.tool(name, definition)`. Each handler returns a string or a `ToolResult`. Exported as the default for Cloudflare Workers.
- **`ui/index.html`** -- optional GUI. Loads the Construct SDK (`construct.js` + `construct.css`) and calls tools via `construct.tools.callText(name, args)`.
- **`ui/construct.d.ts`** -- TypeScript types for the `construct.*` globals injected into the iframe.

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

Optionally, add a UI tab in `ui/index.html` -- copy an existing tab's HTML and wire the button to `construct.tools.callText('my_tool', { ... })`.

The tool is automatically available to both the AI assistant and the GUI.

## Testing

Test the MCP endpoint directly with curl:

```bash
# Initialize
curl -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'

# List tools
curl -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Call a tool
curl -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"uuid","arguments":{"count":3}}}'
```

## Testing in Construct

Deploy your app (or use a tunnel like `cloudflared`) and install it via **Install from URL** in the App Registry. Paste your worker URL, and Construct will read `manifest.json` to register the app.

## Publishing

Publish to the [Construct App Registry](https://registry.construct.computer):

1. Push to a public GitHub repo
2. Fork `construct-computer/app-registry`
3. Add your app entry and open a pull request
4. CI validates your manifest -- once merged, your app appears in the registry

See the full guide at [registry.construct.computer/publish](https://registry.construct.computer/publish).

## SDK Reference

The Construct SDK is injected into your app's iframe automatically. Key APIs:

| API | Description |
|---|---|
| `construct.tools.callText(name, args)` | Call an MCP tool, get the text result |
| `construct.tools.call(name, args)` | Call a tool, get the full result object |
| `construct.ui.setTitle(title)` | Update the window title bar |
| `construct.state.get()` / `.set(state)` | Read/write persistent app state |
| `construct.state.onUpdate(callback)` | Subscribe to state changes (from agent or other tabs) |
| `construct.agent.notify(message)` | Send a message to the AI agent |
| `construct.ready(callback)` | Run code when the SDK bridge is ready |

CSS variables (`--c-bg`, `--c-surface`, `--c-text`, etc.) and utility classes (`.btn`, `.btn-secondary`, `.badge`, `.fade-in`) are provided by `construct.css` for theme-aware styling.

Full SDK docs: [construct.computer/docs/sdk](https://construct.computer/docs/sdk)

## Links

- [App SDK](https://www.npmjs.com/package/@construct-computer/app-sdk)
- [Create a new app](https://www.npmjs.com/package/@construct-computer/create-construct-app)
- [App Store](https://registry.construct.computer)
- [Publishing Guide](https://registry.construct.computer/publish)
