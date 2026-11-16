import { Editor, Extension, createDocument } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import BubbleMenu from '@tiptap/extension-bubble-menu';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { Markdown } from 'tiptap-markdown';
import { common, createLowlight } from 'lowlight';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const lowlight = createLowlight(common);
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

/* ---------- Images: show relative paths via webview URI, keep original path in markdown ---------- */
let baseUri = '';
const isRelative = (src: string) => !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src);
const LocalImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const src = HTMLAttributes.src as string | undefined;
    const attrs = { ...HTMLAttributes };
    if (src && baseUri && isRelative(src)) attrs.src = baseUri + '/' + src.replace(/^\.\//, '');
    return ['img', attrs];
  },
});

/* ---------- Code block with language picker ---------- */
const LANGS = ['', ...lowlight.listLanguages().sort()];
const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'code-block';
      const select = document.createElement('select');
      select.contentEditable = 'false';
      select.className = 'lang';
      for (const l of LANGS) select.add(new Option(l || 'auto', l));
      select.value = node.attrs.language ?? '';
      select.addEventListener('change', () => {
        const pos = (getPos as () => number)();
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: select.value || null }));
        editor.commands.focus();
      });
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      pre.append(code);
      dom.append(select, pre);
      return {
        dom, contentDOM: code,
        update: n => {
          if (n.type !== current.type) return false;
          current = n;
          select.value = n.attrs.language ?? '';
          return true;
        },
        stopEvent: e => select.contains(e.target as Node),
        ignoreMutation: m => select.contains(m.target as Node),
      };
    };
  },
});

/* ---------- Find (Cmd/Ctrl+F) ---------- */
type Match = { from: number; to: number };
const findKey = new PluginKey<DecorationSet>('find');
const find = { query: '', caseSensitive: false, matches: [] as Match[], index: -1 };

function computeMatches(doc: import('@tiptap/pm/model').Node): Match[] {
  if (!find.query) return [];
  const q = find.caseSensitive ? find.query : find.query.toLowerCase();
  const out: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Map each character of the block's text back to a document position.
    let text = '';
    const map: number[] = [];
    node.forEach((child, off) => {
      if (child.isText) for (let i = 0; i < child.text!.length; i++) { text += child.text![i]; map.push(pos + 1 + off + i); }
      else { text += '\ufffc'; map.push(pos + 1 + off); }
    });
    const hay = find.caseSensitive ? text : text.toLowerCase();
    for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) {
      out.push({ from: map[i], to: map[i + q.length - 1] + 1 });
    }
    return false;
  });
  return out;
}

const FindHighlight = Extension.create({
  name: 'findHighlight',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: findKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, old) => {
          if (!tr.docChanged && !tr.getMeta(findKey)) return old;
          find.matches = computeMatches(tr.doc);
          if (find.index >= find.matches.length) find.index = find.matches.length - 1;
          return DecorationSet.create(tr.doc, find.matches.map((m, i) =>
            Decoration.inline(m.from, m.to, { class: i === find.index ? 'find-match current' : 'find-match' })));
        },
      },
      props: { decorations: state => findKey.getState(state) },
    })];
  },
});

/* ---------- Sync with the host document ---------- */
let lastText = '';
let timer: number | undefined;
const flush = () => {
  clearTimeout(timer);
  const text = getMarkdown();
  if (text !== lastText) { lastText = text; vscode.postMessage({ type: 'edit', text }); }
};
const send = (text: string) => {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (text === lastText) return;
    lastText = text;
    vscode.postMessage({ type: 'edit', text });
  }, 150);
};
/* ---------- Table column widths, persisted as the dash count of the separator row ----------
   `| -------- | ---- |` → 80px, 40px (1 dash = 10px). Plain `---` means "auto". */
const PX_PER_DASH = 10;
const SEP_RE = /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$|^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/;

