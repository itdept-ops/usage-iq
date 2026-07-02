/**
 * A tiny, dependency-free, SAFE markdown → HTML renderer for the Family Hub note bodies. We deliberately
 * avoid pulling in a markdown library: notes are short and family-authored, and the security bar is "never
 * inject raw HTML". So the pipeline is: HTML-escape EVERYTHING first (so any `<script>` etc. becomes inert
 * text), THEN apply a small set of inline/block markdown rules that only ever emit a fixed, known-safe set
 * of tags. The result is meant to be bound via [innerHTML]; because the source was fully escaped up front,
 * no user-supplied markup can survive.
 *
 * Supported: # / ## / ### headings, - and * bullet lists, 1. ordered lists, > blockquotes, **bold**,
 * *italic* / _italic_, `code`, ~~strike~~, [text](http/https/mailto link), and paragraphs/line breaks.
 */

/** Escape the five HTML-significant characters so nothing in the source can become live markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only allow safe URL schemes for links (http/https/mailto); anything else (javascript:, data:) is dropped. */
function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  // Allow in-app/anchor links only: a single leading '/' (NOT '//' or '/\', which browsers treat as
  // protocol-relative → external origin) followed by a non-slash/backslash char, or a '#' anchor.
  if (/^#/.test(u) || /^\/(?![/\\])/.test(u)) return u;
  return null;
}

/** Apply inline markup to an ALREADY HTML-escaped string. */
function inline(escaped: string): string {
  let s = escaped;
  // Links: [text](url) — text and url are already escaped; validate the scheme.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    const decoded = url.replace(/&amp;/g, '&'); // undo our escape just for scheme inspection
    const safe = safeUrl(decoded);
    if (!safe) return text;
    const href = escapeHtml(safe);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  // `code`
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // **bold**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // ~~strike~~
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // *italic* and _italic_ (single, after bold so ** is already consumed)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  return s;
}

/**
 * Render markdown to a safe HTML string. The whole input is HTML-escaped first, so the only tags in the
 * output are the fixed ones this function emits. Safe to bind with [innerHTML].
 */
export function renderMarkdown(src: string | null | undefined): string {
  const text = (src ?? '').replace(/\r\n/g, '\n');
  if (!text.trim()) return '';

  const lines = text.split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(escapeHtml(paragraph.join(' ')))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (!line.trim()) { flushParagraph(); closeList(); continue; }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(); closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph(); closeList();
      out.push(`<blockquote>${inline(escapeHtml(quote[1]))}</blockquote>`);
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(escapeHtml(bullet[1]))}</li>`);
      continue;
    }

    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(escapeHtml(ordered[1]))}</li>`);
      continue;
    }

    // Plain text → accumulate into the current paragraph.
    closeList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  closeList();
  return out.join('');
}
