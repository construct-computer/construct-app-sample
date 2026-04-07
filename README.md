# Construct App: DevTools

This is the official reference app for [Construct](https://construct.computer). It demonstrates the recommended patterns for building a Construct app: registering MCP tools via `ConstructApp`, wiring them to a tabbed GUI, and deploying to Cloudflare Workers. Fork this repo as a starting point for your own app.

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
├── wrangler.jsonc         Cloudflare Workers config
├── icon.png               App icon (256x256)
├── ui/
│   ├── index.html         GUI — tabbed interface calling tools via the SDK
│   └── construct.d.ts     TypeScript types for the construct.* globals
├── package.json
└── README.md
```

**`manifest.json`** declares your app's name, description, icon, categories, and UI dimensions. Construct reads this when installing your app.

**`server.ts`** is the MCP server. It uses the `ConstructApp` class to register tools with `app.tool(name, { description, parameters, handler })`. Each handler receives the tool arguments and returns a string (or a `ToolResult` for error cases). The file exports the app as the default — Cloudflare Workers calls `.fetch()` on it automatically.

**`ui/index.html`** is the optional GUI. It loads the Construct SDK (`construct.js` + `construct.css`) and calls tools via `construct.tools.callText(name, args)`.

**`ui/construct.d.ts`** provides TypeScript types for the `construct.*` globals injected into the iframe.

## Adding a New Tool

1. Register the tool in `server.ts`:

```typescript
app.tool('my_tool', {
  description: 'What the AI sees when deciding whether to use this tool.',
  parameters: {
    input: { type: 'string', description: 'The input value' },
    mode: { type: 'string', enum: ['a', 'b'], description: 'Operation mode' },
  },
  handler: async (args) => {
    const input = args.input as string;
    // Your logic here
    return `Result: ${input}`;
  },
});
```

2. (Optional) Add a UI tab in `ui/index.html` — copy an existing tab's HTML and wire the button to call `construct.tools.callText('my_tool', { ... })`.

That's it. The tool is automatically available to both the AI assistant and the GUI.

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

To test inside Construct, deploy your app (or use a tunnel like `cloudflared`) and install it via **Install from URL** in the App Registry.

## Publishing

Once your app is ready, publish it to the [Construct App Registry](https://github.com/construct-computer/app-registry):

1. Push to a public GitHub repo
2. Fork `construct-computer/app-registry`
3. Add your app entry and open a pull request
4. CI validates your manifest — once merged, your app appears in the registry

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

Full SDK documentation: [construct.computer/docs/sdk](https://construct.computer/docs/sdk)
