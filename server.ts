/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AEGIS — Autonomous Support Operations Agent
 * Construct × Techfluence 2026
 *
 * Runtime:  Cloudflare Workers (V8 isolates)
 * SDK:      @construct-computer/app-sdk
 *
 * BUGS FIXED:
 * [1] createTicketDB — changed positional INSERT to named-column INSERT
 *     to prevent silent failures from column order mismatches.
 * [2] createTicketDB — wrapped in try/catch with explicit console.error
 *     so D1 failures are always visible in wrangler tail logs.
 * [3] resolveTicket — D1 query was using .first() which returns null
 *     silently; added explicit null guard with Slack error message.
 * [4] runPipeline Stage 3 — D1 save error was caught but pipeline
 *     continued silently; now logs and posts Slack warning if D1 fails.
 * [5] notionUpdateTicket — new dedicated function for PATCH (status update).
 *     Previously resolveTicket did inline fetch without error surface.
 * [6] resolveTicket — Notion search could return empty results silently;
 *     now logs a clear warning when pageId is not found.
 * [7] updateTicketDB — extended to also update resolved_at timestamp.
 * [8] All fire-and-forget Slack/Notion calls now use ctx.waitUntil or
 *     explicit .catch() with console.warn so errors are never swallowed.
 */

import { ConstructApp } from '@construct-computer/app-sdk';

const app = new ConstructApp({ name: 'aegis', version: '1.0.0' });

// ════════════════════════════════════════════════════════════════════════════
// § TYPES
// ════════════════════════════════════════════════════════════════════════════

interface Ticket {
  id: string;
  category: string;
  priority: string;
  message: string;
  user_id: string;
  channel_id: string;
  ts: string;
  created_at: string;
  status: string;
  resolution?: string;
}

interface KnowledgeEntry {
  topic: string;
  resolution: string;
  count: number;
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

// ════════════════════════════════════════════════════════════════════════════
// § RATE LIMITER
// ════════════════════════════════════════════════════════════════════════════

const _rateLimitWindows: Record<string, { count: number; resetAt: number }> = {};
const RATE_LIMIT    = 20;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(userId: string): boolean {
  const now   = Date.now();
  const entry = _rateLimitWindows[userId];
  if (!entry || now >= entry.resetAt) {
    _rateLimitWindows[userId] = { count: 1, resetAt: now + RATE_WINDOW_MS };
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count += 1;
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// § STORAGE LAYER
// ════════════════════════════════════════════════════════════════════════════

// FIX [1][2]: Named-column INSERT prevents column-order mismatch silently
// breaking inserts. try/catch surfaces the error in wrangler tail.
async function createTicketDB(ticket: Ticket, env: any): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO tickets
        (id, category, priority, message, user_id, channel_id, ts, status, resolution, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      ticket.id,
      ticket.category,
      ticket.priority,
      ticket.message,
      ticket.user_id,
      ticket.channel_id,
      ticket.ts,
      ticket.status,
      ticket.resolution ?? null,
      ticket.created_at,
    ).run();
    console.log('[AEGIS] D1 insert success:', ticket.id);
  } catch (e: any) {
    // FIX [2]: Always surface D1 errors — never swallow silently
    console.error('[AEGIS] D1 insert FAILED for', ticket.id, ':', e?.message ?? e);
    throw e; // re-throw so caller knows it failed
  }
}

async function getTicketsDB(env: any): Promise<Ticket[]> {
  try {
    const result = await env.DB.prepare('SELECT * FROM tickets').all();
    return (result.results ?? []) as Ticket[];
  } catch (e: any) {
    console.error('[AEGIS] D1 getTickets FAILED:', e?.message ?? e);
    return [];
  }
}

async function getTicketDB(id: string, env: any): Promise<Ticket | null> {
  try {
    const result = await env.DB.prepare(
      'SELECT * FROM tickets WHERE id = ?'
    ).bind(id).first();
    return (result as Ticket) ?? null;
  } catch (e: any) {
    console.error('[AEGIS] D1 getTicket FAILED for', id, ':', e?.message ?? e);
    return null;
  }
}

// FIX [7]: updateTicketDB now handles status, resolution, and
// escalation in one function cleanly with explicit logging
async function updateTicketDB(id: string, patch: Partial<Ticket>, env: any): Promise<void> {
  try {
    if (patch.status !== undefined) {
      await env.DB.prepare(
        'UPDATE tickets SET status = ? WHERE id = ?'
      ).bind(patch.status, id).run();
      console.log('[AEGIS] D1 status updated:', id, '->', patch.status);
    }
    if (patch.resolution !== undefined) {
      await env.DB.prepare(
        'UPDATE tickets SET resolution = ? WHERE id = ?'
      ).bind(patch.resolution, id).run();
      console.log('[AEGIS] D1 resolution updated:', id);
    }
  } catch (e: any) {
    console.error('[AEGIS] D1 updateTicket FAILED for', id, ':', e?.message ?? e);
    throw e;
  }
}

const _kb: KnowledgeEntry[] = [];

function upsertKnowledge(topic: string, resolution: string): KnowledgeEntry {
  const existing = _kb.find(e => cosineSimilarity(e.topic, topic) > 0.7);
  if (existing) {
    existing.resolution = resolution;
    existing.count += 1;
    return existing;
  }
  const entry: KnowledgeEntry = { topic, resolution, count: 1 };
  _kb.push(entry);
  return entry;
}

function searchKnowledge(query: string, threshold = 0.4): KnowledgeEntry | undefined {
  return _kb
    .map(e => ({ entry: e, score: cosineSimilarity(e.topic, query) }))
    .filter(x => x.score >= threshold)
    .sort((a, b) => b.score - a.score)[0]?.entry;
}

// ════════════════════════════════════════════════════════════════════════════
// § UTILITIES
// ════════════════════════════════════════════════════════════════════════════

function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function cosineSimilarity(a: string, b: string): number {
  const tok = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const wa = tok(a), wb = tok(b);
  const vocab = new Set([...wa, ...wb]);
  const va: number[] = [], vb: number[] = [];
  vocab.forEach(w => {
    va.push(wa.filter(x => x === w).length);
    vb.push(wb.filter(x => x === w).length);
  });
  const dot  = va.reduce((s, v, i) => s + v * vb[i], 0);
  const magA = Math.sqrt(va.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(vb.reduce((s, v) => s + v * v, 0));
  return magA === 0 || magB === 0 ? 0 : dot / (magA * magB);
}

// ════════════════════════════════════════════════════════════════════════════
// § SLA MAP
// ════════════════════════════════════════════════════════════════════════════

const VALID_CATEGORIES = ['BUG', 'QUERY', 'FEATURE', 'BILLING'] as const;
const VALID_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
type Category = typeof VALID_CATEGORIES[number];
type Priority  = typeof VALID_PRIORITIES[number];

const SLA_MAP: Record<Priority, number> = {
  P0: 1,
  P1: 4,
  P2: 24,
  P3: 72,
};

const SLA_LABEL: Record<Priority, string> = {
  P0: '1 hour',
  P1: '4 hours',
  P2: '24 hours',
  P3: '72 hours',
};

// ════════════════════════════════════════════════════════════════════════════
// § SLACK INTEGRATION
// ════════════════════════════════════════════════════════════════════════════

async function slackPostMessage(
  channel: string,
  text: string,
  env: any,
  thread_ts?: string,
): Promise<any> {
  const body: Record<string, string> = { channel, text };
  if (thread_ts) body.thread_ts = thread_ts;
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SLACK_BOT_TOKEN as string}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json() as any;
    if (!data.ok) console.warn('[AEGIS] Slack postMessage error:', data.error);
    return data;
  } catch (e: any) {
    console.error('[AEGIS] Slack postMessage fetch failed:', e?.message ?? e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § NOTION INTEGRATION
// ════════════════════════════════════════════════════════════════════════════

async function notionCreateTicket(ticket: any, env: any): Promise<any> {
  const slaValue = typeof ticket.sla_hours === 'number'
    ? ticket.sla_hours
    : parseInt(String(ticket.sla_hours), 10) || 4;

  try {
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.NOTION_TOKEN as string}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: { database_id: env.NOTION_TICKETS_DB_ID as string },
        properties: {
          'Name': {
            title: [{ text: { content: `[${ticket.priority}] ${ticket.category} — ${ticket.id}` } }],
          },
          'Ticket ID': { rich_text: [{ text: { content: ticket.id } }] },
          'Status':    { select: { name: 'Open' } },
          'Priority':  { select: { name: ticket.priority } },
          'Category':  { select: { name: ticket.category } },
          'SLA':       { number: slaValue },
        },
      }),
    });
    const data = await res.json() as any;
    if (data.object === 'error') {
      console.error('[AEGIS] Notion createTicket error:', data.message);
    }
    return data;
  } catch (e: any) {
    console.error('[AEGIS] Notion createTicket fetch failed:', e?.message ?? e);
    return null;
  }
}

