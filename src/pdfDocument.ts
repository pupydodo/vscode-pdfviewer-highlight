import { createHash, randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { Disposable } from './disposable';
import {
  addHighlights,
  HighlightSelection,
  isHighlightSelection,
  PageHighlight,
  AnnotationTarget,
  ExistingHighlight,
  MAX_COMMENT_LENGTH,
  readHighlights,
} from './highlights';

interface HighlightEdit {
  id: string;
  pages: PageHighlight[];
  comment?: string;
  revision?: string;
  targets?: AnnotationTarget[];
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkCancellation(token?: vscode.CancellationToken): void {
  if (token && token.isCancellationRequested) {
    throw new Error('PDF operation cancelled.');
  }
}

/** The base PDF stays unchanged in memory; edits are replayed only when saved. */
export class PdfDocument extends Disposable implements vscode.CustomDocument {
  private edits: HighlightEdit[] = [];
  private savedEdits: HighlightEdit[] = [];
  private diskHash: string;
  private baseHash: string;
  private epoch = 0;
  private writes: Promise<void> = Promise.resolve();
  private readonly editEmitter = this._register(
    new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>()
  );
  public readonly onDidEdit = this.editEmitter.event;
  private readonly contentEmitter = this._register(
    new vscode.EventEmitter<boolean>()
  );
  /** True means the base PDF changed and the views need new PDF bytes. */
  public readonly onDidChangeContent = this.contentEmitter.event;

  private constructor(
    public readonly uri: vscode.Uri,
    private bytes: Uint8Array,
    private existingHighlights: ExistingHighlight[]
  ) {
    super();
    this.diskHash = this.baseHash = hash(bytes);
  }

  public static async open(
    uri: vscode.Uri,
    backupId?: string
  ): Promise<PdfDocument> {
    if (!backupId) {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return new PdfDocument(uri, bytes, await readHighlights(bytes));
    }
    const backup = JSON.parse(
      Buffer.from(
        await vscode.workspace.fs.readFile(vscode.Uri.parse(backupId))
      ).toString('utf8')
    );
    if (
      backup.version !== 1 ||
      typeof backup.base !== 'string' ||
      typeof backup.diskHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(backup.diskHash) ||
      !Array.isArray(backup.edits) ||
      !Array.isArray(backup.savedEdits)
    ) {
      throw new Error('Invalid PDF editor backup.');
    }
    const bytes = Buffer.from(backup.base, 'base64');
    const document = new PdfDocument(uri, bytes, await readHighlights(bytes));
    for (const edit of [...backup.edits, ...backup.savedEdits]) {
      if (
        !edit ||
        typeof edit.id !== 'string' ||
        (edit.comment !== undefined &&
          (typeof edit.comment !== 'string' ||
            edit.comment.length > MAX_COMMENT_LENGTH)) ||
        (edit.revision !== undefined && typeof edit.revision !== 'string') ||
        (edit.targets !== undefined &&
          !document.existingHighlights.some(
            (original) =>
              original.id === edit.id &&
              JSON.stringify(original.targets) === JSON.stringify(edit.targets)
          )) ||
        !isHighlightSelection({
          sourceHash: document.sourceHash,
          pages: edit.pages,
        })
      ) {
        throw new Error('Invalid highlight in PDF editor backup.');
      }
    }
    document.diskHash = backup.diskHash;
    document.edits = backup.edits;
    document.savedEdits = backup.savedEdits;
    return document;
  }

  public get sourceHash(): string {
    return this.baseHash;
  }

  public get isDirty(): boolean {
    return (
      this.edits
        .map((edit) => `${edit.id}:${edit.revision || ''}`)
        .join(',') !==
      this.savedEdits
        .map((edit) => `${edit.id}:${edit.revision || ''}`)
        .join(',')
    );
  }

  public getState(includeBytes = false): object {
    return {
      type: includeBytes ? 'load-document' : 'highlights-changed',
      sourceHash: this.sourceHash,
      highlights: this.edits.filter((edit) => !edit.targets),
      existingHighlights: this.existingHighlights.map(
        (highlight) =>
          this.edits.find((edit) => edit.id === highlight.id) || highlight
      ),
      ...(includeBytes ? { data: Array.from(this.bytes) } : {}),
    };
  }

  public addHighlight(selection: HighlightSelection): void {
    if (
      !isHighlightSelection(selection) ||
      selection.sourceHash !== this.sourceHash
    ) {
      throw new Error('The PDF has changed. Select the text again.');
    }
    const after = [
      ...this.edits,
      {
        id: randomBytes(16).toString('hex'),
        pages: selection.pages,
        comment: '',
      },
    ];
    this.commit(after, 'Highlight');
  }

  public updateComment(
    sourceHash: string,
    id: string,
    comment: string,
    expectedComment: string
  ): void {
    if (
      sourceHash !== this.sourceHash ||
      typeof id !== 'string' ||
      typeof comment !== 'string' ||
      comment.length > MAX_COMMENT_LENGTH ||
      typeof expectedComment !== 'string'
    ) {
      throw new Error(
        'Invalid or outdated highlight comment. Reopen the comment and try again.'
      );
    }
    const current =
      this.edits.find((edit) => edit.id === id) ||
      this.existingHighlights.find((highlight) => highlight.id === id);
    if (!current) throw new Error('The highlight no longer exists.');
    if ((current.comment || '') !== expectedComment)
      throw new Error(
        'This comment changed in another editor. Reopen it before editing.'
      );
    if ((current.comment || '') === comment) return;
    const updated = {
      ...current,
      comment,
      revision: randomBytes(16).toString('hex'),
    };
    const after = this.edits.some((edit) => edit.id === id)
      ? this.edits.map((edit) => (edit.id === id ? updated : edit))
      : [...this.edits, updated];
    this.commit(after, 'Edit highlight comment');
  }

  private commit(after: HighlightEdit[], label: string): void {
    const before = this.edits;
    const epoch = this.epoch;
    const apply = (edits: HighlightEdit[]): void => {
      if (epoch !== this.epoch)
        throw new Error(
          'The PDF was reloaded. This edit is no longer available.'
        );
      this.edits = edits;
      this.contentEmitter.fire(false);
    };
    apply(after);
    this.editEmitter.fire({
      document: this,
      label,
      undo: () => apply(before),
      redo: () => apply(after),
    });
  }

  private serialize(edits: HighlightEdit[]): Promise<Uint8Array> {
    const pages = ([] as PageHighlight[]).concat(
      ...edits
        .filter((edit) => !edit.targets)
        .map((edit) =>
          edit.pages.map((page) => ({
            ...page,
            comment: edit.comment || '',
            highlightId: edit.id,
          }))
        )
    );
    const comments = edits
      .filter((edit) => !!edit.targets)
      .map((edit) => ({ targets: edit.targets, comment: edit.comment || '' }));
    return pages.length || comments.length
      ? addHighlights(this.bytes, pages, comments)
      : Promise.resolve(this.bytes);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writes.then(operation);
    this.writes = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  public save(
    destination = this.uri,
    token?: vscode.CancellationToken
  ): Promise<void> {
    const snapshot = this.edits;
    const epoch = this.epoch;
    return this.enqueue(async () => {
      checkCancellation(token);
      if (epoch !== this.epoch)
        throw new Error('The PDF was reloaded before it could be saved.');
      const sameFile = destination.toString() === this.uri.toString();
      if (
        sameFile &&
        hash(await vscode.workspace.fs.readFile(this.uri)) !== this.diskHash
      ) {
        throw new Error(
          'The PDF changed on disk. Use Save As to keep your highlights, or revert the file.'
        );
      }
      const bytes = await this.serialize(snapshot);
      checkCancellation(token);
      if (
        sameFile &&
        hash(await vscode.workspace.fs.readFile(this.uri)) !== this.diskHash
      ) {
        throw new Error(
          'The PDF changed while saving. Your unsaved highlights have been kept.'
        );
      }
      checkCancellation(token);
      await vscode.workspace.fs.writeFile(destination, bytes);
      if (sameFile) {
        this.diskHash = hash(bytes);
        this.savedEdits = snapshot;
      }
      // Keep the original base and the overlays, including saved edits. This
      // avoids a reload and lets undo work across a save without duplicates.
    });
  }

  public revert(token?: vscode.CancellationToken): Promise<void> {
    return this.enqueue(async () => {
      const bytes = await vscode.workspace.fs.readFile(this.uri);
      checkCancellation(token);
      if (!this.isDirty && hash(bytes) === this.diskHash) return;
      await this.reset(bytes);
    });
  }

  public refreshFromDisk(): Promise<void> {
    return this.enqueue(async () => {
      if (this.isDisposed || this.isDirty) return;
      const bytes = await vscode.workspace.fs.readFile(this.uri);
      if (!this.isDirty && hash(bytes) !== this.diskHash)
        await this.reset(bytes, true);
    });
  }

  private async reset(bytes: Uint8Array, onlyIfClean = false): Promise<void> {
    const highlights = await readHighlights(bytes);
    if (onlyIfClean && this.isDirty) return;
    this.bytes = bytes;
    this.existingHighlights = highlights;
    this.diskHash = this.baseHash = hash(bytes);
    this.edits = this.savedEdits = [];
    this.epoch++;
    this.contentEmitter.fire(true);
  }

  public async backup(
    destination: vscode.Uri,
    token?: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    // Wait for any in-flight save so the backup's disk hash matches that save.
    await this.writes;
    checkCancellation(token);
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        base: Buffer.from(this.bytes).toString('base64'),
        diskHash: this.diskHash,
        edits: this.edits,
        savedEdits: this.savedEdits,
      }),
      'utf8'
    );
    await vscode.workspace.fs.createDirectory(
      destination.with({ path: path.posix.dirname(destination.path) })
    );
    checkCancellation(token);
    await vscode.workspace.fs.writeFile(destination, bytes);
    return {
      id: destination.toString(),
      delete: (): void => {
        vscode.workspace.fs.delete(destination).then(
          () => {},
          () => {}
        );
      },
    };
  }
}
