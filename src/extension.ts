import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    MarkdownEditorProvider.register(context),
    vscode.commands.registerCommand('markdownEditor.open', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) {
        vscode.commands.executeCommand('vscode.openWith', target, MarkdownEditorProvider.viewType);
      }
    })
  );
}

export function deactivate() {}