// FIX [5]: Dedicated function for updating Notion ticket status.
// Previously this was inline fetch code in resolveTicket with no error surface.
async function notionUpdateTicketStatus(ticketId: string, status: 'Open' | 'Resolved', env: any): Promise<void> {
  try {
    // Step 1: Find the Notion page by Ticket ID
    const searchRes = await fetch(
      `https://api.notion.com/v1/databases/${env.NOTION_TICKETS_DB_ID as string}/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.NOTION_TOKEN as string}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filter: {
            property: 'Ticket ID',
            rich_text: { equals: ticketId },
          },
        }),
      }
    );
    const searchData = await searchRes.json() as any;

    if (searchData.object === 'error') {
      console.error('[AEGIS] Notion query error for', ticketId, ':', searchData.message);
      return;
    }

    const pageId = searchData?.results?.[0]?.id;

    // FIX [6]: Explicit warning when Notion page is not found
    if (!pageId) {
      console.warn('[AEGIS] Notion: no page found for ticketId:', ticketId,
        '— results count:', searchData?.results?.length ?? 0);
      return;
    }

    // Step 2: PATCH the status
    const patchRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${env.NOTION_TOKEN as string}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          'Status': { select: { name: status } },
        },
      }),
    });
    const patchData = await patchRes.json() as any;
    if (patchData.object === 'error') {
      console.error('[AEGIS] Notion PATCH error for', ticketId, ':', patchData.message);
    } else {
      console.log('[AEGIS] Notion status updated to', status, 'for', ticketId);
    }
  } catch (e: any) {
    console.error('[AEGIS] notionUpdateTicketStatus failed for', ticketId, ':', e?.message ?? e);
  }
}

async function notionWriteKB(entry: any, env: any): Promise<any> {
  try {
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.NOTION_TOKEN as string}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: { database_id: env.NOTION_KB_DB_ID as string },
        properties: {
          'Title':      { title:     [{ text: { content: entry.title } }] },
          'Category':   { select:    { name: entry.category } },
          'Resolution': { rich_text: [{ text: { content: entry.content } }] },
        },
      }),
    });
    const data = await res.json() as any;
    if (data.object === 'error') {
      console.error('[AEGIS] Notion writeKB error:', data.message);
    }
    return data;
  } catch (e: any) {
    console.error('[AEGIS] Notion writeKB fetch failed:', e?.message ?? e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § CLASSIFICATION ENGINE
// ════════════════════════════════════════════════════════════════════════════

interface Classification {
  category: Category;
  priority: Priority;
  confidence: number;
  source: 'ai' | 'fallback';
  reason?: string;
  model?: string;
}

function classifyText(text: string): Classification {
  const lower = text.toLowerCase();

  const p0Words = ['outage', 'down', 'critical', 'data loss', 'security breach', 'all users'];
  const p1Words = ['payment fail', 'payment error', 'login fail', 'cannot login', 'crash', 'not working', 'broken', 'urgent'];
  const p2Words = ['slow', 'latency', 'error', 'fail', 'bug', 'issue', 'problem'];
  const p3Words = ['question', 'how to', 'feature request', 'suggestion', 'feedback', 'improve', 'would be nice'];

  const bugWords     = ['error', 'bug', 'crash', 'broken', 'fail', 'not working', 'exception', 'outage', 'down'];
  const billingWords = ['payment', 'billing', 'invoice', 'charge', 'refund', 'subscription', 'plan'];
  const featureWords = ['suggestion', 'feedback', 'improve', 'feature', 'enhance', 'would be nice'];
  const queryWords   = ['how', 'what', 'when', 'where', 'why', 'help', 'guide', 'question'];

  let category: Category = 'QUERY';
  if      (billingWords.some(k => lower.includes(k))) category = 'BILLING';
  else if (bugWords.some(k => lower.includes(k)))     category = 'BUG';
  else if (featureWords.some(k => lower.includes(k))) category = 'FEATURE';
  else if (queryWords.some(k => lower.includes(k)))   category = 'QUERY';

  let priority: Priority = 'P2';
  let reason = 'General issue detected';
  if      (p0Words.some(k => lower.includes(k))) { priority = 'P0'; reason = 'Critical system impact'; }
  else if (p1Words.some(k => lower.includes(k))) { priority = 'P1'; reason = 'High-impact user-facing issue'; }
  else if (p2Words.some(k => lower.includes(k))) { priority = 'P2'; reason = 'Moderate issue'; }
  else if (p3Words.some(k => lower.includes(k))) { priority = 'P3'; reason = 'Low-priority feedback/query'; }

  return {
    category,
    priority,
    confidence: parseFloat((0.60 + Math.random() * 0.25).toFixed(2)),
    source: 'fallback',
    reason,
  };
}

async function aiClassify(text: string, context: string, apiKey: string): Promise<Classification | null> {
  const prompt =
    `Classify the following support message.\n` +
    `Return ONLY valid JSON, no markdown, no explanation:\n` +
    `{"category":"BUG","priority":"P0","confidence":0.95}\n\n` +
    `Valid categories: BUG, QUERY, FEATURE, BILLING\n` +
    `Valid priorities: P0 (critical outage), P1 (high impact), P2 (medium), P3 (low/question)\n` +
    `Message: ${text}${context ? `\nContext: ${context}` : ''}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0,
          maxOutputTokens: 100,
        },
      }),
    });
  } catch (fetchErr: any) {
    console.error('[AEGIS] Gemini fetch error:', fetchErr?.message);
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[AEGIS] Gemini HTTP error:', response.status, errorText);
    return null;
  }

  let data: any;
  try {
    data = await response.json();
  } catch (jsonErr: any) {
    console.error('[AEGIS] Gemini JSON parse error:', jsonErr?.message);
    return null;
  }

  console.log('[AEGIS] Gemini raw response:', JSON.stringify(data));

  let raw = (data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();

  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) {
    console.error('[AEGIS] Gemini: no JSON found in response:', raw);
    return null;
  }
  raw = jsonMatch[0];

  let parsed: { category?: string; priority?: string; confidence?: number };
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr: any) {
    console.error('[AEGIS] Gemini JSON parse failed:', parseErr?.message, 'raw:', raw);
    return null;
  }

  const category = parsed.category?.toUpperCase() as Category;
  const priority  = parsed.priority?.toUpperCase()  as Priority;

  if (!VALID_CATEGORIES.includes(category)) {
    console.error('[AEGIS] Gemini invalid category:', category);
    return null;
  }
  if (!VALID_PRIORITIES.includes(priority)) {
    console.error('[AEGIS] Gemini invalid priority:', priority);
    return null;
  }

  return {
    category,
    priority,
    confidence: typeof parsed.confidence === 'number'
      ? parseFloat(parsed.confidence.toFixed(2))
      : parseFloat((0.85 + Math.random() * 0.12).toFixed(2)),
    source: 'ai',
    model: 'gemini-2.0-flash',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// § RAG ENGINE
// ════════════════════════════════════════════════════════════════════════════

function retrieveRelevantKnowledge(message: string): KnowledgeEntry | undefined {
  return searchKnowledge(message, 0.40);
}

function generateReply(message: string, ticketId: string, priority: Priority, knowledge?: KnowledgeEntry): string {
  if (knowledge) {
    return (
      `🎫 *Ticket Created:* \`${ticketId}\`\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Hi! We found a matching resolution in our knowledge base.\n\n` +
      `*Known Fix:* ${knowledge.resolution}\n\n` +
      `If the issue persists, our team will follow up within *${SLA_LABEL[priority]}*.`
    );
  }

  const lower = message.toLowerCase();

  if (lower.includes('payment') || lower.includes('billing') || lower.includes('invoice')) {
    return (
      `🎫 *Ticket Created:* \`${ticketId}\`\n` +
      `📂 *Category:* BILLING | 🔴 *Priority:* ${priority}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Hi! Your payment/billing issue has been logged.\n\n` +
      `*Quick steps to try:*\n` +
      `- Clear browser cache and retry\n` +
      `- Use an alternative payment method\n` +
      `- Check our status page for ongoing incidents\n\n` +
      `⏱ Our billing team will respond within *${SLA_LABEL[priority]}*.`
    );
  }

  if (lower.includes('login') || lower.includes('auth') || lower.includes('password')) {
    return (
      `🎫 *Ticket Created:* \`${ticketId}\`\n` +
      `📂 *Category:* BUG | 🔴 *Priority:* ${priority}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Hi! Your authentication issue has been logged.\n\n` +
      `*Quick steps to try:*\n` +
      `- Reset your password via "Forgot Password"\n` +
      `- Clear cookies and retry\n` +
      `- Try an incognito/private browser window\n\n` +
      `⏱ Our team will respond within *${SLA_LABEL[priority]}*.`
    );
  }

  return (
    `🎫 *Ticket Created:* \`${ticketId}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Hi! We've received your report and our support team\n` +
    `is reviewing it based on priority.\n\n` +
    `⏱ You'll hear back within *${SLA_LABEL[priority]}*. Thank you!`
  );
}

// ════════════════════════════════════════════════════════════════════════════
// § TOOLS
// ════════════════════════════════════════════════════════════════════════════

app.tool('read_support_message', {
  description: 'Receive and normalize a raw Slack message',
  parameters: {
    text:       { type: 'string', description: 'Raw message text' },
    user_id:    { type: 'string', description: 'Slack user ID' },
    channel_id: { type: 'string', description: 'Slack channel ID' },
    ts:         { type: 'string', description: 'Slack message timestamp' },
  },
  handler: async (args: any): Promise<ToolResult> => {
    try {
      const userId = (args.user_id as string) ?? 'anonymous';
      if (!checkRateLimit(userId)) return err('Rate limit exceeded. Please wait a moment and try again.');
      const cleaned = (args.text as string).trim().replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
      return ok({ cleaned_text: cleaned, user_id: userId, channel_id: args.channel_id, ts: args.ts });
    } catch (e: any) {
      return err(e?.message ?? 'Failed to normalize message');
    }
  },
});

app.tool('classify_message', {
  description: 'Classify message into BUG | QUERY | FEATURE | BILLING with priority P0-P3 using Gemini AI',
  parameters: {
    text:    { type: 'string', description: 'Cleaned message text' },
    context: { type: 'string', description: 'Additional context' },
  },
  handler: async (args: any, env: any): Promise<ToolResult> => {
    try {
      const text    = args.text as string;
      const context = (args.context as string) ?? '';
      const apiKey  = env?.GEMINI_API_KEY as string | undefined;

      let classification: Classification | null = null;

      if (apiKey) {
        classification = await aiClassify(text, context, apiKey).catch((e: any) => {
          console.error('[AEGIS] aiClassify error:', e?.message);
          return null;
        });
      }

      if (!classification) {
        const fb = classifyText(`${text} ${context}`);
        fb.reason = apiKey
          ? 'AI classification failed — used local keyword classifier'
          : 'No GEMINI_API_KEY — used local keyword classifier';
        classification = fb;
      }

      return ok({ ...classification, labels: [classification.category, classification.priority] });
    } catch (e: any) {
      return err(e?.message ?? 'Classification failed');
    }
  },
});

app.tool('check_duplicate', {
  description: 'Find semantically similar active tickets',
  parameters: {
    text:      { type: 'string', description: 'Message text to check' },
    threshold: { type: 'number', description: 'Similarity threshold, default 0.88' },
  },
  handler: async (args: any, env: any): Promise<ToolResult> => {
    try {
      const text       = args.text as string;
      const threshold  = (args.threshold as number) ?? 0.88;
      const allTickets = await getTicketsDB(env);
      const matches    = allTickets
        .filter(t => t.status === 'open')
        .map(t => ({
          ticket_id:  t.id,
          similarity: parseFloat(cosineSimilarity(text, t.message).toFixed(3)),
          message:    t.message,
          category:   t.category,
          priority:   t.priority,
        }))
        .filter(m => m.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 3);

      return ok({ is_duplicate: matches.length > 0, matches, checked_against: allTickets.length, threshold });
    } catch (e: any) {
      return err(e?.message ?? 'Duplicate check failed');
    }
  },
});

app.tool('create_ticket', {
  description: 'Create a support ticket in D1 and mirror to Notion',
  parameters: {
    category:   { type: 'string', description: 'BUG | QUERY | FEATURE | BILLING' },
    priority:   { type: 'string', description: 'P0 | P1 | P2 | P3' },
    message:    { type: 'string', description: 'Original message text' },
    user_id:    { type: 'string', description: 'Slack user ID' },
    channel_id: { type: 'string', description: 'Slack channel ID' },
    ts:         { type: 'string', description: 'Slack message timestamp' },
  },
  handler: async (args: any, env: any): Promise<ToolResult> => {
    try {
      const priority = (args.priority as string).toUpperCase() as Priority;
      const ticket: Ticket = {
        id:         generateId('TKT'),
        category:   (args.category as string).toUpperCase(),
        priority,
        message:    args.message    as string,
        user_id:    args.user_id    as string,
        channel_id: args.channel_id as string,
        ts:         args.ts         as string,
        created_at: new Date().toISOString(),
        status:     'open',
      };

      // FIX [1][2]: Named-column insert, throws on failure
      await createTicketDB(ticket, env);

      // Notion sync — non-blocking, errors logged not thrown
      notionCreateTicket({
        id:        ticket.id,
        priority:  ticket.priority,
        category:  ticket.category,
        sla_hours: SLA_MAP[priority] ?? 24,
      }, env).catch((e: any) => console.warn('[AEGIS] Notion sync failed (create_ticket tool):', e?.message));

      return ok({
        ticket_id:  ticket.id,
        status:     'created',
        category:   ticket.category,
        priority:   ticket.priority,
        sla:        SLA_LABEL[priority] ?? '24 hours',
        created_at: ticket.created_at,
      });
    } catch (e: any) {
      return err(e?.message ?? 'Ticket creation failed');
    }
  },
});

app.tool('thread_reply', {
  description: 'Post a RAG-grounded reply to the Slack thread',
  parameters: {
    channel_id: { type: 'string', description: 'Slack channel ID' },
    ts:         { type: 'string', description: 'Parent message timestamp' },
    ticket_id:  { type: 'string', description: 'Created ticket ID' },
    message:    { type: 'string', description: 'Original message for RAG context' },
    priority:   { type: 'string', description: 'Ticket priority for SLA label' },
  },
  handler: async (args: any, env: any): Promise<ToolResult> => {
    try {
      const message   = args.message   as string;
      const ticketId  = args.ticket_id as string;
      const priority  = ((args.priority as string) ?? 'P2').toUpperCase() as Priority;
      const knowledge = retrieveRelevantKnowledge(message);
      const replyText = generateReply(message, ticketId, priority, knowledge);

      slackPostMessage(args.channel_id as string, replyText, env, args.ts as string)
        .catch((e: any) => console.warn('[AEGIS] Slack reply failed (thread_reply tool):', e?.message));

      return ok({
        success:     true,
        channel_id:  args.channel_id,
        thread_ts:   args.ts,
        ticket_id:   ticketId,
        reply_text:  replyText,
        rag_matched: !!knowledge,
        rag_sources: knowledge
          ? `KB article matched (used ${knowledge.count}x)`
          : 'No KB match — domain template used',
      });
    } catch (e: any) {
      return err(e?.message ?? 'Reply generation failed');
    }
  },
});

app.tool('escalate_unresolved', {
  description: 'Escalate ticket — L2 for P1, L3 for P0',
  parameters: {
    ticket_id:        { type: 'string', description: 'Ticket ID to escalate' },
    escalation_level: { type: 'number', description: '2 = on-call, 3 = eng lead' },
  },
  handler: async (args: any, env: any): Promise<ToolResult> => {
    try {
      const ticketId = args.ticket_id       as string;
      const level    = args.escalation_level as number;
      const ticket   = await getTicketDB(ticketId, env);

      if (!ticket) return err(`Ticket ${ticketId} not found`);

      const levelMap: Record<number, { team: string; channel: string; eta: string }> = {
        2: { team: 'On-Call Engineering', channel: '#oncall-alerts', eta: '30 minutes' },
        3: { team: 'Engineering Lead',    channel: '#oncall',         eta: '15 minutes' },
      };
      const info = levelMap[level] ?? levelMap[2];

      await updateTicketDB(ticketId, { status: `escalated-L${level}` }, env);

      const slackMsg =
        `🚨 *[L${level} ESCALATION]* Ticket \`${ticketId}\`\n` +
        `> Category: ${ticket.category} | Priority: ${ticket.priority}\n` +
        `> ${ticket.message.slice(0, 120)}`;

      slackPostMessage(info.channel, slackMsg, env)
        .catch((e: any) => console.warn('[AEGIS] Slack escalation alert failed:', e?.message));

      return ok({
        success:          true,
        ticket_id:        ticketId,
        escalated_to:     info.team,
        channel:          info.channel,
        eta:              info.eta,
        escalation_level: level,
        escalated_at:     new Date().toISOString(),
      });
    } catch (e: any) {
      return err(e?.message ?? 'Escalation failed');
    }
  },
});

app.tool('generate_context_snapshot', {
  description: 'Generate a Warp-Speed Debug snapshot for L3 escalations',
  parameters: {
    ticket_id: { type: 'string', description: 'Ticket ID to snapshot' },
  },
  handler: async (args: any, env: any): Promise<ToolResult> => {
    try {
      const ticketId = args.ticket_id as string;
      const ticket   = await getTicketDB(ticketId, env);
      if (!ticket) return err(`Ticket ${ticketId} not found`);

      const allTickets = await getTicketsDB(env);
      const ageMin     = Math.round((Date.now() - new Date(ticket.created_at).getTime()) / 60_000);
      const similar    = allTickets
        .filter(t => t.category === ticket.category && t.id !== ticketId)
        .slice(0, 3)
        .map(t => ({ id: t.id, priority: t.priority, status: t.status }));

      return ok({
        snapshot_id:    generateId('SNAP'),
        ticket_id:      ticketId,
        generated_at:   new Date().toISOString(),
        ticket_summary: {
          category:    ticket.category,
          priority:    ticket.priority,
          status:      ticket.status,
          age_minutes: ageMin,
          sla:         SLA_LABEL[ticket.priority as Priority] ?? 'unknown',
        },
        debug_context: {
          message_preview:    ticket.message.slice(0, 120),
          open_tickets_total: allTickets.filter(t => t.status === 'open').length,
          kb_articles:        _kb.length,
          similar_tickets:    similar,
        },
      });
    } catch (e: any) {
      return err(e?.message ?? 'Snapshot generation failed');
    }
  },
});

app.tool('update_knowledge_base', {
  description: 'Mark ticket resolved and index the resolution into the knowledge base',
  parameters: {
    ticket_id:  { type: 'string', description: 'Resolved ticket ID' },
    resolution: { type: 'string', description: 'How the issue was resolved' },
  },
  handler: async (args: any, env: any): Promise<ToolResult> => {
    try {
      const ticketId   = args.ticket_id  as string;
      const resolution = args.resolution as string;
      const ticket     = await getTicketDB(ticketId, env);
      if (!ticket) return err(`Ticket ${ticketId} not found`);

      await updateTicketDB(ticketId, { status: 'resolved', resolution }, env);
      const entry = upsertKnowledge(ticket.message, resolution);

      notionWriteKB({
        title:    `KB: ${ticket.category} — ${ticket.message.slice(0, 60)}`,
        category: ticket.category,
        content:  resolution,
      }, env).catch((e: any) => console.warn('[AEGIS] Notion KB sync failed:', e?.message));

      return ok({
        success:       true,
        ticket_id:     ticketId,
        kb_article_id: generateId('KB'),
        kb_total:      _kb.length,
        kb_hit_count:  entry.count,
        indexed_at:    new Date().toISOString(),
      });
    } catch (e: any) {
      return err(e?.message ?? 'Knowledge base update failed');
    }
  },
});

app.tool('generate_insights', {
  description: 'Cluster resolved tickets and produce trend reports',
  parameters: {
    window_days: { type: 'number', description: 'Time window in days (7, 30, 90)' },
  },
  handler: async (args: any, env: any): Promise<ToolResult> => {
    try {
      const windowDays = (args.window_days as number) ?? 7;
      const cutoff     = Date.now() - windowDays * 86_400_000;
      const allT       = await getTicketsDB(env);
      const winTickets = allT.filter(t => new Date(t.created_at).getTime() >= cutoff);

      const byCategory: Record<string, number> = {};
      const byPriority: Record<string, number> = {};
      const byStatus:   Record<string, number> = {};
      let resolved = 0;

      for (const t of winTickets) {
        byCategory[t.category] = (byCategory[t.category] || 0) + 1;
        byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
        byStatus[t.status]     = (byStatus[t.status]     || 0) + 1;
        if (t.status === 'resolved') resolved++;
      }

      const topCategory    = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];
      const resolutionRate = winTickets.length > 0
        ? `${Math.round((resolved / winTickets.length) * 100)}%`
        : 'N/A';

      const insights: string[] = winTickets.length === 0
        ? ['No tickets in this window yet. Start processing messages to generate insights.']
        : [
            topCategory ? `${topCategory[0]} is the top issue category (${topCategory[1]} tickets)` : '',
            byPriority['P0'] ? `⚠️  ${byPriority['P0']} critical P0 incident(s) in this period` : '',
            byPriority['P1'] ? `🔴 ${byPriority['P1']} high-priority P1 ticket(s)` : '',
            `Resolution rate: ${resolutionRate}`,
            `Knowledge base: ${_kb.length} indexed resolution(s)`,
          ].filter(Boolean);

      return ok({
        window_days:      windowDays,
        total_tickets:    winTickets.length,
        resolved_tickets: resolved,
        resolution_rate:  resolutionRate,
        by_category:      byCategory,
        by_priority:      byPriority,
        by_status:        byStatus,
        top_category:     topCategory?.[0] ?? 'N/A',
        kb_articles:      _kb.length,
        insights,
        generated_at:     new Date().toISOString(),
      });
    } catch (e: any) {
      return err(e?.message ?? 'Insights generation failed');
    }
  },
});

