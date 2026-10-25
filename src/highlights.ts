import { randomBytes } from 'crypto';
import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from 'pdf-lib';

export interface PageHighlight {
  pageIndex: number;
  quads: number[][];
  text: string;
  comment?: string;
  highlightId?: string;
}

export interface AnnotationTarget {
  pageIndex: number;
  annotationIndex: number;
}
export interface ExistingHighlight {
  id: string;
  pages: PageHighlight[];
  comment: string;
  targets: AnnotationTarget[];
}
export interface CommentUpdate {
  targets: AnnotationTarget[];
  comment: string;
}
export const MAX_COMMENT_LENGTH = 10000;

function textValue(dict: PDFDict, key: string): string {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : '';
}

function numbers(dict: PDFDict, key: string): number[] {
  const array = dict.lookup(PDFName.of(key));
  if (!(array instanceof PDFArray)) return [];
  return array
    .asArray()
    .map((_, i) => array.lookup(i))
    .map((value) => (value instanceof PDFNumber ? value.asNumber() : NaN));
}

/** Locate existing annotations in the immutable base PDF, including third-party highlights. */
export async function readHighlights(
  bytes: Uint8Array
): Promise<ExistingHighlight[]> {
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (error instanceof EncryptedPDFError) return [];
    throw error;
  }
  const highlights: ExistingHighlight[] = [];
  const groups = new Map<string, ExistingHighlight>();
  document.getPages().forEach((page, pageIndex) => {
    const annotations = page.node.Annots();
    if (!annotations) return;
    for (
      let annotationIndex = 0;
      annotationIndex < annotations.size();
      annotationIndex++
    ) {
      const annotation = annotations.lookup(annotationIndex);
      if (
        !(annotation instanceof PDFDict) ||
        annotation.get(PDFName.of('Subtype')) !== PDFName.of('Highlight')
      )
        continue;
      const values = numbers(annotation, 'QuadPoints');
      const quads: number[][] = [];
      if (values.length % 8 === 0 && values.every(Number.isFinite)) {
        for (let i = 0; i < values.length; i += 8)
          quads.push(values.slice(i, i + 8));
      }
      if (!quads.length) {
        const rect = numbers(annotation, 'Rect');
        if (rect.length !== 4 || !rect.every(Number.isFinite)) continue;
        quads.push([
          rect[0],
          rect[3],
          rect[2],
          rect[3],
          rect[0],
          rect[1],
          rect[2],
          rect[1],
        ]);
      }
      const comment = textValue(annotation, 'Contents');
      const group = textValue(annotation, 'PdfPreviewHighlightId');
      const key = group ? JSON.stringify([group, comment]) : '';
      let highlight = key ? groups.get(key) : undefined;
      if (!highlight) {
        highlight = {
          id: `existing:${pageIndex}:${annotationIndex}`,
          pages: [],
          targets: [],
          comment,
        };
        highlights.push(highlight);
        if (key) groups.set(key, highlight);
      }
      highlight.pages.push({
        pageIndex,
        quads,
        text: textValue(annotation, 'PdfPreviewText'),
      });
      highlight.targets.push({ pageIndex, annotationIndex });
    }
  });
  return highlights;
}

export interface HighlightSelection {
  sourceHash: string;
  pages: PageHighlight[];
}

export function isHighlightSelection(
  value: unknown
): value is HighlightSelection {
  const selection = value as HighlightSelection;
  return !!(
    selection &&
    typeof selection.sourceHash === 'string' &&
    /^[a-f0-9]{64}$/.test(selection.sourceHash) &&
    Array.isArray(selection.pages) &&
    selection.pages.length > 0 &&
    selection.pages.length <= 1000 &&
    selection.pages.every(
      (page) =>
        page &&
        Number.isInteger(page.pageIndex) &&
        page.pageIndex >= 0 &&
        typeof page.text === 'string' &&
        page.text.length <= 1000000 &&
        Array.isArray(page.quads) &&
        page.quads.length > 0 &&
        page.quads.length <= 10000 &&
        page.quads.every(
          (quad) =>
            Array.isArray(quad) &&
            quad.length === 8 &&
            quad.every((n) => typeof n === 'number' && Number.isFinite(n))
        )
    )
  );
}

/** Add real, printable PDF annotations, preserving existing page contents. */
export async function addHighlights(
  bytes: Uint8Array,
  pages: PageHighlight[],
  comments: CommentUpdate[] = []
): Promise<Uint8Array> {
  // Do not ignore encryption: saving an encrypted file would remove protection.
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const context = document.context;
  for (const update of comments) {
    for (const target of update.targets) {
      const page = document.getPages()[target.pageIndex];
      const annotations = page && page.node.Annots();
      const annotation =
        annotations && annotations.lookup(target.annotationIndex);
      if (
        !(annotation instanceof PDFDict) ||
        annotation.get(PDFName.of('Subtype')) !== PDFName.of('Highlight')
      ) {
        throw new Error('The highlight no longer exists. Reopen the PDF.');
      }
      annotation.set(
        PDFName.of('Contents'),
        PDFHexString.fromText(update.comment)
      );
      annotation.set(PDFName.of('M'), PDFString.fromDate(new Date()));
      // Rich-text content otherwise takes precedence over the edited plain text.
      annotation.delete(PDFName.of('RC'));
    }
  }
  for (const highlight of pages) {
    if (highlight.pageIndex >= document.getPageCount()) {
      throw new Error('The selected page no longer exists. Reopen the PDF.');
    }
    const page = document.getPage(highlight.pageIndex);
    const box = page.getCropBox();
    const quads = highlight.quads.map((quad) => {
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const left = Math.max(box.x, Math.min(...xs));
      const right = Math.min(box.x + box.width, Math.max(...xs));
      const bottom = Math.max(box.y, Math.min(...ys));
      const top = Math.min(box.y + box.height, Math.max(...ys));
      if (left >= right || bottom >= top) {
        throw new Error('The selected text is outside the PDF page.');
      }
      // PDF text markup uses top-left, top-right, bottom-left, bottom-right.
      return [left, top, right, top, left, bottom, right, bottom];
    });
    const rect = [
      Math.min(...quads.map((q) => q[0])),
      Math.min(...quads.map((q) => q[5])),
      Math.max(...quads.map((q) => q[2])),
      Math.max(...quads.map((q) => q[1])),
    ];
    const appearance = context.flateStream(
      [
        'q /GS0 gs 1 1 0 rg',
        ...quads.map(
          (q) =>
            `${q[0]} ${q[1]} m ${q[2]} ${q[3]} l ` +
            `${q[6]} ${q[7]} l ${q[4]} ${q[5]} l h`
        ),
        'f Q',
      ].join('\n'),
      {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: rect,
        Resources: {
          ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', ca: 0.4 } },
        },
      }
    );
    const annotation = context.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      P: page.ref,
      Rect: rect,
      QuadPoints: ([] as number[]).concat(...quads),
      C: [1, 1, 0],
      CA: 0.4,
      F: 4, // Print the annotation as well as displaying it.
      Contents: PDFHexString.fromText(
        highlight.comment === undefined ? highlight.text : highlight.comment
      ),
      PdfPreviewText: PDFHexString.fromText(highlight.text),
      PdfPreviewHighlightId: PDFString.of(
        highlight.highlightId || randomBytes(16).toString('hex')
      ),
      M: PDFString.fromDate(new Date()),
      NM: PDFString.of(randomBytes(16).toString('hex')),
      AP: { N: context.register(appearance) },
    });
    page.node.addAnnot(context.register(annotation));
  }
  return document.save({ updateFieldAppearances: false });
}
