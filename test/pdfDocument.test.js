const assert = require('assert');
const { PDFDocument, PDFName, PDFDict, PDFHexString } = require('pdf-lib');
const { addHighlights, readHighlights } = require('../out/src/highlights');
const { EventEmitter, Uri, loadWithVscode } = require('./vscodeMock');
const files = new Map();
let writes, failWrite, beforeWrite, beforeRead;
const vscode = {
  EventEmitter,
  Uri,
  workspace: {
    fs: {
      readFile: async (uri) => {
        if (beforeRead) await beforeRead();
        if (!files.has(uri.path)) throw new Error('missing file');
        return files.get(uri.path);
      },
      writeFile: async (uri, bytes) => {
        if (failWrite) throw new Error('read-only');
        if (beforeWrite) await beforeWrite();
        files.set(uri.path, bytes);
        writes++;
      },
      createDirectory: async () => {},
      delete: async (uri) => {
        files.delete(uri.path);
      },
    },
  },
};
const { PdfDocument } = loadWithVscode('../out/src/pdfDocument', vscode);
const uri = Uri.file('/source.pdf');
const pages = [
  {
    pageIndex: 0,
    quads: [[40, 720, 140, 720, 40, 700, 140, 700]],
    text: 'Selected',
  },
];
const add = (doc) => doc.addHighlight({ sourceHash: doc.sourceHash, pages });
const count = async (path) => {
  const doc = await PDFDocument.load(files.get(path));
  const annotations = doc.getPage(0).node.Annots();
  return annotations ? annotations.size() : 0;
};

