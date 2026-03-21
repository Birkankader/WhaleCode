import DOMPurify from 'dompurify';

const purify = DOMPurify(window);

purify.setConfig({
  ALLOWED_TAGS: ['pre', 'code', 'span', 'div', 'br'],
  ALLOWED_ATTR: ['class', 'style'],
  ALLOW_DATA_ATTR: false,
});

/**
 * Sanitize HTML from Shiki syntax highlighter using DOMPurify.
 * Only allows safe tags/attributes used by Shiki output.
 */
export function sanitizeShikiHtml(html: string): string {
  return purify.sanitize(html, {
    ALLOWED_TAGS: ['pre', 'code', 'span', 'div', 'br'],
    ALLOWED_ATTR: ['class', 'style'],
    ALLOW_DATA_ATTR: false,
  });
}
