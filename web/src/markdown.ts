import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

/** Renders model or note Markdown. Images are removed, so a model steered by book text
 * can't leak anything through a remote image URL. */
export function renderMarkdown(source: string, citations = false) {
  const html = marked.parse(source, { async: false });
  const clean = DOMPurify.sanitize(html, { FORBID_TAGS: ['img', 'style', 'form', 'input'], FORBID_ATTR: ['style'] });
  if (!citations) return clean;
  return clean.replace(/\[(\d{1,3})\]/g, '<button type="button" class="cite" data-cite="$1">$1</button>');
}