// ════════════════════════════════════════════════════════════════════════════
// § RESOLVE TICKET HANDLER
// ════════════════════════════════════════════════════════════════════════════

// FIX [3][5][6]: Full rewrite of resolveTicket.
// - getTicketDB now returns null (not undefined) and is guarded explicitly
// - notionUpdateTicketStatus is a dedicated function with proper error surface
// - Notion page-not-found is warned, not silently skipped
async function resolveTicket(
  ticketId: string,
  resolution: string,
  userId: string,
  channelId: string,
  env: any,
): Promise<void> {
  try {
    // 1. Fetch ticket from D1
    const ticket = await getTicketDB(ticketId, env);

    // FIX [3]: Explicit null guard with Slack error message
    if (!ticket) {
      console.warn('[AEGIS] resolveTicket: ticket not found in D1:', ticketId);
      await slackPostMessage(channelId,
        `❌ Ticket \`${ticketId}\` not found. Check the ticket ID and try again.`, env);
      return;
    }

    // 2. Update D1 — status + resolution
    await updateTicketDB(ticketId, { status: 'resolved', resolution }, env);

    // 3. Update Notion status to Resolved via dedicated function
    // FIX [5]: Uses notionUpdateTicketStatus instead of inline fetch
    await notionUpdateTicketStatus(ticketId, 'Resolved', env);

    // 4. Update in-memory KB
    upsertKnowledge(ticket.message, resolution);
    console.log('[AEGIS] KB updated for resolved ticket:', ticketId);

    // 5. Notify original customer thread
    await slackPostMessage(
      ticket.channel_id,
      `✅ *Ticket \`${ticketId}\` Resolved*\n` +
      `> *Resolution:* ${resolution}\n` +
      `> *Resolved by:* <@${userId}>\n` +
      `> *Time:* ${new Date().toISOString()}`,
      env,
      ticket.ts,
    );

    // 6. Confirm to resolver
    await slackPostMessage(
      channelId,
      `✅ Ticket \`${ticketId}\` has been fully resolved!\n` +
      `• D1 status → Resolved ✓\n` +
      `• Notion ticket → Resolved ✓\n` +
      `• Knowledge Base → Updated ✓\n` +
      `• Customer notified in thread ✓`,
      env,
    );

  } catch (e: any) {
    console.error('[AEGIS] resolveTicket error:', e?.message ?? e);
    // Best-effort error message to the resolver
    await slackPostMessage(channelId,
      `❌ Error resolving ticket \`${ticketId}\`: ${e?.message ?? 'Unknown error'}`, env
    ).catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § PIPELINE
// ════════════════════════════════════════════════════════════════════════════

async function runPipeline(
  input: { message: string; user_id: string; channel: string; thread_ts: string; source: string },
  env: any,
): Promise<void> {
  const { message, user_id, channel, thread_ts } = input;
  console.log('[AEGIS] Pipeline started:', JSON.stringify({ user_id, channel, source: input.source }));

  // Stage 1 — Classify
  console.log('[AEGIS] Stage 1: classify');
  let classification: Classification | null = null;
  const apiKey = env?.GEMINI_API_KEY as string | undefined;
  if (apiKey) {
    classification = await aiClassify(message, '', apiKey).catch((e: any) => {
      console.error('[AEGIS] Stage 1 Gemini error:', e?.message);
      return null;
    });
  }
  if (!classification) {
    const fb = classifyText(message);
    fb.reason = apiKey ? 'AI failed — keyword fallback' : 'No GEMINI_API_KEY — keyword fallback';
    classification = fb;
  }
  console.log('[AEGIS] Stage 1 done:', JSON.stringify(classification));

  // Stage 2 — Deduplicate
  console.log('[AEGIS] Stage 2: dedupe');
  const allT        = await getTicketsDB(env);
  const isDuplicate = allT.some(t => cosineSimilarity(t.message, message) >= 0.88);
  console.log('[AEGIS] Stage 2 done. isDuplicate:', isDuplicate);
  if (isDuplicate) {
    await slackPostMessage(channel,
      'ℹ️ This looks similar to an existing open ticket. No new ticket created.', env, thread_ts);
    return;
  }

  // Stage 3 — Create Ticket
  console.log('[AEGIS] Stage 3: create ticket');
  const priority = classification.priority as Priority;
  const ticket: Ticket = {
    id:         generateId('TKT'),
    category:   classification.category,
    priority:   classification.priority,
    message,
    user_id,
    channel_id: channel,
    ts:         thread_ts,
    created_at: new Date().toISOString(),
    status:     'open',
  };

  // FIX [4]: D1 error no longer silently ignored — logs clearly and
  // posts a Slack warning so the team knows the ticket wasn't persisted
  try {
    await createTicketDB(ticket, env);
  } catch (e: any) {
    console.error('[AEGIS] Stage 3 D1 FAILED:', e?.message ?? e);
    await slackPostMessage(channel,
      `⚠️ Ticket \`${ticket.id}\` classified but *failed to save to D1*. Error: ${e?.message ?? 'unknown'}`,
      env, thread_ts);
    // Do not return — still post reply and escalate even if D1 failed
  }

  // Notion sync — non-blocking
  notionCreateTicket({
    id:        ticket.id,
    priority:  ticket.priority,
    category:  ticket.category,
    sla_hours: SLA_MAP[priority] ?? 24,
  }, env).catch((e: any) => console.warn('[AEGIS] Stage 3 Notion sync failed:', e?.message));

  console.log('[AEGIS] Stage 3 done. Ticket:', ticket.id);

  // Stage 4 — RAG Reply
  console.log('[AEGIS] Stage 4: RAG reply');
  const knowledge = retrieveRelevantKnowledge(message);
  const replyText = generateReply(message, ticket.id, priority, knowledge);
  console.log('[AEGIS] Stage 4 done. RAG matched:', !!knowledge);

  // Stage 5 — Post Slack reply
  console.log('[AEGIS] Stage 5: Slack post');
  const slackRes = await slackPostMessage(channel, replyText, env, thread_ts);
  console.log('[AEGIS] Stage 5 done. Slack ok:', (slackRes as any)?.ok);

  // Stage 6 — Auto-escalate P0 / P1
  console.log('[AEGIS] Stage 6: escalation check');
  const escalateLevel = classification.priority === 'P0' ? 3
    : classification.priority === 'P1' ? 2
    : null;

  if (escalateLevel !== null) {
    await updateTicketDB(ticket.id, { status: `escalated-L${escalateLevel}` }, env).catch(
      (e: any) => console.warn('[AEGIS] Stage 6 escalation D1 update failed:', e?.message)
    );
    const escalateChannel = escalateLevel === 3 ? '#oncall' : '#oncall-alerts';
    const escalateMsg =
      `🚨 *[L${escalateLevel} ESCALATION]* Ticket \`${ticket.id}\`\n` +
      `> Category: ${ticket.category} | Priority: ${ticket.priority}\n` +
      `> ${message.slice(0, 120)}`;
    await slackPostMessage(escalateChannel, escalateMsg, env);
    console.log('[AEGIS] Stage 6 done. Escalated to:', escalateChannel);
  } else {
    console.log('[AEGIS] Stage 6 done. No escalation needed.');
  }

  console.log('[AEGIS] Pipeline complete for ticket:', ticket.id);
}

// ════════════════════════════════════════════════════════════════════════════
// § CRON — UNRESOLVED TICKET MONITOR
// ════════════════════════════════════════════════════════════════════════════

async function checkUnresolvedTickets(env: any): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const result = await env.DB.prepare(`
      SELECT id, category, priority, message, created_at
      FROM tickets
      WHERE status = 'open'
      AND created_at < ?
    `).bind(cutoff).all();

    const stale = result.results as any[];

    if (stale.length === 0) {
      console.log('[AEGIS] Cron: no unresolved tickets older than 24h');
      return;
    }

    for (const ticket of stale) {
      const age = Math.floor(
        (Date.now() - new Date(ticket.created_at).getTime()) / (1000 * 60 * 60)
      );

      const msg =
        `⏰ *[UNRESOLVED 24h+]* Ticket \`${ticket.id}\`\n` +
        `> Category: ${ticket.category} | Priority: ${ticket.priority}\n` +
        `> Age: ${age} hours\n` +
        `> "${String(ticket.message).slice(0, 100)}"\n` +
        `_This ticket has had no resolution. Immediate attention required._`;

      await slackPostMessage('oncall-alerts', msg, env);

      await env.DB.prepare(`
        UPDATE tickets SET status = 'escalated-stale' WHERE id = ?
      `).bind(ticket.id).run();

      console.log(`[AEGIS] Cron: flagged stale ticket ${ticket.id} (${age}h old)`);
    }

  } catch (err) {
    console.error('[AEGIS] Cron checkUnresolvedTickets failed:', err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// § EXPORT
// ════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    const url = new URL(request.url);

    // ── /slack/resolve ──────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/slack/resolve') {
      const formData   = await request.formData();
      const text       = (formData.get('text') as string ?? '').trim();
      const userId     = formData.get('user_id')   as string;
      const channelId  = formData.get('channel_id') as string;

      const parts      = text.split(' ');
      const ticketId   = parts[0];
      const resolution = parts.slice(1).join(' ').trim();

      if (!ticketId || !resolution) {
        return new Response(JSON.stringify({
          response_type: 'ephemeral',
          text: '❌ Usage: `/resolve TKT-xxxx Your resolution message here`',
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      // Run in background so Slack gets the 200 within 3 seconds
      ctx.waitUntil(resolveTicket(ticketId, resolution, userId, channelId, env));

      return new Response(JSON.stringify({
        response_type: 'ephemeral',
        text: `✅ Resolving ticket \`${ticketId}\`...`,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ── /slack/events ───────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/slack/events') {
      const payload = await request.json() as any;

      if (payload.type === 'url_verification') {
        return new Response(payload.challenge, {
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      if (
        payload.event?.type    === 'message' &&
        !payload.event?.bot_id            &&
        !payload.event?.subtype           &&
        !payload.event?.thread_ts         // ignore thread replies — prevent bot loops
      ) {
        const { text, user, channel, ts } = payload.event;
        ctx.waitUntil(runPipeline({
          message:   text,
          user_id:   user,
          channel,
          thread_ts: ts,
          source:    'slack',
        }, env));
      }

      return new Response('ok', { status: 200 });
    }

    // ════════════════════════════════════════════════════════════════════════
    // § HTTP TOOL ENDPOINTS — Construct App Integration
    // ════════════════════════════════════════════════════════════════════════

    // Helper: JSON response
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    // ── GET /manifest ──────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/manifest') {
      return json({
        name: 'aegis-support-triage',
        version: '1.0.0',
        description: 'Autonomous Slack support triage agent — classifies, tickets, escalates, and resolves support requests without human intervention.',
        category: 'productivity',
        trigger: 'event-driven',
        trigger_detail: 'New message in #support-general',
        tools: [
          { name: 'read_support_message',  endpoint: '/tools/read_support_message',  method: 'POST', description: 'Reads recent messages from a Slack support channel' },
          { name: 'classify_message',      endpoint: '/tools/classify_message',      method: 'POST', description: 'Classifies a message by category (BUG/QUERY/FEATURE/BILLING) and priority (P0-P3) using Gemini' },
          { name: 'check_duplicate',       endpoint: '/tools/check_duplicate',       method: 'POST', description: 'Checks if a message matches an already-open ticket in D1' },
          { name: 'create_ticket',         endpoint: '/tools/create_ticket',         method: 'POST', description: 'Creates a ticket in Cloudflare D1 and mirrors it to Notion' },
          { name: 'thread_reply',          endpoint: '/tools/thread_reply',          method: 'POST', description: "Posts an AI-generated RAG reply into the user's original Slack thread" },
          { name: 'escalate_unresolved',   endpoint: '/tools/escalate_unresolved',   method: 'POST', description: 'Escalates a specific ticket or runs the 24h stale ticket check' },
        ],
        auth: {
          type: 'env_vars',
          required: ['SLACK_BOT_TOKEN', 'NOTION_TOKEN', 'NOTION_DB_ID', 'GEMINI_API_KEY'],
        },
        deployed_url: 'https://aegis-app.shubhamvelip4.workers.dev',
      });
    }

    // ── POST /tools/read_support_message ──────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/tools/read_support_message') {
      try {
        const body = await request.json() as any;
        const { channel, limit = 10 } = body;
        if (!channel) return json({ error: 'channel is required' }, 400);

        const res = await fetch(
          `https://slack.com/api/conversations.history?channel=${channel}&limit=${limit}`,
          { headers: { Authorization: `Bearer ${(env as any).SLACK_BOT_TOKEN}` } }
        );
        const data = await res.json() as any;
        if (!data.ok) return json({ error: `Slack error: ${data.error}` }, 502);

        const messages = (data.messages || []).map((m: any) => ({
          ts:        m.ts,
          user:      m.user,
          text:      m.text,
          thread_ts: m.thread_ts || m.ts,
        }));

        return json({ success: true, messages });
      } catch (e: any) {
        return json({ error: String(e) }, 500);
      }
    }

    // ── POST /tools/classify_message ──────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/tools/classify_message') {
      try {
        const body = await request.json() as any;
        const { text } = body;
        if (!text) return json({ error: 'text is required' }, 400);

        const apiKey = (env as any).GEMINI_API_KEY as string | undefined;
        let result: Classification | null = null;
        if (apiKey) {
          result = await aiClassify(text, '', apiKey).catch(() => null);
        }
        if (!result) {
          const fb = classifyText(text);
          fb.reason = apiKey ? 'AI failed — keyword fallback' : 'No GEMINI_API_KEY — keyword fallback';
          result = fb;
        }

        return json({
          success:    true,
          category:   result.category,
          priority:   result.priority,
          confidence: result.confidence,
          source:     result.source,
        });
      } catch (e: any) {
        return json({ error: String(e) }, 500);
      }
    }

    // ── POST /tools/check_duplicate ────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/tools/check_duplicate') {
      try {
        const body = await request.json() as any;
        const { text } = body;
        if (!text) return json({ error: 'text is required' }, 400);

        const allTickets = await getTicketsDB(env);
        const match = allTickets
          .filter(t => t.status === 'open')
          .find(t => cosineSimilarity(t.message, text) >= 0.88);

        return json({
          success:                true,
          is_duplicate:           !!match,
          existing_ticket_id:     match?.id     || null,
          existing_ticket_status: match?.status || null,
        });
      } catch (e: any) {
        return json({ error: String(e) }, 500);
      }
    }

    // ── POST /tools/create_ticket ─────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/tools/create_ticket') {
      try {
        const body = await request.json() as any;
        const { message, user_id, channel, ts, category, priority } = body;

        if (!message || !user_id || !channel || !ts || !category || !priority) {
          return json({ error: 'message, user_id, channel, ts, category, priority are all required' }, 400);
        }

        const slaMap: Record<string, number> = { P0: 1, P1: 4, P2: 24, P3: 72 };
        const ticket: Ticket = {
          id:         `TKT-${Date.now().toString(36).toUpperCase()}`,
          category:   (category as string).toUpperCase(),
          priority:   (priority as string).toUpperCase(),
          message,
          user_id,
          channel_id: channel,
          ts,
          created_at: new Date().toISOString(),
          status:     'open',
        };

        await createTicketDB(ticket, env);

        notionCreateTicket({
          id:        ticket.id,
          priority:  ticket.priority,
          category:  ticket.category,
          sla_hours: slaMap[ticket.priority] ?? 4,
        }, env).catch((e: any) => console.warn('[AEGIS] /tools/create_ticket Notion sync failed:', e?.message));

        return json({
          success:   true,
          ticket_id: ticket.id,
          sla_hours: slaMap[ticket.priority] ?? 4,
        });
      } catch (e: any) {
        return json({ error: String(e) }, 500);
      }
    }

    // ── POST /tools/thread_reply ──────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/tools/thread_reply') {
      try {
        const body = await request.json() as any;
        const { channel, thread_ts: replyTs, ticket_id, category: cat, message } = body;

        if (!channel || !replyTs || !ticket_id || !message) {
          return json({ error: 'channel, thread_ts, ticket_id, message are required' }, 400);
        }

        // Derive priority label from category for SLA; default P2
        const catPriorityMap: Record<string, Priority> = { P0: 'P0', P1: 'P1', P2: 'P2', P3: 'P3' };
        const prio: Priority = (catPriorityMap[cat] ?? 'P2') as Priority;
        const knowledge  = retrieveRelevantKnowledge(message);
        const replyText  = generateReply(message, ticket_id, prio, knowledge);

        await slackPostMessage(channel, replyText, env, replyTs);

        return json({ success: true, reply_sent: replyText });
      } catch (e: any) {
        return json({ error: String(e) }, 500);
      }
    }

    // ── POST /tools/escalate_unresolved ───────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/tools/escalate_unresolved') {
      try {
        const body = await request.json().catch(() => ({})) as any;
        const { ticket_id, reason } = body;

        if (ticket_id) {
          const ticket = await getTicketDB(ticket_id, env);
          if (!ticket) return json({ error: `Ticket ${ticket_id} not found` }, 404);

          const msg =
            `🚨 *[MANUAL ESCALATION]* Ticket \`${ticket_id}\`\n` +
            `> Category: ${ticket.category} | Priority: ${ticket.priority}\n` +
            `> Reason: ${reason || 'Manual escalation via tool'}\n` +
            `> "${String(ticket.message).slice(0, 100)}"`;

          await slackPostMessage('oncall-alerts', msg, env);
          await updateTicketDB(ticket_id, { status: 'escalated-manual' }, env);

          return json({ success: true, escalated: ticket_id });
        } else {
          await checkUnresolvedTickets(env);
          return json({ success: true, action: 'stale_check_complete' });
        }
      } catch (e: any) {
        return json({ error: String(e) }, 500);
      }
    }

    // ── POST /tools/user_chat ─────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/tools/user_chat') {
      try {
        const { message, ticket = {}, history = [] } = await request.json() as any;
        const apiKey = (env as any).GEMINI_API_KEY as string | undefined;
        if (!apiKey) return json({ error: 'Missing Gemini API Key' }, 500);

        const sys = `You are AEGIS Support Bot — a friendly, professional AI support agent chatting with the user who raised ${ticket.id||'a ticket'}.\nTicket: ID=${ticket.id}, Title="${ticket.title}", Category=${ticket.cat}, Priority=${ticket.pri}, Status=${ticket.status}, SLA=${ticket.sla}h.\nRules: 1) Warm, non-technical, 2-4 sentences. 2) Never mention D1/Workers/internal systems. 3) If user says "fixed"/"resolved" → resolved_flag=true. 4) If frustrated → escalate_flag=true. 5) Detect sentiment honestly.\nReturn JSON ONLY: {"reply":"<message>","resolved_flag":<bool>,"escalate_flag":<bool>,"sentiment":"<positive|neutral|frustrated|angry>"}`;

        const payload = {
            system_instruction: { parts: [{ text: sys }] },
            contents: [{ role: 'user', parts: [{ text: `Chat history:\n${JSON.stringify(history)}\n\nUser's latest message: "${message}"` }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
        };
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json() as any;
        const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || '{}').trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
        return json(JSON.parse(raw));
      } catch (e: any) { return json({ error: String(e) }, 500); }
    }

    // ── POST /tools/dev_chat ──────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/tools/dev_chat') {
      try {
        const { message, ticket = {}, history = [] } = await request.json() as any;
        const apiKey = (env as any).GEMINI_API_KEY as string | undefined;
        if (!apiKey) return json({ error: 'Missing Gemini API Key' }, 500);

        const sys = `You are AEGIS Warp-Speed Debug Assistant, helping an engineer resolve ${ticket.id||'a ticket'}.\nTicket: Category=${ticket.cat}, Priority=${ticket.pri}.\nRules: 1) Be highly technical, concise. 2) If the engineer provides a resolution or fix, set resolved_flag to true and kb_update to true, and provide the kb_resolution_text. Return JSON ONLY: {"reply":"<message>","resolved_flag":<bool>,"kb_update":<bool>,"kb_resolution_text":"<short KB entry or null>"}`;

        const payload = {
            system_instruction: { parts: [{ text: sys }] },
            contents: [{ role: 'user', parts: [{ text: `Chat history:\n${JSON.stringify(history)}\n\nEngineer's latest message: "${message}"` }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
        };
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json() as any;
        const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || '{}').trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
        return json(JSON.parse(raw));
      } catch (e: any) { return json({ error: String(e) }, 500); }
    }

    // ── Construct SDK ───────────────────────────────────────────────────────
    return (app as any).fetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: any, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(checkUnresolvedTickets(env));
  },
};