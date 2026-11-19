import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider';
import { SearchViewProvider } from './searchView';

export function activate(context: vscode.ExtensionContext) {
  const editors = new MarkdownEditorProvider(context);
  context.subscriptions.push(
    MarkdownEditorProvider.register(context, editors),
    SearchViewProvider.register(context, editors),
    vscode.commands.registerCommand('markdownEditor.open', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) {
        vscode.commands.executeCommand('vscode.openWith', target, MarkdownEditorProvider.viewType);
      }
    })
  );
}

export function deactivate() {}
