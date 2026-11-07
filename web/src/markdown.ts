import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

/** Renders model or note Markdown. Images are removed, so a model steered by book text
 * can't leak anything through a remote image URL. */
export function renderMarkdown(source: string, citations: boolean | number[] = false) {
  const html = marked.parse(source, { async: false });
  const clean = DOMPurify.sanitize(html, { FORBID_TAGS: ['img', 'style', 'form', 'input'], FORBID_ATTR: ['style'] });
  if (!citations) return clean;
  return clean.replace(/\[(\d{1,3})\]/g, (marker, n) => Array.isArray(citations) && !citations.includes(Number(n)) ? marker : `<button type="button" class="cite" data-cite="${n}" aria-label="Source ${n}">[${n}]</button>`);
}
