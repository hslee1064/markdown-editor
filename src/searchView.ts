import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { MarkdownEditorProvider } from './markdownEditorProvider';

/** A text match handed to the Markdown Editor so it can scroll to and highlight it. */
export type Reveal = {
  query: string; caseSensitive: boolean;
  occurrence: number; total: number; // n-th occurrence of `query` in the raw text, out of `total`
  offset: number; length: number;    // raw-text offset of the match and the raw text length
};

type Opts = {
  query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean;
  include: string; exclude: string; openOnly: boolean; useExclude: boolean;
  replace?: string; preserveCase?: boolean;
};
type LineMatch = { line: number; col: number; len: number; before: string; text: string; after: string; offset: number; full: string };
type FileResult = { uri: string; name: string; dir: string; matches: LineMatch[] };

const icon = (d: string) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const REPLACE_ALL = icon('<path d="M2 3.5h5v4H2zM2 10h5"/><path d="M9.5 5.5h4M11.5 3.5l2 2-2 2"/><path d="M9.5 12h4M11.5 10l2 2-2 2"/>');
const BOOK = icon('<path d="M2.5 3h4a1.5 1.5 0 0 1 1.5 1.5V13a1 1 0 0 0-1-1H2.5zM13.5 3h-4A1.5 1.5 0 0 0 8 4.5V13a1 1 0 0 1 1-1h4.5z"/>');
const GEAR = icon('<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>');

const MAX_RESULTS = 10_000;
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const isMarkdown = (uri: vscode.Uri) => /\.(md|markdown)$/i.test(uri.path);

