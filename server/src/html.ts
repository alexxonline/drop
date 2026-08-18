const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escapes a value for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c)
}