/** Calls fn(lineIndex) for each table separator row outside fenced code, in document order. */
function forEachSeparator(lines: string[], fn: (i: number) => void) {
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return; }
    if (!fence && i > 0 && lines[i - 1].includes('|') && SEP_RE.test(line)) fn(i);
  });
}
const sepCells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

function readWidths(md: string): (number[] | null)[] {
  const out: (number[] | null)[] = [];
  const lines = md.split('\n');
  forEachSeparator(lines, i => {
    const dashes = sepCells(lines[i]).map(c => c.replace(/:/g, '').length);
    out.push(dashes.every(d => d === 3) ? null : dashes.map(d => d * PX_PER_DASH));
  });
  return out;
}

function tableWidths(): (number[] | null)[] {
  const out: (number[] | null)[] = [];
  editor.state.doc.descendants(node => {
    if (node.type.name !== 'table') return true;
    const ws: (number | null)[] = [];
    node.firstChild?.forEach(cell => {
      const cw = cell.attrs.colwidth as number[] | null;
      for (let k = 0; k < cell.attrs.colspan; k++) ws.push(cw?.[k] ?? null);
    });
    out.push(ws.some(w => w) ? ws.map(w => w ?? 120) : null);
    return false;
  });
  return out;
}

function applyWidths(widths: (number[] | null)[]) {
  const tr = editor.state.tr;
  let t = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;
    const ws = widths[t++];
    if (ws) {
      node.forEach((row, rowOff) => {
        let col = 0;
        row.forEach((cell, cellOff) => {
          const cw = ws.slice(col, col + cell.attrs.colspan);
          col += cell.attrs.colspan;
          if (cw.length) tr.setNodeMarkup(pos + 1 + rowOff + 1 + cellOff, undefined, { ...cell.attrs, colwidth: cw });
        });
      });
    }
    return false;
  });
  if (tr.docChanged) editor.view.dispatch(tr.setMeta('addToHistory', false).setMeta('fromHost', true));
}

function writeWidths(md: string): string {
  const widths = tableWidths();
  if (!widths.some(Boolean)) return md;
  const lines = md.split('\n');
  let t = 0;
  forEachSeparator(lines, i => {
    const ws = widths[t++];
    if (!ws) return;
    const cells = sepCells(lines[i]);
    lines[i] = '| ' + cells.map((c, k) => {
      const n = Math.max(3, Math.round((ws[k] ?? 30) / PX_PER_DASH));
      return (c.startsWith(':') ? ':' : '') + '-'.repeat(n) + (c.length > 1 && c.endsWith(':') ? ':' : '');
    }).join(' | ') + ' |';
  });
  return lines.join('\n');
}

const getMarkdown = (): string => writeWidths((editor.storage as any).markdown.getMarkdown());

/* ---------- Editor ---------- */
const editor: Editor = new Editor({
  element: $('#wysiwyg'),
  extensions: [
    StarterKit.configure({ codeBlock: false }),
    CodeBlock.configure({ lowlight, defaultLanguage: null }),
    Link.configure({ openOnClick: false, autolink: true }),
    LocalImage,
    FindHighlight,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true, cellMinWidth: 40 }),
    TableRow, TableHeader, TableCell,
    Placeholder.configure({
      placeholder: ({ node }) => node.type.name === 'heading' ? `Heading ${node.attrs.level}` : "Type '/' for commands…",
    }),
    BubbleMenu.configure({ element: $('#bubble'), shouldShow: ({ editor, state }) => !state.selection.empty && !editor.isActive('codeBlock') && !editor.isActive('image') }),
    Markdown.configure({ html: false, linkify: true, transformPastedText: true, transformCopiedText: true, tightLists: true }),
  ],
  editorProps: {
    handleKeyDown: (_v, e) => findKeyDown(e) || undoRedoKey(e) || slashKey(e) || tableShortcut(e),
    // Copying inside a code block yields just the code, not a fenced ``` block.
    clipboardTextSerializer: (slice, view): string => {
      const { $from, $to } = view.state.selection;
      if ($from.parent.type.name === 'codeBlock' && $from.sameParent($to)) {
        return slice.content.textBetween(0, slice.content.size, '\n');
      }
      return (editor.storage as any).markdown.serializer.serialize(slice.content);
    },
  },
  onUpdate: ({ transaction }) => {
    if (transaction.getMeta('fromHost')) return;
    blockShortcut(); send(getMarkdown()); updateSlash();
  },
  onSelectionUpdate: () => { updateUi(); updateSlash(); },
  onTransaction: ({ transaction }) => { updateUi(); if (transaction.docChanged && !$('#find').hidden) updateFindLabel(); },
});

