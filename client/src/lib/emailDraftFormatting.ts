function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function prepareEmailDraft(html: string) {
  const tables: { marker: string; html: string }[] = [];
  const withoutTables = html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => {
    const marker = `[Included table ${tables.length + 1} — shown below]`;
    tables.push({ marker, html: table });
    return `\n\n${marker}\n\n`;
  });
  const body = withoutTables
    .replace(/<a\b[^>]*href=(["'])(https?:\/\/.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
      (_match, _quote, url: string, label: string) => `${label} (${url}) `)
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>|<\/li>|<\/div>|<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .trim();
  return { body, tables };
}

/** Keep server-owned tables intact while allowing ordinary message edits. */
export function renderEditedEmail(defaultHtml: string, body: string): string {
  const prepared = prepareEmailDraft(defaultHtml);
  if (body === prepared.body) return defaultHtml;
  let html = body.split(/\n{2,}/).map((paragraph) => {
    const safe = escapeText(paragraph).replace(/https?:\/\/[^\s<()]+/g,
      (url) => `<a href="${url}">${url}</a>`);
    return `<p>${safe.replace(/\n/g, '<br/>')}</p>`;
  }).join('\n');
  for (const table of prepared.tables) {
    const paragraph = `<p>${table.marker}</p>`;
    if (html.includes(paragraph)) html = html.replace(paragraph, table.html);
    else if (html.includes(table.marker)) html = html.replace(table.marker, `</p>${table.html}<p>`);
    else html += `\n${table.html}`;
    // A copied marker must not duplicate the automatically included table.
    html = html.split(table.marker).join('');
  }
  return html;
}
