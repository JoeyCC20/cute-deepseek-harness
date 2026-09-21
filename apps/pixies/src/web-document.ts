/** Render the Host's `webserver/index-inject` table onto an index HTML body. */

import type { PixiesHostInjection } from './host-protocol.ts'

/** Escape a row-controlled string for a quoted HTML attribute. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** Render one structured injection row to markup with its placement. */
function renderInjectionRow(row: PixiesHostInjection): { placement: 'head' | 'body'; markup: string } {
  switch (row.kind) {
    case 'global': {
      // `<` is escaped in JSON so a row-controlled string cannot break out
      // of the script element.
      const name = JSON.stringify(row.name).replaceAll('<', '\\u003c')
      const value = row.value === undefined
        ? 'undefined'
        : JSON.stringify(row.value).replaceAll('<', '\\u003c')
      return { placement: 'head', markup: `<script>globalThis[${name}] = ${value}</script>` }
    }
    case 'script':
      return { placement: row.placement, markup: `<script>${row.text}</script>` }
    case 'script-src':
      return { placement: row.placement, markup: `<script src="${escapeHtmlAttribute(row.src)}"></script>` }
    case 'script-preload':
      return { placement: 'head', markup: `<link rel="preload" as="script" href="${escapeHtmlAttribute(row.src)}">` }
    case 'style':
      return { placement: 'head', markup: `<style>${row.text}</style>` }
    case 'html':
      return { placement: row.placement, markup: row.html }
  }
}

/**
 * Apply one structured injection table to an `index.html` body. Mirrors
 * `@deepseek-ai/dsh-host-webserver` `renderIndexInjections` so any carrier
 * (test harness, future local serve, …) renders the same head/body sequence
 * the Host webserver would have applied itself. PIXIES no longer uses this
 * helper for `dsh-app://app/index.html` — the protocol handler forwards that
 * path to the host loopback so the host can inject `__ModuleLoader__` itself —
 * but the helper stays available for tests and any future local carrier.
 *
 * @param html - the raw index.html body.
 * @param rows - the injection table the Host collected at boot.
 * @returns the html with every row rendered.
 */
export function applyPixiesInjections(html: string, rows: readonly PixiesHostInjection[]): string {
  let head = ''
  let body = ''
  for (const row of rows) {
    const rendered = renderInjectionRow(row)
    if (rendered.placement === 'head') head += rendered.markup
    else body += rendered.markup
  }
  let out = html
  if (head !== '') {
    const open = /<head(?:\s[^>]*)?>/i.exec(out)
    // Headless fixture pages may lack <head>; prepending keeps the rows ahead
    // of every document script.
    out = open === null ? `${head}${out}` : `${out.slice(0, open.index + open[0].length)}${head}${out.slice(open.index + open[0].length)}`
  }
  if (body !== '') {
    const open = /<body(?:\s[^>]*)?>/i.exec(out)
    // Body-less fragments receive the rows at the end, where the HTML parser
    // has already synthesized a body.
    out = open === null ? `${out}${body}` : `${out.slice(0, open.index + open[0].length)}${body}${out.slice(open.index + open[0].length)}`
  }
  return out
}