export class SearchViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'markdownEditor.search';
  private view?: vscode.WebviewView;
  private searchId = 0;
  private cts?: vscode.CancellationTokenSource;
  private last?: Opts;
  private lastFiles?: string[];

  static register(context: vscode.ExtensionContext, editors: MarkdownEditorProvider): vscode.Disposable {
    const p = new SearchViewProvider(context, editors);
    return vscode.Disposable.from(
      vscode.window.registerWebviewViewProvider(SearchViewProvider.viewId, p, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.commands.registerCommand('markdownEditor.search.focus', () => p.focus()),
      vscode.commands.registerCommand('markdownEditor.search.refresh', () => p.last && p.run(p.last)),
      vscode.commands.registerCommand('markdownEditor.search.clear', () => p.post({ type: 'clear' })),
      vscode.commands.registerCommand('markdownEditor.search.collapseAll', () => p.post({ type: 'collapseAll' })),
      vscode.commands.registerCommand('markdownEditor.search.expandAll', () => p.post({ type: 'expandAll' })),
      vscode.commands.registerCommand('markdownEditor.search.focusReplace', () => p.focus('focusReplace')),
    );
  }

  constructor(private readonly context: vscode.ExtensionContext, private readonly editors: MarkdownEditorProvider) {}

  private post(msg: unknown) { this.view?.webview.postMessage(msg); }

  private async focus(type = 'focus') {
    await vscode.commands.executeCommand(`${SearchViewProvider.viewId}.focus`);
    // Seed the query with the selected text of a text editor, like the built-in search.
    const ed = vscode.window.activeTextEditor;
    const sel = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : '';
    this.post({ type, query: sel && !sel.includes('\n') ? sel : undefined });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString('base64');
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'search.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'search.js'));
    view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link href="${css}" rel="stylesheet"></head><body>
<div class="form">
  <button id="toggle-replace" class="twisty" title="Toggle Replace" aria-label="Toggle Replace"></button>
  <div class="field">
    <input id="q" type="text" placeholder="Search" spellcheck="false" aria-label="Search">
    <div class="toggles">
      <button id="case" class="toggle" title="Match Case (⌥C)">Aa</button>
      <button id="word" class="toggle" title="Match Whole Word (⌥W)"><u>ab</u></button>
      <button id="regex" class="toggle" title="Use Regular Expression (⌥R)">.*</button>
    </div>
  </div>
  <div id="replace-row" hidden>
    <div class="field">
      <input id="r" type="text" placeholder="Replace" spellcheck="false" aria-label="Replace">
      <div class="toggles"><button id="pcase" class="toggle" title="Preserve Case (⌥P)">AB</button></div>
    </div>
    <button id="replace-all" class="action" title="Replace All (⌥⌘Enter)" disabled>${REPLACE_ALL}</button>
  </div>
  <div class="more-row"><button id="more" class="icon" title="Toggle Search Details">⋯</button></div>
  <div id="details" hidden>
    <label>files to include</label>
    <div class="field">
      <input id="include" type="text" placeholder="e.g. *.ts, src/**/include" spellcheck="false">
      <div class="toggles"><button id="openonly" class="toggle" title="Search Only in Open Editors">${BOOK}</button></div>
    </div>
    <label>files to exclude</label>
    <div class="field">
      <input id="exclude" type="text" placeholder="e.g. *.ts, src/**/exclude" spellcheck="false">
      <div class="toggles"><button id="useexclude" class="toggle on" title="Use Exclude Settings and Ignore Files">${GEAR}</button></div>
    </div>
  </div>
</div>
<div id="summary"></div>
<div id="results" tabindex="0"></div>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
    view.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'search') this.run(msg.opts);
      if (msg.type === 'open') this.open(msg.uri, msg.match, msg.preserveFocus);
      if (msg.type === 'replace') this.replace(msg.opts, msg.uri, msg.match).catch(e => vscode.window.showErrorMessage(`Replace failed: ${e?.message ?? e}`));
    });
  }

  private buildRegex(o: Opts): RegExp | undefined {
    let src = o.regex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (o.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    try { return new RegExp(src, 'gu' + (o.caseSensitive ? '' : 'i')); } catch { return undefined; }
  }

  private async run(o: Opts) {
    this.last = o;
    const id = ++this.searchId;
    this.cts?.cancel();
    const cts = this.cts = new vscode.CancellationTokenSource();
    if (!o.query) { this.lastFiles = []; this.post({ type: 'results', id, files: [], total: 0 }); return; }
    const re = this.buildRegex(o);
    if (!re) { this.post({ type: 'error', id, message: 'Invalid regular expression' }); return; }
    this.post({ type: 'searching', id });

    const globs = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean)
      .map(g => (g.includes('/') || g.startsWith('*') ? g : `**/${g}`).replace(/\/$/, '/**'));
    const toPattern = (list: string[]) => list.length === 0 ? undefined : list.length === 1 ? list[0] : `{${list.join(',')}}`;
    // Honor search.exclude like the built-in search (files.exclude is applied by findFiles).
    const cfgEx = o.useExclude ? vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude') ?? {} : {};
    // null disables files.exclude too when "Use Exclude Settings" is off.
    const exclude = toPattern([...Object.keys(cfgEx).filter(k => cfgEx[k] === true), ...globs(o.exclude)]) ?? (o.useExclude ? undefined : null);
    const include = toPattern(globs(o.include).map(g => g.endsWith('/**') || /[*?.]/.test(g.split('/').pop()!) ? g : `${g}/**`)) ?? '**/*';

    let uris = await vscode.workspace.findFiles(include, exclude, undefined, cts.token);
    if (o.openOnly) {
      const openTabs = new Set(vscode.window.tabGroups.all.flatMap(g => g.tabs).map(t => {
        const inp = t.input as { uri?: vscode.Uri } | undefined;
        return inp?.uri?.toString();
      }));
      uris = uris.filter(u => openTabs.has(u.toString()));
    }
    uris.sort((a, b) => a.path.localeCompare(b.path));
    const open = new Map(vscode.workspace.textDocuments.map(d => [d.uri.toString(), d]));
    const files: FileResult[] = [];
    let total = 0;
    for (const uri of uris) {
      if (cts.token.isCancellationRequested || total >= MAX_RESULTS) break;
      let text: string;
      const doc = open.get(uri.toString());
      if (doc) text = doc.getText();
      else {
        try {
          const st = await vscode.workspace.fs.stat(uri);
          if (st.size > MAX_FILE_SIZE) continue;
          const buf = await vscode.workspace.fs.readFile(uri);
          if (buf.subarray(0, 8000).includes(0)) continue; // binary
          text = new TextDecoder().decode(buf);
        } catch { continue; }
      }
      const matches = findInText(text, re, MAX_RESULTS - total);
      if (!matches.length) continue;
      total += matches.length;
      const rel = vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
      const slash = rel.lastIndexOf('/');
      files.push({ uri: uri.toString(), name: rel.slice(slash + 1), dir: slash > 0 ? rel.slice(0, slash) : '', matches });
      // Stream partial results so big workspaces show something quickly.
      if (files.length % 50 === 0) this.post({ type: 'results', id, files, total, partial: true });
    }
    if (id !== this.searchId) return;
    this.lastFiles = files.map(f => f.uri);
    this.post({ type: 'results', id, files, total, limited: total >= MAX_RESULTS });
  }

  /** Replace one match, every match in a file, or every match in the results. */
  private async replace(o: Opts, uriStr?: string, m?: LineMatch) {
    const re = this.buildRegex(o);
    if (!re) return;
    this.last = o;
    const targets = uriStr ? [vscode.Uri.parse(uriStr)] : (this.lastFiles ?? []).map(u => vscode.Uri.parse(u));
    const edit = new vscode.WorkspaceEdit();
    let count = 0;
    for (const uri of targets) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      // Re-match against the current text so edits made since the search are respected.
      for (const mm of findInText(text, re, MAX_RESULTS)) {
        if (m && mm.offset !== m.offset) continue;
        if (m && mm.full !== m.full) break;
        edit.replace(uri, new vscode.Range(doc.positionAt(mm.offset), doc.positionAt(mm.offset + mm.full.length)), replacementFor(mm.full, o, re));
        count++;
      }
    }
    if (!count) { this.run(o); return; }
    if (!uriStr && targets.length > 1) {
      const ok = await vscode.window.showWarningMessage(
        `Replace ${count} occurrence${count > 1 ? 's' : ''} across ${targets.length} files with '${o.replace ?? ''}'?`, { modal: true }, 'Replace');
      if (ok !== 'Replace') return;
    }
    await vscode.workspace.applyEdit(edit);
    // Like the built-in search, save files that weren't open with unsaved changes before.
    await Promise.all(targets.map(async u => {
      const d = vscode.workspace.textDocuments.find(x => x.uri.toString() === u.toString());
      if (d?.isDirty && !this.wasOpen(u)) await d.save();
    }));
    this.run(o);
  }

  private wasOpen(uri: vscode.Uri): boolean {
    return vscode.window.tabGroups.all.some(g => g.tabs.some(t => (t.input as { uri?: vscode.Uri } | undefined)?.uri?.toString() === uri.toString()));
  }

  private async open(uriStr: string, m: LineMatch, preserveFocus: boolean) {
    const uri = vscode.Uri.parse(uriStr);
    const o = this.last;
    if (isMarkdown(uri) && o) {
      // Read the current text (may be unsaved) to locate the match by occurrence.
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      const matched = text.substr(m.offset, m.len);
      // A plain query is searched the same way in the editor's find bar; otherwise use the exact matched text.
      const plain = !o.regex && !o.wholeWord;
      const query = plain ? o.query : matched;
      const cs = plain ? o.caseSensitive : true;
      const hay = cs ? text : text.toLowerCase(), q = cs ? query : query.toLowerCase();
      let occurrence = 0, total = 0;
      for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) {
        if (i < m.offset) occurrence++;
        total++;
      }
      await this.editors.reveal(uri, { query, caseSensitive: cs, occurrence, total, offset: m.offset, length: text.length }, preserveFocus);
      return;
    }
    const pos = new vscode.Position(m.line, m.col);
    await vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos.translate(0, m.len)), preserveFocus, preview: true });
  }
}

