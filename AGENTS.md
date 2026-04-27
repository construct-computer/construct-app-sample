# Agent Instructions — Construct Sample App Template

This repository is a **standalone GitHub template** for a Construct app: a Cloudflare Worker MCP server (`server.ts`), optional visual UI (`ui/`), and `manifest.json` metadata. Use it when building or modifying a **custom Construct app** (tools + optional iframe UI) that users install from the App Registry or attach in **Developer Mode** via a dev server URL.

All paths below are **relative to this repo root** unless stated otherwise.

---

## Canonical product context

| Concept | Meaning |
|--------|---------|
| **Construct** | AI desktop at [construct.computer](https://construct.computer). The agent calls your tools over MCP. |
| **Construct app** | A small Worker that implements MCP (`initialize`, `tools/list`, `tools/call`) and optionally serves a UI loaded in a sandboxed iframe. |
| **App Registry** | [registry.construct.computer](https://registry.construct.computer) — store, metadata, and **runtime** for published apps (your `server.ts` is bundled into the shared registry worker). |
| **`@construct-computer/app-sdk`** | npm package: `ConstructApp`, routing, CORS, asset handling, `RequestContext`, `ConstructCallError`, `requireAuth`. |

---

## Where to read the latest documentation (priority order)

Use these **URLs** only — this template repo does not vendor the full guides.

1. **Full developer guide (authoritative)** — [registry.construct.computer/publish](https://registry.construct.computer/publish) (manifest, MCP, UI bridge, platform tools, auth, env vars, troubleshooting, publishing internals).

2. **App SDK on npm** — [@construct-computer/app-sdk](https://www.npmjs.com/package/@construct-computer/app-sdk) (API summary, version, install). Source and README: [github.com/construct-computer/app-sdk](https://github.com/construct-computer/app-sdk).

3. **Manifest JSON Schema** (IDE validation + fields):  
   - Same idea as `manifest.json` `$schema`: [registry.construct.computer/schemas/manifest.json](https://registry.construct.computer/schemas/manifest.json)  
   - Alternate for editors: [raw.githubusercontent.com/construct-computer/app-sdk/main/schemas/manifest.schema.json](https://raw.githubusercontent.com/construct-computer/app-sdk/main/schemas/manifest.schema.json)

4. **This repo’s human-oriented quick start** — [`README.md`](./README.md) (commands, curl examples, publishing summary).

5. **Platform tool catalog** (exact strings for `permissions.uses.tools`):  
   - `GET https://beta.construct.computer/v1/tools`  
   - Staging: `GET https://staging.construct.computer/v1/tools`  
   Names must match **literally** — no wildcards.

6. **App Registry (pointers & CI)** — [github.com/construct-computer/app-registry](https://github.com/construct-computer/app-registry): fork this repo to add `apps/<your-app-id>.json`; CI validates manifests and bundling.

If two sources disagree, prefer **[registry.construct.computer/publish](https://registry.construct.computer/publish)** and the **manifest `$schema`** URL you set in `manifest.json`, then align `@construct-computer/app-sdk` version with what the publish guide expects.

---

## Repository layout (this template)

| Path | Role |
|------|------|
| `manifest.json` | Store listing + permissions + UI dimensions + optional `auth`. Read by registry CI from the **pinned git commit**. |
| `server.ts` | MCP server: `new ConstructApp({ name, version })`, `app.tool(...)`, `export default app`. |
| `wrangler.toml` | Worker name, `main = "server.ts"`, `[assets]` for local `ui/`. |
| `package.json` | `pnpm dev` → `wrangler dev`. Dependency: `@construct-computer/app-sdk`. |
| `tsconfig.json` | Server-only TypeScript (`server.ts`); Workers types. |
| `ui/index.html` | UI entry; loads Construct bridge CSS/JS (see [UI and SDK loading](#ui-and-sdk-loading)). |
| `ui/app.js` | Client logic: `construct.ready`, `construct.tools.call` / `callText`, etc. |
| `ui/construct.d.ts` | Ambient types for `construct.*` in this repo. To refresh from upstream, copy from the app-sdk package (see npm / GitHub links above; upstream file is typically `construct-global.d.ts`). |
| `ui/jsconfig.json` | Enables editor checking/autocomplete for `app.js`. |
| `ui/icon.svg` | App icon (referenced from `manifest.json` `icon`). |

**Tools-only apps:** omit the `ui/` directory and the `manifest.json` `ui` block.

---

## End-to-end lifecycle

### 1. Local development

```bash
pnpm install
pnpm dev
```

Default URL is typically `http://localhost:8787` (Wrangler). The SDK default export handles:

- `POST /mcp` — MCP JSON-RPC
- `GET /health` — must return 200 for Construct dev connect
- CORS on responses
- With `[assets]` + `run_worker_first = ["/*"]`: `/mcp` and `/health` first, then static files; `/ui/*` rewritten so paths match production

**`wrangler.toml` pattern (required for UI + dev parity):**

```toml
[assets]
directory = "./ui"
binding = "ASSETS"
not_found_handling = "none"
run_worker_first = ["/*"]
```

### 2. Wire the app identity

In `server.ts`, `ConstructApp({ name: '...', version: '...' })`:

- `name` should be a stable **slug** (how you identify the app in code; the public registry app id comes from the pointer filename in app-registry, not only from this field).
- `version` should track your releases.

### 3. Register tools

Pattern:

```typescript
app.tool('tool_name', {
  description: 'What the model reads when choosing tools.',
  parameters: {
    field: { type: 'string', description: '...' },
  },
  handler: async (args, ctx) => {
    // return string OR { content: [{ type: 'text', text: '...' }], isError?: true }
  },
});
```

Parameter types commonly used: `string`, `number`, `boolean`, `enum` for strings; document defaults in `description` where needed.

### 4. Optional: call Construct platform tools from the server

If a tool uses `ctx.construct.tools.call('namespace.action', payload)` or `ctx.construct.apps.call(...)`, you **must** declare those capabilities under `manifest.json` → `permissions.uses.tools` (exact catalog names) and/or `permissions.uses.apps`.

In **local dev** (`wrangler dev`, curl without platform headers), `ctx.construct` is a **stub** that throws `ConstructCallError` with code `no_bridge` — this is expected until traffic goes through the published app + gateway.

Handle errors with `ConstructCallError` and user-facing messages (see `send_notification` and `list_upcoming_events` in `server.ts` in this repo).

### 5. Optional: visual UI

- Declare `ui.entry`, `ui.width`, `ui.height` in `manifest.json`.
- Implement HTML/JS under `ui/`.
- Use `construct.ready()` before calling `construct.tools.*` or `construct.ui.*`.
- Inside the full Construct desktop, the parent may strip external `construct.js` / `construct.css` tags and inject an extended bridge (`state`, `agent`). Design HTML so it still works when only core APIs exist (e.g. opening the worker URL directly in a browser).

### 6. Test with curl

Examples in [`README.md`](./README.md): `tools/list`, `tools/call`.

### 7. Test inside Construct (Developer Mode)

1. Run `pnpm dev`.
2. Construct → **Settings** → **Developer** → enable **Developer Mode**.
3. **Connect Dev Server** → paste `http://localhost:8787` (or a [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/app-network/create-tunnel/) HTTPS URL).

Construct probes `/health`, `/mcp`, and UI entry / icon paths. For the exact checklist, see **Testing Locally** on [registry.construct.computer/publish](https://registry.construct.computer/publish).

### 8. Publish to the App Registry

Not completed inside this repo alone:

1. Push this app to a **public** GitHub repository.
2. Fork [construct-computer/app-registry](https://github.com/construct-computer/app-registry).
3. Add `apps/<your-app-id>.json` pointer: `repo` + `versions[]` with `{ version, commit, date }` (40-char commit SHA).
4. Open a PR; CI validates manifest, entrypoint (`server.ts` | `src/index.ts` | `index.ts`), icon, README, ownership rules.

After merge, registry pipelines assign a stable subdomain under `*.apps.construct.computer`. For pipeline details, see **How Publishing Works Internally** on [registry.construct.computer/publish](https://registry.construct.computer/publish).

**Ownership:** Set `manifest.json` `owners` to GitHub usernames allowed to bump registry versions and use the [developer dashboard](https://registry.construct.computer/dev) for per-app env vars (`x-construct-env`).

---

## UI and SDK loading

This template’s `ui/index.html` uses **same-origin** SDK paths:

```html
<link rel="stylesheet" href="/sdk/construct.css">
<script src="/sdk/construct.js"></script>
```

Wrangler dev and the published app host both expose `/sdk/*`. The publish guide also documents absolute URLs for portability:

- `https://registry.construct.computer/sdk/construct.js`
- `https://registry.construct.computer/sdk/construct.css`

Either pattern is valid; keep **one** consistent approach per file.

---

## Publishing / bundling constraints (LLM checklist)

- Registry CI **bundles** your server into a shared worker. If `@construct-computer/app-sdk` imports do not resolve in that pipeline, follow **Building Your MCP Server** on [registry.construct.computer/publish](https://registry.construct.computer/publish) (inline SDK or add an explicit bundle step and point `main` to the bundle).
- Ensure `export default app` (default export is the Worker fetch handler).
- Keep `README.md` at repo root — store description.
- Icon path in manifest must exist at the pinned commit.
- For OAuth, platform secrets are **not** in your repo — see **Authentication** on the publish guide (`APP_OAUTH_<APP_ID>_...` pattern).

---

## Commands reference

| Command | Purpose |
|---------|---------|
| `pnpm install` | Install dependencies |
| `pnpm dev` | `wrangler dev` — local MCP + UI assets |
| `pnpm deploy` | Deploy a **standalone** Worker (optional; **registry-published** apps are deployed via app-registry CI, not only this command) |
| `pnpm typecheck` | `tsc --noEmit` on `server.ts` |

---

## Summary for LLMs

1. Read **[registry.construct.computer/publish](https://registry.construct.computer/publish)** for the full contract (manifest, auth, gateway, errors, env vars, browser SDK).
2. Implement tools in **`server.ts`** with clear `description` / `parameters` for the model.
3. Mirror any `ctx.construct.*` usage in **`manifest.json` `permissions.uses`**.
4. Use **`curl`** and **Construct Developer Mode** before publishing.
5. Publish via an **app-registry** pointer PR; keep **`owners`** and **commit SHAs** correct.

Do not commit secrets to this repo; use the registry developer dashboard for injected env vars in production.
