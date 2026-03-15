/**
 * Sanitize HTML from Shiki syntax highlighter.
 * Only allows safe tags/attributes used by Shiki output.
 * Prevents XSS from any injected content in code files.
 */

const ALLOWED_TAGS = new Set(['pre', 'code', 'span', 'div', 'br']);
const ALLOWED_ATTRS = new Set(['class', 'style']);

export function sanitizeShikiHtml(html: string): string {
  // Remove script tags and event handlers completely
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]*/gi, '')
    .replace(/javascript\s*:/gi, '');

  // Remove disallowed tags but keep their content
  clean = clean.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tag) => {
    const lowerTag = tag.toLowerCase();
    if (ALLOWED_TAGS.has(lowerTag)) {
      // Strip disallowed attributes from allowed tags
      return match.replace(/\s([a-zA-Z-]+)\s*=\s*["'][^"']*["']/g, (attrMatch, attrName) => {
        return ALLOWED_ATTRS.has(attrName.toLowerCase()) ? attrMatch : '';
      });
    }
    // Remove the tag but keep content (return empty for the tag itself)
    return '';
  });

  return clean;
}
