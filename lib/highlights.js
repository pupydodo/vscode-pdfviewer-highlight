'use strict';

// Keep selection geometry in PDF coordinates, independent of zoom and rotation.
window.PdfHighlights = (function () {
  function collectSelection(selection, pdfViewer) {
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      return [];
    }
    const pages = [];
    for (const layer of document.querySelectorAll('#viewer .page .textLayer')) {
      const pageIndex = Number(layer.closest('.page').dataset.pageNumber) - 1;
      const pageView = pdfViewer.getPageView(pageIndex);
      const canvas = pageView && pageView.div.querySelector('.canvasWrapper');
      if (!canvas) {
        continue;
      }
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) {
        continue;
      }
      const viewport = pageView.viewport;
      const quads = [];
      const texts = [];
      const seen = new Set();
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        if (!range.intersectsNode(layer)) {
          continue;
        }
        // Reading text nodes avoids duplicate rectangles from nested spans,
        // including the spans PDF.js adds for search results and marked content.
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!range.intersectsNode(node)) {
            continue;
          }
          const part = document.createRange();
          part.selectNodeContents(node);
          if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) {
            part.setStart(range.startContainer, range.startOffset);
          }
          if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) {
            part.setEnd(range.endContainer, range.endOffset);
          }
          if (part.collapsed || !part.toString().trim()) {
            continue;
          }
          texts.push(part.toString());
          for (const rect of part.getClientRects()) {
            const left = Math.max(rect.left, bounds.left);
            const top = Math.max(rect.top, bounds.top);
            const right = Math.min(rect.right, bounds.right);
            const bottom = Math.min(rect.bottom, bounds.bottom);
            if (right <= left || bottom <= top) {
              continue;
            }
            const quad = [];
            for (const [x, y] of [
              [left, top],
              [right, top],
              [left, bottom],
              [right, bottom],
            ]) {
              quad.push(
                ...viewport
                  .convertToPdfPoint(
                    ((x - bounds.left) * viewport.width) / bounds.width,
                    ((y - bounds.top) * viewport.height) / bounds.height
                  )
                  .map((value) => Number(value.toFixed(4)))
              );
            }
            const key = quad.join(',');
            if (!seen.has(key)) {
              seen.add(key);
              quads.push(quad);
            }
          }
        }
      }
      if (quads.length) {
        pages.push({ pageIndex, quads, text: texts.join(' ') });
      }
    }
    return pages;
  }

  function install(application, config, vscode) {
    const comments = PdfComments.install(application, config, vscode);
    const container = document.getElementById('viewerContainer');
    let selectionId = 0;
    let pendingSelection;
    let adding = false;
    let state = { sourceHash: '', highlights: [] };

    function clear() {
      pendingSelection = undefined;
      container.dataset.vscodeContext = JSON.stringify({
        pdfHasSelection: false,
      });
    }

    function renderPage(pageIndex) {
      const view = application.pdfViewer.getPageView(pageIndex);
      if (!view || !view.viewport) return;
      const existing = view.div.querySelector('.pdf-highlight-overlay');
      if (existing) existing.remove();
      const pages = state.highlights
        .flatMap((edit) => edit.pages)
        .filter((page) => page.pageIndex === pageIndex);
      if (!pages.length) return;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('pdf-highlight-overlay');
      svg.setAttribute(
        'viewBox',
        `0 0 ${view.viewport.width} ${view.viewport.height}`
      );
      svg.setAttribute('aria-hidden', 'true');
      for (const page of pages) {
        for (const quad of page.quads) {
          const points = [0, 2, 6, 4].map((index) =>
            view.viewport
              .convertToViewportPoint(quad[index], quad[index + 1])
              .join(',')
          );
          const polygon = document.createElementNS(svg.namespaceURI, 'polygon');
          polygon.setAttribute('points', points.join(' '));
          svg.appendChild(polygon);
        }
      }
      view.div.appendChild(svg);
    }

    function renderAll() {
      for (const page of document.querySelectorAll('#viewer .page')) {
        renderPage(Number(page.dataset.pageNumber) - 1);
      }
    }

    function setState(message) {
      state = message;
      comments.setState(message);
      if (message.type === 'load-document') clear();
      renderAll();
    }

    // Retain geometry while VS Code's native context menu owns focus.
    window.addEventListener(
      'contextmenu',
      (event) => {
        clear();
        if (
          adding ||
          !state.sourceHash ||
          !event.target.closest ||
          !event.target.closest('#viewer .page')
        )
          return;
        const pages = collectSelection(
          window.getSelection(),
          application.pdfViewer
        );
        if (!pages.length || !application.pdfDocument) return;
        pendingSelection = {
          pages,
          sourceHash: state.sourceHash,
          document: application.pdfDocument,
          id: ++selectionId,
        };
        container.dataset.vscodeContext = JSON.stringify({
          pdfHasSelection: true,
          pdfPreviewId: config.previewId,
          pdfSelectionId: selectionId,
        });
      },
      true
    );

    // PDF.js normally handles Ctrl+S itself as a download. Forward editing
    // shortcuts to VS Code so dirty state, undo, and save use its document model.
    window.addEventListener(
      'keydown',
      (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        let type;
        if (key === 's') type = 'save-document';
        else if (
          !event.target.closest('input, textarea, [contenteditable="true"]')
        ) {
          if (key === 'z') type = event.shiftKey ? 'redo' : 'undo';
          if (key === 'y') type = 'redo';
        }
        if (!type) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (type === 'save-document') comments.save(event.shiftKey);
        else vscode.postMessage({ type });
      },
      true
    );

    application.eventBus.on('pagesinit', () => {
      clear();
      renderAll();
    });
    application.eventBus.on('pagerendered', (event) =>
      renderPage(event.pageNumber - 1)
    );
    application.eventBus.on('scalechanging', renderAll);
    application.eventBus.on('rotationchanging', renderAll);
    return {
      setState,
      handleMessage(message) {
        if (comments.handleMessage(message)) return true;
        switch (message.type) {
          case 'highlights-changed':
            setState(message);
            return true;
          case 'highlight-selection': {
            const selected = pendingSelection;
            if (
              !adding &&
              selected &&
              selected.id === message.selectionId &&
              selected.document === application.pdfDocument
            ) {
              adding = true;
              clear();
              vscode.postMessage({
                type: 'add-highlight',
                selection: {
                  sourceHash: selected.sourceHash,
                  pages: selected.pages,
                },
              });
            }
            return true;
          }
          case 'highlight-added':
            window.getSelection().removeAllRanges();
            adding = false;
            clear();
            return true;
          case 'highlight-failed':
            adding = false;
            clear();
            return true;
          default:
            return false;
        }
      },
    };
  }

  return { collectSelection, install };
})();
