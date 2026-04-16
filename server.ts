import { ConstructApp } from '@construct-computer/app-sdk';

const app = new ConstructApp({ name: 'text-tools', version: '0.1.0' });

app.tool('slugify', {
  description: 'Convert a string into a URL-safe slug (lowercase, dashes, ASCII only).',
  parameters: {
    text: { type: 'string', description: 'Input text to slugify' },
  },
  handler: async (args) => {
    const text = String(args.text ?? '');
    return text
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  },
});

app.tool('word_count', {
  description: 'Count words, characters (with and without whitespace), and lines in a string.',
  parameters: {
    text: { type: 'string', description: 'Input text to analyze' },
  },
  handler: async (args) => {
    const text = String(args.text ?? '');
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const lines = text ? text.split(/\r\n|\r|\n/).length : 0;
    return JSON.stringify({
      words,
      characters: text.length,
      characters_no_spaces: text.replace(/\s/g, '').length,
      lines,
    });
  },
});

app.tool('json_format', {
  description: 'Format, minify, or validate a JSON string.',
  parameters: {
    text: { type: 'string', description: 'JSON string to process' },
    mode: {
      type: 'string',
      enum: ['format', 'minify', 'validate'],
      description: 'Operation mode (default: format)',
    },
    indent: {
      type: 'number',
      description: 'Spaces per indent level when formatting (default: 2)',
    },
  },
  handler: async (args) => {
    const text = String(args.text ?? '');
    const mode = String(args.mode ?? 'format');
    const indent = Number(args.indent ?? 2);
    try {
      const parsed = JSON.parse(text);
      if (mode === 'validate') return 'Valid JSON';
      if (mode === 'minify') return JSON.stringify(parsed);
      return JSON.stringify(parsed, null, indent);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: `Invalid JSON: ${msg}` }], isError: true };
    }
  },
});

app.tool('base64', {
  description: 'Encode or decode a Base64 string.',
  parameters: {
    text: { type: 'string', description: 'Input string' },
    mode: {
      type: 'string',
      enum: ['encode', 'decode'],
      description: 'Operation mode (default: encode)',
    },
  },
  handler: async (args) => {
    const text = String(args.text ?? '');
    const mode = String(args.mode ?? 'encode');
    if (mode === 'decode') {
      try {
        const bin = atob(text.trim());
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
      } catch {
        return { content: [{ type: 'text', text: 'Invalid base64 input.' }], isError: true };
      }
    }
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  },
});

app.tool('hash', {
  description: 'Generate a cryptographic hash (SHA-1, SHA-256, SHA-384, or SHA-512).',
  parameters: {
    text: { type: 'string', description: 'Input string to hash' },
    algorithm: {
      type: 'string',
      enum: ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'],
      description: 'Hash algorithm (default: SHA-256)',
    },
  },
  handler: async (args) => {
    const text = String(args.text ?? '');
    const algo = String(args.algorithm ?? 'SHA-256');
    const data = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest(algo, data);
    const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${algo}: ${hex}`;
  },
});

app.tool('uuid', {
  description: 'Generate one or more v4 UUIDs.',
  parameters: {
    count: {
      type: 'number',
      description: 'Number of UUIDs to generate (default: 1, max: 50)',
    },
  },
  handler: async (args) => {
    const count = Math.min(Math.max(1, Number(args.count ?? 1)), 50);
    return Array.from({ length: count }, () => crypto.randomUUID()).join('\n');
  },
});

app.tool('timestamp', {
  description: 'Convert between Unix timestamps (seconds) and ISO 8601 dates. Pass a number for Unix→ISO or a date string for ISO→Unix. With no input, returns the current time.',
  parameters: {
    value: { type: 'string', description: 'Unix timestamp (seconds) or ISO 8601 date string' },
  },
  handler: async (args) => {
    const raw = String(args.value ?? '').trim();
    if (!raw) {
      const now = new Date();
      return JSON.stringify({ unix: Math.floor(now.getTime() / 1000), iso: now.toISOString() });
    }
    // If it looks like a number, treat as unix seconds
    if (/^\d+(\.\d+)?$/.test(raw)) {
      const ms = parseFloat(raw) * 1000;
      const d = new Date(ms);
      if (isNaN(d.getTime())) return { content: [{ type: 'text', text: 'Invalid timestamp.' }], isError: true };
      return JSON.stringify({ unix: parseFloat(raw), iso: d.toISOString() });
    }
    // Otherwise parse as a date string
    const d = new Date(raw);
    if (isNaN(d.getTime())) return { content: [{ type: 'text', text: `Cannot parse date: "${raw}"` }], isError: true };
    return JSON.stringify({ unix: Math.floor(d.getTime() / 1000), iso: d.toISOString() });
  },
});

app.tool('url_encode', {
  description: 'URL-encode or decode a string.',
  parameters: {
    text: { type: 'string', description: 'Input string' },
    mode: {
      type: 'string',
      enum: ['encode', 'decode'],
      description: 'Operation mode (default: encode)',
    },
  },
  handler: async (args) => {
    const text = String(args.text ?? '');
    const mode = String(args.mode ?? 'encode');
    try {
      return mode === 'decode' ? decodeURIComponent(text) : encodeURIComponent(text);
    } catch {
      return { content: [{ type: 'text', text: 'Invalid input for URL decoding.' }], isError: true };
    }
  },
});

app.tool('reverse', {
  description: 'Reverse a string by Unicode code point (emoji-safe).',
  parameters: {
    text: { type: 'string', description: 'String to reverse' },
  },
  handler: async (args) => {
    return Array.from(String(args.text ?? '')).reverse().join('');
  },
});

export default app;