const setFromHost = (text: string) => {
  clearTimeout(timer);
  // Replace only the part that actually differs, so the cursor and scroll stay put. A full
  // setContent would move the cursor to the end even for trivial changes (e.g. a final newline
  // added on save).
  const html = (editor.storage as any).markdown.parser.parse(text);
  const next = createDocument(html, editor.schema);
  const cur = editor.state.doc;
  const start = cur.content.findDiffStart(next.content);
  if (start != null) {
    let { a, b } = cur.content.findDiffEnd(next.content)!;
    const overlap = start - Math.min(a, b);
    if (overlap > 0) { a += overlap; b += overlap; }
    editor.view.dispatch(editor.state.tr.replace(start, a, next.slice(start, b))
      .setMeta('addToHistory', false).setMeta('fromHost', true));
  }
  applyWidths(readWidths(text));
  // Whatever the editor now serializes to is in sync with the host; don't echo it back.
  lastText = getMarkdown();
};
window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'init') baseUri = msg.baseUri ?? '';
  if (msg.type === 'init' || msg.type === 'update') setFromHost(msg.text);
});

/* ---------- Commands ---------- */
const chain = () => editor.chain().focus();
const commands: Record<string, () => void> = {
  bold: () => chain().toggleBold().run(),
  italic: () => chain().toggleItalic().run(),
  strike: () => chain().toggleStrike().run(),
  code: () => chain().toggleCode().run(),
  paragraph: () => chain().setParagraph().run(),
  h1: () => chain().toggleHeading({ level: 1 }).run(),
  h2: () => chain().toggleHeading({ level: 2 }).run(),
  h3: () => chain().toggleHeading({ level: 3 }).run(),
  bullet: () => chain().toggleBulletList().run(),
  ordered: () => chain().toggleOrderedList().run(),
  task: () => chain().toggleTaskList().run(),
  quote: () => chain().toggleBlockquote().run(),
  codeblock: () => chain().toggleCodeBlock().run(),
  hr: () => chain().setHorizontalRule().run(),
  table: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  image: () => openPrompt('Image URL or relative path', '', src => chain().setImage({ src }).run()),
  link: () => {
    if (editor.isActive('link')) { chain().unsetLink().run(); return; }
    openPrompt('Link URL', 'https://', href => chain().extendMarkRange('link').setLink({ href }).run());
  },
  undo: () => chain().undo().run(),
  redo: () => chain().redo().run(),
  addRowAfter: () => chain().addRowAfter().run(),
  addColAfter: () => chain().addColumnAfter().run(),
  delRow: () => chain().deleteRow().run(),
  delCol: () => chain().deleteColumn().run(),
  delTable: () => chain().deleteTable().run(),
};
const isOn: Record<string, () => boolean> = {
  bold: () => editor.isActive('bold'), italic: () => editor.isActive('italic'), strike: () => editor.isActive('strike'),
  code: () => editor.isActive('code'), link: () => editor.isActive('link'),
  h1: () => editor.isActive('heading', { level: 1 }), h2: () => editor.isActive('heading', { level: 2 }), h3: () => editor.isActive('heading', { level: 3 }),
  bullet: () => editor.isActive('bulletList'), ordered: () => editor.isActive('orderedList'), task: () => editor.isActive('taskList'),
  quote: () => editor.isActive('blockquote'), codeblock: () => editor.isActive('codeBlock'),
};

