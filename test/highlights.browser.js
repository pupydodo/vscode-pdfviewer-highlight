const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter, Uri, loadWithVscode } = require('./vscodeMock');
const { chromium } = require('playwright-core');
const { PDFDocument } = require('pdf-lib');
const { readHighlights } = require('../out/src/highlights');

describe('PDF viewer selection and save flow in Chromium', function () {
  let browser, page, provider, pdfBytes, receiver, html, customDocument;
  let writes = 0;
  const edits = [];
  const redoEdits = [];
  const watchers = [];
  const errors = [];
  const root = path.resolve(__dirname, '..');
  const pdfPath = '/tmp/pdf-highlight-browser-fixture.pdf';
  const disposable = () => ({ dispose() {} });
  const resource = Uri.file(pdfPath);
  const vscode = {
    Uri,
    EventEmitter,
    commands: {
      async executeCommand(command) {
        if (command === 'workbench.action.files.save')
          return provider.saveCustomDocument(customDocument);
        if (command === 'undo') {
          const edit = edits.pop();
          if (edit) {
            edit.undo();
            redoEdits.push(edit);
          }
        }
        if (command === 'redo') {
          const edit = redoEdits.pop();
          if (edit) {
            edit.redo();
            edits.push(edit);
          }
        }
      },
    },
    window: {
      showErrorMessage(message) {
        errors.push(message);
      },
    },
    workspace: {
      fs: {
        readFile: async () => pdfBytes,
        writeFile: async (_, bytes) => {
          pdfBytes = bytes;
          writes++;
          setTimeout(
            () => watchers.forEach((callback) => callback(resource)),
            0
          );
        },
      },
      createFileSystemWatcher: () => ({
        dispose() {},
        onDidChange: (callback) => {
          watchers.push(callback);
          return disposable();
        },
        onDidDelete: disposable,
      }),
      getConfiguration: () => ({
        get: (key) =>
          ({
            'default.cursor': 'select',
            'default.scale': '1.0',
            'default.sidebar': false,
            'default.scrollMode': 'vertical',
            'default.spreadMode': 'none',
          }[key]),
      }),
    },
  };

  before(async () => {
    const document = await PDFDocument.create();
    for (let i = 0; i < 2; i++) {
      const pdfPage = document.addPage([600, 800]);
      pdfPage.setCropBox(20, 30, 560, 740);
      pdfPage.drawText(`First line page ${i + 1}`, { x: 50, y: 720, size: 20 });
      pdfPage.drawText(`Second line page ${i + 1}`, {
        x: 50,
        y: 680,
        size: 20,
      });
    }
    pdfBytes = await document.save();
    const { PdfCustomProvider } = loadWithVscode(
      '../out/src/pdfProvider',
      vscode
    );
    provider = new PdfCustomProvider(Uri.file(root));
    provider.onDidChangeCustomDocument((event) => {
      edits.push(event);
      redoEdits.length = 0;
    });
    customDocument = await provider.openCustomDocument(resource, {});
    await provider.resolveCustomEditor(customDocument, {
      active: true,
      onDidChangeViewState: disposable,
      onDidDispose: disposable,
      webview: {
        cspSource: 'http://pdf.test',
        asWebviewUri: (uri) => `http://pdf.test${uri.path}`,
        onDidReceiveMessage: (callback) => {
          receiver = callback;
          return disposable();
        },
        set html(value) {
          html = value;
        },
        postMessage: (message) =>
          page.evaluate(
            (message) =>
              window.dispatchEvent(
                new MessageEvent('message', { data: message })
              ),
            message
          ),
      },
    });
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--unsafely-treat-insecure-origin-as-secure=http://pdf.test',
      ],
    });
    page = await browser.newPage({ viewport: { width: 1400, height: 1800 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.exposeFunction('postToHost', (message) => receiver(message));
    await page.addInitScript(() => {
      window.acquireVsCodeApi = () => ({
        postMessage: (message) => window.postToHost(message),
      });
    });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const pathname = decodeURIComponent(url.pathname);
      if (url.origin !== 'http://pdf.test') return route.abort();
      if (pathname === '/viewer')
        return route.fulfill({ contentType: 'text/html', body: html });
      if (pathname === pdfPath)
        return route.fulfill({
          contentType: 'application/pdf',
          body: Buffer.from(pdfBytes),
        });
      if (!pathname.startsWith(root + '/lib/')) return route.abort();
      const contentType =
        {
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
        }[path.extname(pathname)] || 'application/octet-stream';
      try {
        await route.fulfill({ contentType, body: fs.readFileSync(pathname) });
      } catch {
        await route.fulfill({ status: 404, body: '' });
      }
    });
    await page.goto('http://pdf.test/viewer');
    await page.waitForFunction(() => {
      const app = window.PDFViewerApplication;
      return (
        app &&
        app.pdfDocument &&
        document.querySelectorAll('#viewer .textLayer span').length >= 4
      );
    });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  async function selectText({ crossPage = false, partial = false } = {}) {
    return page.evaluate(
      ({ crossPage, partial }) => {
        const spans = Array.from(
          document.querySelectorAll('#viewer .textLayer span')
        ).filter((span) => span.textContent.trim());
        const first = spans.find(
          (span) => span.textContent === 'First line page 1'
        );
        const last = spans.find(
          (span) =>
            span.textContent ===
            (crossPage ? 'Second line page 2' : 'Second line page 1')
        );
        const range = document.createRange();
        range.setStart(first.firstChild, partial ? 6 : 0);
        range.setEnd(
          partial ? first.firstChild : last.firstChild,
          partial ? 10 : last.textContent.length
        );
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return PdfHighlights.collectSelection(
          selection,
          PDFViewerApplication.pdfViewer
        );
      },
      { crossPage, partial }
    );
  }

  it('captures exact partial text, multiline and cross-page selections', async () => {
    const partial = await selectText({ partial: true });
    assert.strictEqual(partial[0].text, 'line');
    assert.strictEqual(partial[0].quads.length, 1);
    const lines = await selectText();
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].quads.length, 2);
    assert(partial[0].quads[0][0] > lines[0].quads[0][0]);
    const across = await selectText({ crossPage: true });
    assert.deepStrictEqual(
      across.map((p) => p.pageIndex),
      [0, 1]
    );
    assert(across.every((p) => p.quads.length === 2));
  });

  it('keeps PDF coordinates stable at different zoom levels and page rotations', async () => {
    function bounds(quad) {
      const xs = quad.filter((_, i) => !(i % 2));
      const ys = quad.filter((_, i) => i % 2);
      return [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
      ];
    }
    const expected = bounds((await selectText({ partial: true }))[0].quads[0]);
    for (const rotation of [90, 180, 270, 0]) {
      await page.evaluate((rotation) => {
        const viewer = PDFViewerApplication.pdfViewer;
        viewer.pagesRotation = rotation;
        viewer.currentScale = rotation === 0 ? 1 : 1.5;
        viewer.currentPageNumber = 1;
      }, rotation);
      await page.waitForFunction((rotation) => {
        const view = PDFViewerApplication.pdfViewer.getPageView(0);
        return (
          view.viewport.rotation === rotation &&
          view.textLayer &&
          view.textLayer.renderingDone
        );
      }, rotation);
      const actual = bounds((await selectText({ partial: true }))[0].quads[0]);
      actual.forEach((value, i) =>
        assert(
          Math.abs(value - expected[i]) < 1,
          `${rotation}° coordinate ${i}: ${value} != ${expected[i]}`
        )
      );
    }
  });

  it('hides highlight for empty selection and toolbar context menus', async () => {
    const context = await page.evaluate(() => {
      window.getSelection().removeAllRanges();
      document
        .querySelector('#viewer .page')
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      return JSON.parse(
        document.getElementById('viewerContainer').dataset.vscodeContext
      );
    });
    assert.strictEqual(context.pdfHasSelection, false);
    await selectText();
    const toolbarContext = await page.evaluate(() => {
      document
        .getElementById('findInput')
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      return JSON.parse(
        document.getElementById('viewerContainer').dataset.vscodeContext
      );
    });
    assert.strictEqual(toolbarContext.pdfHasSelection, false);
  });

  async function highlightSelection() {
    const context = await page.evaluate(() => {
      const span = window.getSelection().anchorNode.parentElement;
      span.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      const context = JSON.parse(
        document.getElementById('viewerContainer').dataset.vscodeContext
      );
      window.getSelection().removeAllRanges();
      return context;
    });
    provider.highlightSelection(context);
  }

  async function waitForHost(predicate) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error('Timed out waiting for host state');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function saveWithKeyboard() {
    await page.keyboard.press('Control+s');
    await waitForHost(() => !customDocument.isDirty);
  }

  async function annotationCount() {
    const document = await PDFDocument.load(pdfBytes);
    return document
      .getPages()
      .reduce(
        (sum, p) => sum + (p.node.Annots() ? p.node.Annots().size() : 0),
        0
      );
  }

  it('shows consecutive highlights without disk writes, page reloads or losing the native menu selection', async () => {
    const original = Buffer.from(pdfBytes);
    await page.evaluate(() => {
      window.originalPdf = PDFViewerApplication.pdfDocument;
      window.originalCanvas = PDFViewerApplication.pdfViewer.getPageView(
        0
      ).canvas;
      window.pdfLoads = 0;
      PDFViewerApplication.eventBus.on('documentinit', () => window.pdfLoads++);
    });
    await selectText();
    await highlightSelection();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.pdf-highlight-overlay polygon').length === 2
    );
    assert(customDocument.isDirty);
    assert.strictEqual(edits.length, 1);
    await selectText({ partial: true });
    await highlightSelection();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.pdf-highlight-overlay polygon').length === 3
    );
    assert.strictEqual(writes, 0);
    assert.deepStrictEqual(Buffer.from(pdfBytes), original);
    assert(
      await page.evaluate(
        () =>
          window.originalPdf === PDFViewerApplication.pdfDocument &&
          window.originalCanvas ===
            PDFViewerApplication.pdfViewer.getPageView(0).canvas &&
          window.originalCanvas.isConnected &&
          window.pdfLoads === 0
      )
    );
    await page.screenshot({ path: '/tmp/pdf-highlight-staged.png' });
    assert.deepStrictEqual(errors, []);
  });

  it('uses Ctrl+Z and Ctrl+Y to undo and redo pending highlights without reloading', async () => {
    await page.keyboard.press('Control+z');
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.pdf-highlight-overlay polygon').length === 2
    );
    await page.keyboard.press('Control+z');
    await page.waitForFunction(
      () => document.querySelectorAll('.pdf-highlight-overlay').length === 0
    );
    assert(!customDocument.isDirty);
    assert.strictEqual(writes, 0);
    await page.keyboard.press('Control+y');
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.pdf-highlight-overlay polygon').length === 2
    );
    assert(customDocument.isDirty);
    assert.strictEqual(writes, 0);
  });

  it('writes only on Ctrl+S and keeps the same visible canvas through save and file watcher events', async () => {
    await saveWithKeyboard();
    assert.strictEqual(writes, 1);
    assert.strictEqual(await annotationCount(), 1);
    await customDocument.refreshFromDisk();
    assert(
      await page.evaluate(
        () =>
          window.originalPdf === PDFViewerApplication.pdfDocument &&
          window.originalCanvas ===
            PDFViewerApplication.pdfViewer.getPageView(0).canvas &&
          window.originalCanvas.isConnected &&
          window.pdfLoads === 0
      )
    );
    assert.strictEqual(
      await page.locator('.pdf-highlight-overlay polygon').count(),
      2
    );
    await page.keyboard.press('Control+z');
    await waitForHost(() => customDocument.isDirty);
    await saveWithKeyboard();
    assert.strictEqual(await annotationCount(), 0);
    await page.keyboard.press('Control+y');
    await waitForHost(() => customDocument.isDirty);
    await saveWithKeyboard();
    assert.strictEqual(await annotationCount(), 1);
    assert.deepStrictEqual(errors, []);
  });

  it('keeps overlays aligned when zoomed and rotated, and stages another page without refreshing', async () => {
    await page.setViewportSize({ width: 1400, height: 900 });
    const beforeWrites = writes;
    await page.evaluate(() => {
      const viewer = PDFViewerApplication.pdfViewer;
      viewer.pagesRotation = 90;
      viewer.currentScale = 1.5;
      viewer.currentPageNumber = 2;
    });
    await page.waitForFunction(() => {
      const view = PDFViewerApplication.pdfViewer.getPageView(1);
      return (
        view &&
        view.viewport.rotation === 90 &&
        view.textLayer &&
        view.textLayer.renderingDone
      );
    });
    const expectedPoints = await page.evaluate(() => {
      const view = PDFViewerApplication.pdfViewer.getPageView(0);
      const polygon = view.div.querySelector('.pdf-highlight-overlay polygon');
      return {
        viewBox: polygon.ownerSVGElement.getAttribute('viewBox'),
        width: view.viewport.width,
        height: view.viewport.height,
      };
    });
    assert.strictEqual(
      expectedPoints.viewBox,
      `0 0 ${expectedPoints.width} ${expectedPoints.height}`
    );
    await page.evaluate(() => {
      const span = Array.from(
        document.querySelectorAll('#viewer .textLayer span')
      ).find((span) => span.textContent === 'First line page 2');
      const range = document.createRange();
      range.selectNodeContents(span);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
    await highlightSelection();
    await page.waitForFunction(() =>
      document.querySelector(
        '[data-page-number="2"] .pdf-highlight-overlay polygon'
      )
    );
    assert.strictEqual(writes, beforeWrites);
    const beforeSave = await page.evaluate(() => {
      const viewer = PDFViewerApplication.pdfViewer;
      window.secondCanvas = viewer.getPageView(1).canvas;
      return [
        viewer.currentPageNumber,
        viewer.currentScale,
        viewer.pagesRotation,
        viewer.container.scrollTop,
      ];
    });
    await saveWithKeyboard();
    assert.strictEqual(await annotationCount(), 2);
    assert.deepStrictEqual(
      await page.evaluate(() => {
        const viewer = PDFViewerApplication.pdfViewer;
        return [
          viewer.currentPageNumber,
          viewer.currentScale,
          viewer.pagesRotation,
          viewer.container.scrollTop,
        ];
      }),
      beforeSave
    );
    assert(
      await page.evaluate(
        () =>
          PDFViewerApplication.pdfViewer.getPageView(1).canvas ===
            window.secondCanvas && window.pdfLoads === 0
      )
    );
  });

  it('restores overlays when the webview reloads, and reverts to the saved PDF on discard', async () => {
    await page.reload();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.pdf-highlight-overlay polygon').length === 3
    );
    assert(!customDocument.isDirty);
    await selectText({ partial: true });
    await highlightSelection();
    await waitForHost(() => customDocument.isDirty);
    const before = writes;
    await provider.revertCustomDocument(customDocument);
    await page.waitForFunction(
      () =>
        !document.querySelector('.pdf-highlight-overlay') &&
        PDFViewerApplication.pdfDocument &&
        PDFViewerApplication.isInitialViewSet
    );
    assert(!customDocument.isDirty);
    assert.strictEqual(writes, before);
    assert.strictEqual(await annotationCount(), 2);
    assert.deepStrictEqual(errors, []);
  });

  async function clickFirstHighlight(partial = false) {
    const span = page
      .locator('#viewer .textLayer span')
      .filter({ hasText: /^First line page 1$/ });
    await span.scrollIntoViewIfNeeded();
    const position = await span.evaluate((element, partial) => {
      const range = document.createRange();
      range.setStart(element.firstChild, partial ? 6 : 0);
      range.setEnd(
        element.firstChild,
        partial ? 10 : element.textContent.length
      );
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, partial);
    await page.mouse.click(position.x, position.y);
    await page.locator('.pdf-comment-panel').waitFor({ state: 'visible' });
  }

  it('edits comments on existing highlights without reloading, with undo and explicit save', async () => {
    const beforeWrites = writes;
    const text = '中文批注\nSecond line 📝\n<script>literal text</script>';
    await page.evaluate(() => {
      window.commentPdf = PDFViewerApplication.pdfDocument;
      window.commentCanvas = PDFViewerApplication.pdfViewer.getPageView(
        0
      ).canvas;
    });
    await clickFirstHighlight();
    assert.strictEqual(
      await page.locator('#pdf-comment-input').inputValue(),
      ''
    );
    await page.locator('#pdf-comment-input').fill(text);
    await page.screenshot({ path: '/tmp/pdf-comment-editor.png' });
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await waitForHost(() => customDocument.isDirty);
    assert.strictEqual(writes, beforeWrites);
    assert.strictEqual((await readHighlights(pdfBytes))[0].comment, '');
    await page.keyboard.press('Control+z');
    await waitForHost(() => !customDocument.isDirty);
    await clickFirstHighlight();
    assert.strictEqual(
      await page.locator('#pdf-comment-input').inputValue(),
      ''
    );
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.keyboard.press('Control+y');
    await waitForHost(() => customDocument.isDirty);
    await saveWithKeyboard();
    assert.strictEqual((await readHighlights(pdfBytes))[0].comment, text);
    assert.strictEqual(await annotationCount(), 2);
    assert(
      await page.evaluate(
        () =>
          window.commentPdf === PDFViewerApplication.pdfDocument &&
          window.commentCanvas ===
            PDFViewerApplication.pdfViewer.getPageView(0).canvas
      )
    );
    await clickFirstHighlight();
    assert.strictEqual(
      await page.locator('#pdf-comment-input').inputValue(),
      text
    );
    await page.locator('#pdf-comment-input').fill('Cancelled draft');
    await page.keyboard.press('Escape');
    assert(!customDocument.isDirty);
    assert.strictEqual((await readHighlights(pdfBytes))[0].comment, text);
    assert.deepStrictEqual(errors, []);
  });

  it('saves the active comment draft on Ctrl+S and supports clearing it after a webview reload', async () => {
    const beforeWrites = writes;
    await selectText({ partial: true });
    await highlightSelection();
    await page.waitForFunction(() =>
      document.querySelector('.pdf-highlight-overlay polygon')
    );
    await clickFirstHighlight(true);
    assert.strictEqual(
      await page.locator('#pdf-comment-input').inputValue(),
      ''
    );
    await page.locator('#pdf-comment-input').fill('Comment on new highlight');
    assert.strictEqual(writes, beforeWrites);
    await saveWithKeyboard();
    assert.strictEqual(
      (await readHighlights(pdfBytes)).filter(
        (h) => h.comment === 'Comment on new highlight'
      ).length,
      1
    );
    assert.strictEqual(await annotationCount(), 3);
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector('.pdf-highlight-overlay polygon')
    );
    await clickFirstHighlight(true);
    assert.strictEqual(
      await page.locator('#pdf-comment-input').inputValue(),
      'Comment on new highlight'
    );
    await page.locator('#pdf-comment-input').fill('');
    await page.keyboard.press('Control+Enter');
    await waitForHost(() => customDocument.isDirty);
    await saveWithKeyboard();
    const saved = await readHighlights(pdfBytes);
    assert.strictEqual(saved[2].comment, '');
    assert.strictEqual(await annotationCount(), 3);
    assert.deepStrictEqual(errors, []);
    fs.writeFileSync('/tmp/pdf-comments-result.pdf', pdfBytes);
  });

  it('allows dragging a text selection through a highlight without opening its comment', async () => {
    await page.evaluate(() => {
      PDFViewerApplication.pdfViewer.pagesRotation = 0;
      PDFViewerApplication.pdfViewer.currentPageNumber = 1;
    });
    await page.waitForFunction(() => {
      const view = PDFViewerApplication.pdfViewer.getPageView(0);
      return (
        view.viewport.rotation === 0 &&
        view.textLayer &&
        view.textLayer.renderingDone
      );
    });
    const span = page
      .locator('#viewer .textLayer span')
      .filter({ hasText: /^First line page 1$/ });
    await span.scrollIntoViewIfNeeded();
    const rect = await span.boundingBox();
    await page.mouse.move(rect.x + 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 2, rect.y + rect.height / 2, {
      steps: 15,
    });
    await page.mouse.up();
    assert(
      (await page.evaluate(() => window.getSelection().toString())).includes(
        'First line'
      )
    );
    assert(await page.locator('.pdf-comment-panel').isHidden());
  });
});
