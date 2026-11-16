import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

/** Chromium-based browsers that can print to PDF headlessly, by platform. */
function browserCandidates(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ];
    case 'win32': {
      const dirs = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean) as string[];
      return dirs.flatMap(d => [
        path.join(d, 'Google/Chrome/Application/chrome.exe'),
        path.join(d, 'Microsoft/Edge/Application/msedge.exe'),
      ]);
    }
    default:
      return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
  }
}

export function findBrowser(): string | undefined {
  const configured = vscode.workspace.getConfiguration('markdownEditor').get<string>('pdf.browserPath');
  if (configured) return fs.existsSync(configured) ? configured : undefined;
  return browserCandidates().find(p => fs.existsSync(p));
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Wraps editor HTML in a standalone, print-friendly light-theme page. */
export function buildPrintHtml(body: string, title: string, editorCss: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<style>
:root {
  --vscode-editor-foreground: #1f2328; --vscode-editor-background: #ffffff;
  --vscode-foreground: #1f2328; --vscode-descriptionForeground: #59636e;
  --vscode-editorWidget-border: #d1d9e0; --vscode-panel-border: #d1d9e0;
  --vscode-textLink-foreground: #0969da; --vscode-textCodeBlock-background: #f6f8fa;
  --vscode-textPreformat-foreground: #c7254e; --vscode-textBlockQuote-border: #d1d9e0;
  --vscode-editor-font-family: "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --vscode-editor-font-size: 10pt;
}
</style>
<style>${editorCss}</style>
<style>
@page { size: A4; margin: 18mm 16mm; }
html, body { height: auto !important; display: block !important; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.markdown-body { font-size: 10.5pt; }
.markdown-body .code-block pre { font-size: 9pt; white-space: pre-wrap; word-break: break-word; }
.markdown-body pre, .markdown-body blockquote, .markdown-body img, .markdown-body tr, .code-block { break-inside: avoid; }
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 { break-after: avoid; }
.markdown-body table { width: auto; max-width: 100%; }
.markdown-body .tableWrapper { overflow: visible; }
</style></head>
<body class="vscode-light"><div class="markdown-body">${body}</div></body></html>`;
}

export function printToPdf(browser: string, htmlFile: string, pdfFile: string): Promise<void> {
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--no-pdf-header-footer', '--print-to-pdf-no-header',
    `--user-data-dir=${path.join(os.tmpdir(), 'markdown-editor-pdf-profile')}`,
    `--print-to-pdf=${pdfFile}`, vscode.Uri.file(htmlFile).toString(),
  ];
  return new Promise((resolve, reject) => {
    execFile(browser, args, { timeout: 60_000 }, err => {
      if (err && !fs.existsSync(pdfFile)) reject(err); else resolve();
    });
  });
}
