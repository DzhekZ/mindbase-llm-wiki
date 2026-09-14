// apps/web/src/lib/citations.ts
//
// `[@<project-relative-path>]` is how AI-written pages point back at the
// source they were synthesized from (mirrors apps/server/src/ops/gather.ts
// parseCitations). Shared by the Milkdown citation node (rendered notes)
// and the read-only ReactMarkdown views (context.md on the wiki home).

export const CITATION_RE = /\[@([^\]\s]+)\]/g;

/** Compact chip label: the file name without `.md`, prefixed with `@`. */
export function citationLabel(path: string): string {
  const base = path.split('/').pop() ?? path;
  return `@${base.replace(/\.md$/i, '')}`;
}

/** Rewrite `[@path]` into markdown links on a `#cite:` hash for ReactMarkdown. */
export function linkifyCitations(md: string): string {
  return md.replace(CITATION_RE, (_m, path: string) => `[${citationLabel(path)}](#cite:${path})`);
}

export const CITATION_CLICK_EVENT = 'milkdown:citation-click';

/** Route a citation click through App.tsx (which knows the tree categories). */
export function dispatchCitationClick(path: string, newTab = false): void {
  document.dispatchEvent(new CustomEvent(CITATION_CLICK_EVENT, { detail: { path, newTab }, bubbles: true }));
}