function updateUi() {
  document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach(b => b.classList.toggle('on', !!isOn[b.dataset.cmd!]?.()));
  $('#tablebar').hidden = !editor.isActive('table');
}

/* ---------- Inline prompt (links / images) ---------- */
let promptCb: ((v: string) => void) | null = null;
const promptBar = $('#prompt'), promptInput = $<HTMLInputElement>('#prompt input'), promptLabel = $('#prompt label');
function openPrompt(label: string, initial: string, cb: (v: string) => void) {
  promptCb = cb; promptLabel.textContent = label; promptInput.value = initial;
  promptBar.hidden = false; promptInput.focus(); promptInput.select();
}
promptInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); const v = promptInput.value.trim(); promptBar.hidden = true; if (v) promptCb?.(v); }
  else if (e.key === 'Escape') { promptBar.hidden = true; editor.commands.focus(); }
});
promptInput.addEventListener('blur', () => { promptBar.hidden = true; });

/* ---------- Slash menu ---------- */
const SLASH = [
  { id: 'paragraph', label: 'Text', hint: 'Plain paragraph', icon: 'T' },
  { id: 'h1', label: 'Heading 1', hint: '#', icon: 'H1' },
  { id: 'h2', label: 'Heading 2', hint: '##', icon: 'H2' },
  { id: 'h3', label: 'Heading 3', hint: '###', icon: 'H3' },
  { id: 'bullet', label: 'Bulleted list', hint: '-', icon: '•' },
  { id: 'ordered', label: 'Numbered list', hint: '1.', icon: '1.' },
  { id: 'task', label: 'To-do list', hint: '[ ]', icon: '☑' },
  { id: 'quote', label: 'Quote', hint: '>', icon: '❝' },
  { id: 'codeblock', label: 'Code block', hint: '```', icon: '{}' },
  { id: 'table', label: 'Table', hint: '3 × 3', icon: '▦' },
  { id: 'hr', label: 'Divider', hint: '---', icon: '—' },
  { id: 'image', label: 'Image', hint: 'URL or path', icon: '▣' },
];
const menu = $('#slash');
let slash: { from: number; items: typeof SLASH; index: number } | null = null;

