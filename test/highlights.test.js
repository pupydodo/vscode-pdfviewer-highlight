const assert = require('assert');
const {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFHexString,
} = require('pdf-lib');
const {
  addHighlights,
  isHighlightSelection,
} = require('../out/src/highlights');

const quad = [40, 720, 140, 720, 40, 700, 140, 700];
const selection = {
  sourceHash: 'a'.repeat(64),
  pages: [{ pageIndex: 0, quads: [quad], text: 'Selected text 中文' }],
};

async function makePdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  page.drawText('Selected text', { x: 40, y: 700, size: 20 });
  const link = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [40, 600, 140, 620],
    A: {
      Type: 'Action',
      S: 'URI',
      URI: PDFHexString.fromText('https://example.com'),
    },
  });
  page.node.addAnnot(doc.context.register(link));
  doc.addPage([600, 800]);
  return doc.save();
}

describe('PDF highlight annotations', () => {
  it('rejects empty, malformed and non-finite selection messages', () => {
    assert(isHighlightSelection(selection));
    for (const value of [
      null,
      {},
      { ...selection, pages: [] },
      { ...selection, sourceHash: '../file.pdf' },
      {
        ...selection,
        pages: [{ ...selection.pages[0], quads: [[NaN, ...quad.slice(1)]] }],
      },
      { ...selection, pages: [{ ...selection.pages[0], pageIndex: -1 }] },
    ]) {
      assert.strictEqual(isHighlightSelection(value), false);
    }
  });

  it('preserves text and existing links, and persists printable highlights on multiple pages', async () => {
    const original = await makePdf();
    const output = await addHighlights(original, [
      selection.pages[0],
      {
        pageIndex: 1,
        quads: [quad, quad.map((n, i) => (i % 2 ? n - 40 : n))],
        text: 'Two lines',
      },
    ]);
    const doc = await PDFDocument.load(output);
    assert.strictEqual(doc.getPageCount(), 2);
    const annotations = doc.getPage(0).node.Annots();
    assert.strictEqual(annotations.size(), 2);
    assert.strictEqual(
      annotations.lookup(0, PDFDict).get(PDFName.of('Subtype')).toString(),
      '/Link'
    );
    const highlight = annotations.lookup(1, PDFDict);
    assert.strictEqual(
      highlight.get(PDFName.of('Subtype')).toString(),
      '/Highlight'
    );
    assert.deepStrictEqual(
      highlight
        .lookup(PDFName.of('QuadPoints'), PDFArray)
        .asArray()
        .map((n) => n.asNumber()),
      quad
    );
    assert.strictEqual(
      highlight.get(PDFName.of('Contents')).decodeText(),
      selection.pages[0].text
    );
    assert.strictEqual(highlight.get(PDFName.of('F')).asNumber(), 4);
    assert(highlight.get(PDFName.of('AP')));

    const originalDoc = await PDFDocument.load(original);
    const originalContents = originalDoc
      .getPage(0)
      .node.Contents()
      .lookup(0)
      .getContents();
    const savedContents = doc.getPage(0).node.Contents();
    assert(
      savedContents
        .asArray()
        .some((_, index) =>
          Buffer.from(savedContents.lookup(index).getContents()).equals(
            Buffer.from(originalContents)
          )
        )
    );
    assert.strictEqual(
      doc
        .getPage(1)
        .node.Annots()
        .lookup(0, PDFDict)
        .lookup(PDFName.of('QuadPoints'), PDFArray)
        .size(),
      16
    );
  });

  it('appends subsequent highlights without replacing previous annotations', async () => {
    const once = await addHighlights(await makePdf(), selection.pages);
    const twice = await addHighlights(once, selection.pages);
    assert.strictEqual(
      (await PDFDocument.load(twice)).getPage(0).node.Annots().size(),
      3
    );
  });

  it('clips rectangles to the crop box and rejects stale page numbers', async () => {
    const bytes = await makePdf();
    const result = await addHighlights(bytes, [
      {
        pageIndex: 0,
        quads: [[-10, 810, 30, 810, -10, 780, 30, 780]],
        text: 'edge',
      },
    ]);
    const doc = await PDFDocument.load(result);
    const rect = doc
      .getPage(0)
      .node.Annots()
      .lookup(1, PDFDict)
      .lookup(PDFName.of('Rect'), PDFArray);
    assert.deepStrictEqual(
      rect.asArray().map((n) => n.asNumber()),
      [0, 780, 30, 800]
    );
    await assert.rejects(
      addHighlights(bytes, [{ ...selection.pages[0], pageIndex: 99 }]),
      /no longer exists/
    );
    await assert.rejects(
      addHighlights(bytes, [
        {
          ...selection.pages[0],
          quads: [[-20, -10, -10, -10, -20, -20, -10, -20]],
        },
      ]),
      /outside/
    );
    await assert.rejects(
      addHighlights(Buffer.from('not a PDF'), selection.pages)
    );
  });
});