/** Same as the built-in "Preserve Case": keep ALL CAPS / Capitalized / lower form of the matched text. */
function preserveCase(orig: string, rep: string): string {
  if (!rep) return rep;
  const hasCase = (c: string) => c.toUpperCase() !== c.toLowerCase();
  if (orig === orig.toUpperCase() && hasCase(orig)) return rep.toUpperCase();
  if (orig === orig.toLowerCase() && hasCase(orig)) return rep.toLowerCase();
  if (hasCase(orig[0]) && orig[0] === orig[0].toUpperCase()) return rep[0].toUpperCase() + rep.slice(1);
  return rep;
}

export function replacementFor(matched: string, o: Opts, re: RegExp): string {
  const raw = o.replace ?? '';
  // In regex mode $1, $&, \n, \t work as in the built-in search; otherwise the text is literal.
  let out = o.regex
    ? matched.replace(new RegExp(re.source, re.flags.replace('g', '')), raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t'))
    : raw;
  if (o.preserveCase) out = preserveCase(matched, out);
  return out;
}

function findInText(text: string, re: RegExp, limit: number): LineMatch[] {
  const out: LineMatch[] = [];
  let lineStart = 0, line = 0;
  re.lastIndex = 0;
  for (let mm = re.exec(text); mm && out.length < limit; mm = re.exec(text)) {
    if (mm[0].length === 0) { re.lastIndex++; continue; }
    const at = mm.index;
    for (let nl = text.indexOf('\n', lineStart); nl !== -1 && nl < at; nl = text.indexOf('\n', lineStart)) { lineStart = nl + 1; line++; }
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const col = at - lineStart;
    const len = Math.min(mm[0].length, lineEnd - at); // multi-line regex matches are shown up to the line end
    const lineText = text.slice(lineStart, lineEnd).replace(/\r$/, '');
    const pre = lineText.slice(0, col);
    out.push({
      line, col, len: mm[0].length, offset: at, full: mm[0],
      before: pre.length > 40 ? '…' + pre.slice(-40).trimStart() : pre.trimStart(),
      text: lineText.slice(col, col + len),
      after: lineText.slice(col + len, col + len + 200),
    });
  }
  return out;
}
