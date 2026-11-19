// Small Markdown renderer. All text is escaped first, and raw HTML is never allowed.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(raw) {
  const codes = [];
  let s = esc(raw).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isRule = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l || '');

export function markdown(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const fence = l.match(/^\s*```/);
    if (fence) {
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const n = Math.min(h[1].length + 1, 6); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (l.includes('|') && isRule(lines[i + 1])) {
      const head = cells(l).map((c) => `<th>${inline(c)}</th>`).join('');
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(`<tr>${cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      out.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(l)) {
      const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdown(q.join('\n'))}</blockquote>`);
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
    if (li.test(l)) {
      const ordered = /\d/.test(l.match(li)[1]);
      const items = [];
      for (; i < lines.length; i++) {
        const m = lines[i].match(li);
        if (m) items.push(inline(m[2]));
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1] += ` ${inline(lines[i].trim())}`;
        else if (!lines[i].trim() && li.test(lines[i + 1] || '')) continue;
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((x) => `<li>${x}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) && !(lines[i].includes('|') && isRule(lines[i + 1])); i++) para.push(lines[i]);
    if (!para.length) { para.push(lines[i]); i++; }
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
}
