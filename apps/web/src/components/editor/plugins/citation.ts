/**
 * citation.ts
 *
 * Milkdown custom inline node for `[@<project-relative-path>]` source
 * citations — the way AI-written research pages / context bullets point
 * back at the contributor note or raw import they came from.
 *
 * - Parses [@sources/contributors/u/2026-09-14.md] from Markdown
 * - Serializes back to [@path] verbatim (round-trips through autosave)
 * - Renders as <a class="citation-chip"> showing the file name
 * - click dispatches `milkdown:citation-click`; App.tsx routes it to the file
 *
 * Same shape as ./wikilink.ts; no input rule — users don't type citations,
 * the maintainer does.
 */

import { $node, $prose } from '@milkdown/kit/utils';
import { remarkPluginsCtx } from '@milkdown/kit/core';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import type { NodeType } from '@milkdown/kit/prose/model';
import type { MarkdownNode, SerializerState } from '@milkdown/kit/transformer';
import { CITATION_RE, citationLabel, dispatchCitationClick } from '../../../lib/citations';

// ---------------------------------------------------------------------------
// Remark plugin: split text nodes around [@path] into citation nodes
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function remarkCitation(): (tree: any) => void {
  return (tree: MarkdownNode) => {
    visit(tree, 'text', (node: MarkdownNode, index: number | null, parent: MarkdownNode | null) => {
      if (!parent || index === null) return;
      const value = node['value'] as string;
      CITATION_RE.lastIndex = 0;
      if (!CITATION_RE.test(value)) return;
      CITATION_RE.lastIndex = 0;

      const children: MarkdownNode[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = CITATION_RE.exec(value)) !== null) {
        if (m.index > last) children.push({ type: 'text', value: value.slice(last, m.index) } as MarkdownNode);
        const path = (m[1] ?? '').trim();
        children.push({ type: 'citation', data: { hName: 'citation', hProperties: { path } }, path } as MarkdownNode);
        last = m.index + m[0].length;
      }
      if (children.length === 0) return;
      if (last < value.length) children.push({ type: 'text', value: value.slice(last) } as MarkdownNode);
      parent.children!.splice(index, 1, ...children);
    });
  };
}

function visit(
  node: MarkdownNode,
  type: string,
  visitor: (node: MarkdownNode, index: number | null, parent: MarkdownNode | null) => void,
): void {
  if (node.type === type) visitor(node, null, null);
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!;
      if (child.type === type) {
        visitor(child, i, node);
        i = node.children.indexOf(child);
      } else {
        visit(child, type, visitor);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Milkdown node schema
// ---------------------------------------------------------------------------

export const citationNode = $node('citation', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { path: { default: '' } },
  parseDOM: [
    {
      tag: 'a[data-citation]',
      getAttrs(dom: HTMLElement | string) {
        if (typeof dom === 'string') return {};
        return { path: dom.getAttribute('data-path') ?? '' };
      },
    },
  ],
  toDOM(node) {
    const { path } = node.attrs as { path: string };
    return [
      'a',
      {
        'data-citation': 'true',
        'data-path': path,
        class: 'citation-chip',
        href: `#cite:${path}`,
        title: `Source: ${path}`,
      },
      citationLabel(path),
    ];
  },
  toMarkdown: {
    match: (node) => node.type.name === 'citation',
    runner(state: SerializerState, node) {
      const { path } = node.attrs as { path: string };
      state.addNode('text', [], `[@${path}]`);
    },
  },
  parseMarkdown: {
    match: (node) => node.type === 'citation',
    runner(state, node, type: NodeType) {
      state.addNode(type, { path: (node['path'] as string) ?? '' });
    },
  },
}));

export const citationRemarkPlugin: MilkdownPlugin = (ctx) => async () => {
  ctx.get(remarkPluginsCtx).push({ plugin: remarkCitation as import('@milkdown/kit/transformer').RemarkPlugin['plugin'], options: {} });
};

// ---------------------------------------------------------------------------
// Click: intercept at mousedown (before ProseMirror's atom-node selection)
// ---------------------------------------------------------------------------

const citationKey = new PluginKey('citation-interactions');

export const citationInteractionPlugin = $prose(() => new Plugin({
  key: citationKey,
  props: {
    handleDOMEvents: {
      mousedown(_view, event: Event) {
        const e = event as MouseEvent;
        if (e.button !== 0) return false;
        const tEl = e.target instanceof Element ? e.target : (e.target as Node).parentElement;
        const el = tEl?.closest('a.citation-chip') as HTMLElement | null;
        if (!el) return false;
        e.preventDefault();
        e.stopPropagation();
        const path = el.getAttribute('data-path') ?? '';
        if (path) dispatchCitationClick(path, e.metaKey || e.ctrlKey);
        return true;
      },
      click(_view, event: Event) {
        const e = event as MouseEvent;
        const tEl = e.target instanceof Element ? e.target : (e.target as Node).parentElement;
        if (!tEl?.closest('a.citation-chip')) return false;
        e.preventDefault();
        return true;
      },
    },
  },
}));

export const citationPlugins = [citationNode, citationRemarkPlugin, citationInteractionPlugin];
