import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

const svg = (d: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS: Record<string, string> = {
  undo: svg('<path d="M4 6h6a3 3 0 0 1 0 6H7"/><path d="M6.5 3.5 4 6l2.5 2.5"/>'),
  redo: svg('<path d="M12 6H6a3 3 0 0 0 0 6h3"/><path d="M9.5 3.5 12 6 9.5 8.5"/>'),
  bold: svg('<path d="M5 3h4a2.5 2.5 0 0 1 0 5H5zM5 8h4.5a2.5 2.5 0 0 1 0 5H5z" stroke-width="1.8"/>'),
  italic: svg('<path d="M10 3H7M9 13H6M9.5 3l-3 10"/>'),
  strike: svg('<path d="M3 8h10M10.5 5.5C10.2 4 9.2 3.3 8 3.3c-1.5 0-2.6.8-2.6 2 0 .9.5 1.5 1.6 1.9M5.5 10.5c.3 1.4 1.3 2.2 2.6 2.2 1.6 0 2.7-.9 2.7-2.1 0-.5-.1-.9-.4-1.2"/>'),
  code: svg('<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'),
  link: svg('<path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.7.7M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.7-.7"/>'),
  bullet: svg('<circle cx="3" cy="4.5" r=".8" fill="currentColor"/><circle cx="3" cy="8" r=".8" fill="currentColor"/><circle cx="3" cy="11.5" r=".8" fill="currentColor"/><path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5"/>'),
  ordered: svg('<path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5"/><text x="1.2" y="6" font-size="4.5" fill="currentColor" stroke="none">1</text><text x="1.2" y="13" font-size="4.5" fill="currentColor" stroke="none">2</text>'),
  task: svg('<rect x="2" y="2.5" width="5" height="5" rx="1"/><path d="m3.2 5 1 1 1.8-2M9 5h5M2.5 10.5h4v3h-4zM9 12h5"/>'),
  quote: svg('<path d="M3 3v10M6.5 5h7M6.5 8h7M6.5 11h5"/>'),
  codeblock: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="m5.5 6.5-1.5 1.5 1.5 1.5M10.5 6.5 12 8l-1.5 1.5"/>'),
  table: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 6.5h13M1.5 10h13M6 6.5v7M10.5 6.5v7"/>'),
  image: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6" r="1.2"/><path d="m2 12 4-4 3 3 2-2 3.5 3.5"/>'),
  hr: svg('<path d="M2 8h12"/>'),
};

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'markdownEditor.editor';

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      new MarkdownEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true } }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const docDir = document.uri.scheme === 'untitled' ? undefined : vscode.Uri.joinPath(document.uri, '..');
    const roots = [mediaUri];
    if (docDir) roots.push(docDir);
    vscode.workspace.workspaceFolders?.forEach(f => roots.push(f.uri));
    panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    panel.webview.html = this.getHtml(panel.webview, mediaUri);

    let applyingEdit = false;
    const changeSub = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() !== document.uri.toString() || applyingEdit) return;
      panel.webview.postMessage({ type: 'update', text: document.getText() });
    });

    // Watch the file on disk too, so changes made by other programs show up immediately.
    const disposables: vscode.Disposable[] = [changeSub];
    if (document.uri.scheme === 'file' && docDir) {
      const name = document.uri.path.split('/').pop()!;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(docDir, name));
      const reload = async () => {
        if (document.isDirty) return; // don't clobber unsaved edits
        const disk = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri));
        if (disk === document.getText()) return;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), disk);
        await vscode.workspace.applyEdit(edit); // fires onDidChangeTextDocument -> webview update
        await document.save();
      };
      watcher.onDidChange(() => reload().catch(() => undefined));
      disposables.push(watcher);
    }
    panel.onDidDispose(() => disposables.forEach(d => d.dispose()));

    panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'ready') {
        panel.webview.postMessage({
          type: 'init',
          text: document.getText(),
          baseUri: docDir ? panel.webview.asWebviewUri(docDir).toString() : '',
        });
      }
      if (msg.type === 'edit' && msg.text !== document.getText()) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), msg.text);
        applyingEdit = true;
        try { await vscode.workspace.applyEdit(edit); } finally { applyingEdit = false; }
      }
    });
  }

  private getHtml(webview: vscode.Webview, media: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dist', 'editor.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'editor.css'));
    const nonce = randomBytes(16).toString('base64');
    const btn = (cmd: string, title: string, icon: string) =>
      `<button data-cmd="${cmd}" title="${title}" aria-label="${title}">${ICONS[icon] ?? icon}</button>`;
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet"></head>
<body>
  <div id="tablebar" hidden>
    <span class="label">Table</span>
    <button data-cmd="addRowAfter">+ Row</button>
    <button data-cmd="addColAfter">+ Column</button>
    <button data-cmd="delRow">− Row</button>
    <button data-cmd="delCol">− Column</button>
    <button data-cmd="delTable" class="danger">Delete table</button>
  </div>
  <div id="prompt" hidden><label></label><input type="text" placeholder="Enter to apply · Esc to cancel"></div>
  <div class="main"><div id="wysiwyg" class="markdown-body"></div></div>
  <div id="bubble" class="floating">
    ${btn('bold', 'Bold', 'bold')}${btn('italic', 'Italic', 'italic')}${btn('strike', 'Strikethrough', 'strike')}${btn('code', 'Inline code', 'code')}${btn('link', 'Link', 'link')}
  </div>
  <div id="slash" class="floating" hidden></div>
  <script nonce="${nonce}" src="${script}"></script>
</body></html>`;
  }
}