describe('editable PDF document', () => {
  beforeEach(async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([600, 800]).drawText('Selected', { x: 40, y: 700 });
    files.clear();
    files.set(uri.path, await pdf.save());
    writes = 0;
    failWrite = false;
    beforeWrite = undefined;
    beforeRead = undefined;
  });

  it('stages edits without writing, and reports undoable edits for native dirty state', async () => {
    const doc = await PdfDocument.open(uri);
    const events = [];
    doc.onDidEdit((event) => events.push(event));
    add(doc);
    add(doc);
    assert.strictEqual(writes, 0);
    assert.strictEqual(await count(uri.path), 0);
    assert(doc.isDirty);
    assert.strictEqual(events.length, 2);
    events[1].undo();
    assert.strictEqual(doc.getState().highlights.length, 1);
    events[0].undo();
    assert(!doc.isDirty);
    events[0].redo();
    assert(doc.isDirty);
    assert.strictEqual(writes, 0);
  });

  it('saves all edits once without reloading and supports undo across saves', async () => {
    const doc = await PdfDocument.open(uri);
    const events = [];
    const reloads = [];
    doc.onDidEdit((event) => events.push(event));
    doc.onDidChangeContent((reload) => reloads.push(reload));
    const base = doc.sourceHash;
    add(doc);
    add(doc);
    await doc.save();
    assert(!doc.isDirty);
    assert.strictEqual(await count(uri.path), 2);
    await doc.save();
    assert.strictEqual(await count(uri.path), 2);
    assert.strictEqual(doc.sourceHash, base);
    assert(!reloads.includes(true));
    events[1].undo();
    assert(doc.isDirty);
    await doc.save();
    assert.strictEqual(await count(uri.path), 1);
    events[1].redo();
    await doc.save();
    assert.strictEqual(await count(uri.path), 2);
    add(doc);
    await doc.save();
    assert.strictEqual(await count(uri.path), 3);
  });

  it('keeps edits made during a save dirty for the next save', async () => {
    const doc = await PdfDocument.open(uri);
    add(doc);
    let release;
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    beforeWrite = () =>
      new Promise((resolve) => {
        release = resolve;
        entered();
      });
    const saving = doc.save();
    await started;
    add(doc);
    beforeWrite = undefined;
    release();
    await saving;
    assert(doc.isDirty);
    assert.strictEqual(await count(uri.path), 1);
    await doc.save();
    assert(!doc.isDirty);
    assert.strictEqual(await count(uri.path), 2);
  });

  it('keeps pending changes after write failures and cancellation', async () => {
    const doc = await PdfDocument.open(uri);
    add(doc);
    failWrite = true;
    await assert.rejects(doc.save(), /read-only/);
    assert(doc.isDirty);
    failWrite = false;
    await assert.rejects(
      doc.save(uri, { isCancellationRequested: true }),
      /cancelled/
    );
    assert.strictEqual(writes, 0);
    await doc.save();
    assert(!doc.isDirty);
  });

  it('detects external changes without discarding pending edits and permits Save As', async () => {
    const doc = await PdfDocument.open(uri);
    add(doc);
    files.set(uri.path, Buffer.from('external change'));
    await doc.refreshFromDisk();
    assert.strictEqual(doc.getState().highlights.length, 1);
    await assert.rejects(doc.save(), /changed on disk/);
    assert(doc.isDirty);
    const destination = Uri.file('/copy.pdf');
    await doc.save(destination);
    assert.strictEqual(await count(destination.path), 1);
    assert.strictEqual(
      Buffer.from(files.get(uri.path)).toString(),
      'external change'
    );
    assert(doc.isDirty);
  });

  it('ignores its own save watcher events and reverts to the last saved PDF', async () => {
    const doc = await PdfDocument.open(uri);
    const reloads = [];
    doc.onDidChangeContent((reload) => reloads.push(reload));
    add(doc);
    await doc.save();
    await doc.refreshFromDisk();
    assert(!reloads.includes(true));
    add(doc);
    await doc.revert();
    assert(!doc.isDirty);
    assert.strictEqual(doc.getState().highlights.length, 0);
    assert.strictEqual(await count(uri.path), 1);
    assert(reloads.includes(true));
    add(doc);
    await doc.save();
    assert.strictEqual(await count(uri.path), 2);
  });

  it('does not drop an edit that arrives during an external-file check', async () => {
    const doc = await PdfDocument.open(uri);
    let release;
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    files.set(uri.path, Buffer.from('external change'));
    beforeRead = () =>
      new Promise((resolve) => {
        release = resolve;
        entered();
      });
    const refresh = doc.refreshFromDisk();
    await started;
    add(doc);
    beforeRead = undefined;
    release();
    await refresh;
    assert(doc.isDirty);
    assert.strictEqual(doc.getState().highlights.length, 1);
  });

  it('recovers unsaved edits from a backup without modifying the original PDF', async () => {
    const doc = await PdfDocument.open(uri);
    add(doc);
    await doc.save();
    add(doc);
    const backup = await doc.backup(Uri.file('/backup/state.json'));
    assert.strictEqual(await count(uri.path), 1);
    const restored = await PdfDocument.open(uri, backup.id);
    assert(restored.isDirty);
    assert.strictEqual(restored.getState().highlights.length, 2);
    await restored.save();
    assert.strictEqual(await count(uri.path), 2);
    backup.delete();
    await Promise.resolve();
    assert(!files.has('/backup/state.json'));
  });

  it('stages Unicode comments, detects dirty comment-only edits and supports undo across saves', async () => {
    const doc = await PdfDocument.open(uri);
    const events = [],
      changes = [];
    doc.onDidEdit((event) => events.push(event));
    doc.onDidChangeContent((reload) => changes.push(reload));
    add(doc);
    const id = doc.getState().highlights[0].id;
    doc.updateComment(doc.sourceHash, id, '中文批注\nSecond line 📝', '');
    assert.strictEqual(writes, 0);
    await doc.save();
    assert.strictEqual(
      (await readHighlights(files.get(uri.path)))[0].comment,
      '中文批注\nSecond line 📝'
    );
    assert(!doc.isDirty);
    doc.updateComment(
      doc.sourceHash,
      id,
      'Revised',
      '中文批注\nSecond line 📝'
    );
    assert(doc.isDirty);
    events[2].undo();
    assert(!doc.isDirty);
    events[2].redo();
    assert(doc.isDirty);
    await doc.save();
    assert.strictEqual(
      (await readHighlights(files.get(uri.path)))[0].comment,
      'Revised'
    );
    assert.strictEqual(await count(uri.path), 1);
    assert(!changes.includes(true));
  });

  it('edits and clears pre-existing comments without duplicating or changing annotation appearance', async () => {
    files.set(
      uri.path,
      await addHighlights(files.get(uri.path), [
        { ...pages[0], comment: 'Old comment' },
      ])
    );
    const pdf = await PDFDocument.load(files.get(uri.path));
    const annotation = pdf.getPage(0).node.Annots().lookup(0, PDFDict);
    annotation.set(
      PDFName.of('RC'),
      PDFHexString.fromText('<p>Old rich text</p>')
    );
    const originalAppearance = annotation.get(PDFName.of('AP')).toString();
    files.set(uri.path, await pdf.save());
    const doc = await PdfDocument.open(uri);
    const events = [];
    doc.onDidEdit((event) => events.push(event));
    const id = doc.getState().existingHighlights[0].id;
    doc.updateComment(
      doc.sourceHash,
      id,
      '<script>literal text</script> 中文',
      'Old comment'
    );
    assert.strictEqual(doc.getState().highlights.length, 0);
    assert.strictEqual(writes, 0);
    await doc.save();
    let saved = await PDFDocument.load(files.get(uri.path));
    let savedAnnotation = saved.getPage(0).node.Annots().lookup(0, PDFDict);
    assert.strictEqual(
      savedAnnotation.get(PDFName.of('Contents')).decodeText(),
      '<script>literal text</script> 中文'
    );
    assert.strictEqual(
      savedAnnotation.get(PDFName.of('AP')).toString(),
      originalAppearance
    );
    assert.strictEqual(savedAnnotation.get(PDFName.of('RC')), undefined);
    assert.strictEqual(await count(uri.path), 1);
    doc.updateComment(
      doc.sourceHash,
      id,
      '',
      '<script>literal text</script> 中文'
    );
    await doc.save();
    assert.strictEqual(
      (await readHighlights(files.get(uri.path)))[0].comment,
      ''
    );
    events[1].undo();
    await doc.save();
    assert.strictEqual(
      (await readHighlights(files.get(uri.path)))[0].comment,
      '<script>literal text</script> 中文'
    );
    assert.strictEqual(await count(uri.path), 1);
  });

  it('preserves comment grouping for cross-page highlights after reopening', async () => {
    const pdf = await PDFDocument.load(files.get(uri.path));
    pdf.addPage([600, 800]);
    files.set(uri.path, await pdf.save());
    const doc = await PdfDocument.open(uri);
    doc.addHighlight({
      sourceHash: doc.sourceHash,
      pages: [pages[0], { ...pages[0], pageIndex: 1 }],
    });
    doc.updateComment(
      doc.sourceHash,
      doc.getState().highlights[0].id,
      'Across pages',
      ''
    );
    await doc.save();
    const reopened = await PdfDocument.open(uri);
    const existing = reopened.getState().existingHighlights;
    assert.strictEqual(existing.length, 1);
    assert.strictEqual(existing[0].targets.length, 2);
    reopened.updateComment(
      reopened.sourceHash,
      existing[0].id,
      'Updated together',
      'Across pages'
    );
    await reopened.save();
    const saved = await PDFDocument.load(files.get(uri.path));
    for (const page of saved.getPages()) {
      assert.strictEqual(page.node.Annots().size(), 1);
      assert.strictEqual(
        page.node
          .Annots()
          .lookup(0, PDFDict)
          .get(PDFName.of('Contents'))
          .decodeText(),
        'Updated together'
      );
    }
  });

  it('rejects stale and invalid comment edits and recovers comment-only changes from backup', async () => {
    files.set(
      uri.path,
      await addHighlights(files.get(uri.path), [
        { ...pages[0], comment: 'Original' },
      ])
    );
    const doc = await PdfDocument.open(uri);
    const id = doc.getState().existingHighlights[0].id;
    assert.throws(
      () => doc.updateComment('bad hash', id, 'new', 'Original'),
      /outdated/
    );
    assert.throws(
      () => doc.updateComment(doc.sourceHash, 'missing', 'new', 'Original'),
      /no longer exists/
    );
    assert.throws(
      () =>
        doc.updateComment(doc.sourceHash, id, 'x'.repeat(10001), 'Original'),
      /Invalid/
    );
    doc.updateComment(doc.sourceHash, id, 'Pending', 'Original');
    assert.throws(
      () => doc.updateComment(doc.sourceHash, id, 'overwrite', 'Original'),
      /another editor/
    );
    const backup = await doc.backup(Uri.file('/backup/comments.json'));
    assert.strictEqual(
      (await readHighlights(files.get(uri.path)))[0].comment,
      'Original'
    );
    const restored = await PdfDocument.open(uri, backup.id);
    assert(restored.isDirty);
    assert.strictEqual(
      restored.getState().existingHighlights[0].comment,
      'Pending'
    );
    await restored.save();
    assert.strictEqual(
      (await readHighlights(files.get(uri.path)))[0].comment,
      'Pending'
    );
  });
});