function updateSlash() {
  const { $from, empty } = editor.state.selection;
  const text = empty && !editor.isActive('codeBlock') ? $from.parent.textBetween(0, $from.parentOffset, undefined, '￼') : '';
  const m = /(?:^|\s)\/([\w ]{0,20})$/.exec(text);
  if (!m) return closeSlash();
  const q = m[1].toLowerCase().trim();
  const items = SLASH.filter(i => i.label.toLowerCase().includes(q) || i.id.includes(q));
  if (!items.length) return closeSlash();
  slash = { from: $from.pos - m[1].length - 1, items, index: Math.min(slash?.index ?? 0, items.length - 1) };
  renderSlash();
}
function renderSlash() {
  if (!slash) return;
  menu.innerHTML = '';
  slash.items.forEach((it, i) => {
    const el = document.createElement('div');
    el.className = 'item' + (i === slash!.index ? ' sel' : '');
    el.innerHTML = `<span class="ic"></span><span class="lb"></span><span class="ht"></span>`;
    (el.children[0] as HTMLElement).textContent = it.icon;
    (el.children[1] as HTMLElement).textContent = it.label;
    (el.children[2] as HTMLElement).textContent = it.hint;
    el.addEventListener('mousedown', e => { e.preventDefault(); runSlash(i); });
    menu.append(el);
  });
  const c = editor.view.coordsAtPos(slash.from);
  menu.hidden = false;
  const below = c.bottom + 6 + menu.offsetHeight < window.innerHeight;
  menu.style.top = `${below ? c.bottom + 6 : Math.max(4, c.top - menu.offsetHeight - 6)}px`;
  menu.style.left = `${Math.min(c.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}
function closeSlash() { slash = null; menu.hidden = true; }
function runSlash(i: number) {
  if (!slash) return;
  const item = slash.items[i];
  editor.chain().focus().deleteRange({ from: slash.from, to: editor.state.selection.from }).run();
  closeSlash();
  commands[item.id]();
}
function slashKey(e: KeyboardEvent): boolean {
  if (!slash) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const n = slash.items.length;
    slash.index = (slash.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderSlash(); return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') { runSlash(slash.index); return true; }
  if (e.key === 'Escape') { closeSlash(); return true; }
  return false;
}
window.addEventListener('blur', closeSlash);
$('#wysiwyg').addEventListener('scroll', closeSlash);

/* ---------- Find bar UI ---------- */
const findBar = $('#find'), findInput = $<HTMLInputElement>('#find-input'), findCount = $('#find-count');
const findCase = $<HTMLButtonElement>('#find-case');

function refreshFind(scroll = false) {
  editor.view.dispatch(editor.state.tr.setMeta(findKey, true).setMeta('addToHistory', false));
  updateFindLabel();
  if (scroll && find.index >= 0) {
    const m = find.matches[find.index];
    const dom = editor.view.domAtPos(m.from).node as HTMLElement;
    (dom.nodeType === 1 ? dom : dom.parentElement)?.scrollIntoView({ block: 'center' });
  }
}
function updateFindLabel() {
  const n = find.matches.length;
  findCount.textContent = !find.query ? 'No results' : n ? `${find.index + 1} of ${n}` : 'No results';
  findBar.classList.toggle('none', !!find.query && !n);
}
function step(dir: 1 | -1) {
  const n = find.matches.length;
  if (!n) return;
  find.index = (find.index + dir + n) % n;
  refreshFind(true);
}
function openFind() {
  const { from, to, empty } = editor.state.selection;
  const sel = empty ? '' : editor.state.doc.textBetween(from, to, ' ');
  if (sel && !sel.includes('\n')) findInput.value = sel;
  findBar.hidden = false;
  findInput.focus(); findInput.select();
  find.query = findInput.value;
  find.matches = computeMatches(editor.state.doc);
  // Start at the first match after the cursor.
  find.index = find.matches.findIndex(m => m.from >= from);
  if (find.index < 0) find.index = find.matches.length ? 0 : -1;
  refreshFind(true);
}
function closeFind() {
  findBar.hidden = true;
  const m = find.matches[find.index];
  find.query = ''; find.index = -1;
  refreshFind();
  if (m) editor.commands.setTextSelection(m);
  editor.commands.focus();
}
function isFindShortcut(e: KeyboardEvent) {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f';
}
function findKeyDown(e: KeyboardEvent): boolean {
  if (isFindShortcut(e)) { e.stopPropagation(); openFind(); return true; }
  if (!findBar.hidden && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') { e.stopPropagation(); step(e.shiftKey ? -1 : 1); return true; }
  if (e.key === 'Escape' && !findBar.hidden && !slash) { closeFind(); return true; }
  return false;
}
findInput.addEventListener('input', () => {
  find.query = findInput.value;
  find.matches = computeMatches(editor.state.doc);
  find.index = find.matches.length ? 0 : -1;
  refreshFind(true);
});
findBar.addEventListener('keydown', e => {
  // Keep these keys from being forwarded to VS Code by the webview wrapper.
  if (isFindShortcut(e)) { e.preventDefault(); e.stopPropagation(); findInput.select(); return; }
  if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') { e.preventDefault(); e.stopPropagation(); step(e.shiftKey ? -1 : 1); }
  else if (e.altKey && e.code === 'KeyC') { e.preventDefault(); findCase.click(); }
});
findCase.addEventListener('click', () => {
  find.caseSensitive = !find.caseSensitive;
  findCase.classList.toggle('on', find.caseSensitive);
  find.matches = computeMatches(editor.state.doc);
  find.index = find.matches.length ? 0 : -1;
  refreshFind(true);
  findInput.focus();
});
$('#find-next').addEventListener('click', () => { step(1); findInput.focus(); });
$('#find-prev').addEventListener('click', () => { step(-1); findInput.focus(); });
$('#find-close').addEventListener('click', closeFind);
// Cmd+F outside the editor content (e.g. empty area) should open the bar too.
document.addEventListener('keydown', e => {
  if (isFindShortcut(e)) { e.preventDefault(); e.stopPropagation(); openFind(); }
});

/* ---------- Undo / redo ----------
   VS Code's webview wrapper forwards every Cmd/Ctrl+Z/Y to the workbench, which also undoes the
   TextDocument. Doing both makes the two histories fight. Handle it here and stop the event before
   it bubbles to the window listener that forwards it. */
function undoRedoKey(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  const k = e.key.toLowerCase();
  const isUndo = k === 'z' && !e.shiftKey;
  const isRedo = (k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey);
  if (!isUndo && !isRedo) return false;
  e.stopPropagation();
  if (isUndo) editor.commands.undo(); else editor.commands.redo();
  flush();
  return true;
}

/* ---------- Markdown block shortcuts that also work with IME (e.g. Korean) input ----------
   ProseMirror input rules don't run for composed input, so re-check after every update. */
let inShortcut = false;
function blockShortcut() {
  if (inShortcut) return;
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== 'paragraph' || $from.depth > 3) return;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
  if ($from.parentOffset > 20 || !/[\s\u00a0]$/.test(before)) return;
  const start = $from.start();
  const rules: [RegExp, (m: RegExpExecArray) => (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>][] = [
    [/^(#{1,6})[\s\u00a0]$/, m => c => c.setNode('heading', { level: m[1].length })],
    [/^\[( |x)?\][\s\u00a0]$/i, () => c => c.toggleTaskList()],
    [/^[-*+][\s\u00a0]$/, () => c => c.toggleBulletList()],
    [/^(\d+)\.[\s\u00a0]$/, m => c => c.toggleOrderedList().updateAttributes('orderedList', { start: Number(m[1]) })],
    [/^>[\s\u00a0]$/, () => c => c.toggleBlockquote()],
    [/^```([\w+#-]*)[\s\u00a0]$/, m => c => c.setCodeBlock({ language: m[1] || null } as any)],
  ];
  for (const [re, make] of rules) {
    const m = re.exec(before);
    if (!m) continue;
    inShortcut = true;
    try { make(m)(editor.chain().deleteRange({ from: start, to: $from.pos })).run(); }
    finally { inShortcut = false; }
    return;
  }
}

/* ---------- Typing "| a | b |" then Enter creates a table ---------- */
function tableShortcut(e: KeyboardEvent): boolean {
  if (e.key !== 'Enter' || e.shiftKey || editor.isActive('table') || editor.isActive('codeBlock')) return false;
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== 'paragraph') return false;
  const text = $from.parent.textContent.trim();
  if (!/^\|.*\|$/.test(text)) return false;
  const cells = text.slice(1, -1).split('|').map(c => c.trim());
  if (cells.length < 2) return false;
  const start = $from.before(), end = $from.after();
  const cell = (type: string, t: string) => ({ type, content: [{ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] }] });
  editor.chain().focus().insertContentAt({ from: start, to: end }, {
    type: 'table',
    content: [
      { type: 'tableRow', content: cells.map(c => cell('tableHeader', c)) },
      { type: 'tableRow', content: cells.map(() => cell('tableCell', '')) },
    ],
  }).run();
  // Put the cursor in the first body cell.
  const table = editor.state.doc.nodeAt(start);
  if (table?.type.name === 'table') editor.commands.setTextSelection(start + 1 + table.child(0).nodeSize + 3);
  return true;
}

/* ---------- Wiring ---------- */
document.querySelectorAll('#bubble, #tablebar').forEach(bar => {
  bar.addEventListener('mousedown', e => { if ((e.target as HTMLElement).closest('button')) e.preventDefault(); });
  bar.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest('button');
    if (b?.dataset.cmd) commands[b.dataset.cmd]();
  });
});
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); commands.link(); }
});

updateUi();
vscode.postMessage({ type: 'ready' });
