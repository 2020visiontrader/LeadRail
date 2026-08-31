// A small, dependency-free Markdown -> block-model parser shared by the
// docx and pdf renderers in lib/capabilities/deliverables.ts.
//
// This is deliberately NOT a full CommonMark implementation. The model is
// asked for a specific, narrow subset (see the `createFile` description):
// headings, paragraphs, bullet lists, numbered lists, and **bold**/*italic*
// inline emphasis. Anything else degrades gracefully to a plain paragraph
// rather than throwing — a slightly-off render is fine, a crash on a stray
// character is not, because the alternative is refusing to hand over the
// file at all.

export interface InlineRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

export type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3; runs: InlineRun[] }
  | { type: 'paragraph'; runs: InlineRun[] }
  | { type: 'bullet'; items: InlineRun[][] }
  | { type: 'numbered'; items: InlineRun[][] };

/** Split a line of raw markdown into bold/italic-aware runs.
 *  Supports **bold**, *italic* / _italic_, and ***bold italic***. */
export function parseInlineRuns(raw: string): InlineRun[] {
  const runs: InlineRun[] = [];
  // Matches, in priority order: ***x***, **x**, *x*, _x_.
  const re = /\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushPlain = (s: string) => {
    if (s) runs.push({ text: s, bold: false, italic: false });
  };
  while ((m = re.exec(raw))) {
    pushPlain(raw.slice(last, m.index));
    if (m[1] !== undefined) runs.push({ text: m[1], bold: true, italic: true });
    else if (m[2] !== undefined) runs.push({ text: m[2], bold: true, italic: false });
    else if (m[3] !== undefined) runs.push({ text: m[3], bold: false, italic: true });
    else if (m[4] !== undefined) runs.push({ text: m[4], bold: false, italic: true });
    last = re.lastIndex;
  }
  pushPlain(raw.slice(last));
  return runs.length ? runs : [{ text: raw, bold: false, italic: false }];
}

/** Parse a markdown document into a flat list of blocks. Blank lines
 *  separate paragraphs; consecutive `-`/`*` lines group into one bullet
 *  block, consecutive `N.` lines into one numbered block. */
export function parseMarkdownBlocks(markdown: string): MdBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3;
      blocks.push({ type: 'heading', level, runs: parseInlineRuns(heading[2].trim()) });
      i++;
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      const items: InlineRun[][] = [parseInlineRuns(bullet[1].trim())];
      i++;
      while (i < lines.length) {
        const next = /^[-*]\s+(.*)$/.exec(lines[i]);
        if (!next) break;
        items.push(parseInlineRuns(next[1].trim()));
        i++;
      }
      blocks.push({ type: 'bullet', items });
      continue;
    }

    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      const items: InlineRun[][] = [parseInlineRuns(numbered[1].trim())];
      i++;
      while (i < lines.length) {
        const next = /^\d+[.)]\s+(.*)$/.exec(lines[i]);
        if (!next) break;
        items.push(parseInlineRuns(next[1].trim()));
        i++;
      }
      blocks.push({ type: 'numbered', items });
      continue;
    }

    // Plain paragraph: gather lines until a blank line or a line that starts
    // a new block kind.
    const paraLines: string[] = [line.trim()];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+[.)]\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'paragraph', runs: parseInlineRuns(paraLines.join(' ')) });
  }

  return blocks;
}

/** Flatten a block list back to plain text (no markup, no styling) — used to
 *  reject empty/whitespace-only "markdown" up front. */
export function blocksHaveText(blocks: MdBlock[]): boolean {
  return blocks.some((b) => {
    if (b.type === 'heading' || b.type === 'paragraph') return b.runs.some((r) => r.text.trim());
    return b.items.some((item) => item.some((r) => r.text.trim()));
  });
}
