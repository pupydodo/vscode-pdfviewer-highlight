import * as vscode from 'vscode';
import { PdfPreview } from './pdfPreview';
import { PdfDocument } from './pdfDocument';
import { Disposable } from './disposable';

export class PdfCustomProvider extends Disposable
  implements vscode.CustomEditorProvider<PdfDocument> {
  public static readonly viewType = 'pdf.preview';

  private readonly _previews = new Set<PdfPreview>();
  private readonly editEmitter = this._register(
    new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>()
  );
  public readonly onDidChangeCustomDocument = this.editEmitter.event;
  private _activePreview: PdfPreview | undefined;

  constructor(private readonly extensionRoot: vscode.Uri) {
    super();
  }

  public async openCustomDocument(
    uri: vscode.Uri,
    context: vscode.CustomDocumentOpenContext
  ): Promise<PdfDocument> {
    const document = await PdfDocument.open(uri, context.backupId);
    document.onDidEdit((event) => this.editEmitter.fire(event));
    return document;
  }

  public saveCustomDocument(
    document: PdfDocument,
    token: vscode.CancellationToken
  ): Promise<void> {
    return document.save(document.uri, token);
  }

  public saveCustomDocumentAs(
    document: PdfDocument,
    destination: vscode.Uri,
    token: vscode.CancellationToken
  ): Promise<void> {
    return document.save(destination, token);
  }

  public revertCustomDocument(
    document: PdfDocument,
    token: vscode.CancellationToken
  ): Promise<void> {
    return document.revert(token);
  }

  public backupCustomDocument(
    document: PdfDocument,
    context: vscode.CustomDocumentBackupContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    return document.backup(context.destination, token);
  }

  public async resolveCustomEditor(
    document: PdfDocument,
    webviewEditor: vscode.WebviewPanel
  ): Promise<void> {
    const preview = new PdfPreview(this.extensionRoot, document, webviewEditor);
    this._previews.add(preview);
    this.setActivePreview(preview);

    webviewEditor.onDidDispose(() => {
      preview.dispose();
      this._previews.delete(preview);
    });

    webviewEditor.onDidChangeViewState(() => {
      if (webviewEditor.active) {
        this.setActivePreview(preview);
      } else if (this._activePreview === preview && !webviewEditor.active) {
        this.setActivePreview(undefined);
      }
    });
  }

  public get activePreview(): PdfPreview {
    return this._activePreview;
  }

  public highlightSelection(context?: {
    pdfPreviewId?: string;
    pdfSelectionId?: number;
  }): void {
    if (!context || typeof context.pdfSelectionId !== 'number') {
      return;
    }
    for (const preview of this._previews) {
      if (preview.id === context.pdfPreviewId) {
        preview.highlightSelection(context.pdfSelectionId);
        break;
      }
    }
  }

  private setActivePreview(value: PdfPreview | undefined): void {
    this._activePreview = value;
  }
}
