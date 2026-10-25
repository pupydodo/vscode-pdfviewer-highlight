'use strict';

window.PdfComments = (function () {
  function install(application, config, vscode) {
    const viewer = document.getElementById('viewerContainer');
    const chinese = (config.language || '').startsWith('zh');
    const labels = chinese
      ? {
          title: '高亮批注',
          placeholder: '输入批注…',
          apply: '应用',
          cancel: '取消',
          hint: '应用后暂存；Ctrl+S 保存到 PDF。清空内容可删除批注。',
          pending: '正在应用…',
          switch: '请先应用或取消当前批注。',
          changed: '批注已在另一处修改；请重新打开后编辑。',
          hover: '点击添加或编辑批注',
        }
      : {
          title: 'Highlight comment',
          placeholder: 'Write a comment…',
          apply: 'Apply',
          cancel: 'Cancel',
          hint:
            'Apply stages the change; Ctrl+S saves the PDF. Clear the text to remove the comment.',
          pending: 'Applying…',
          switch: 'Apply or cancel this comment before opening another.',
          changed: 'This comment changed elsewhere. Reopen it before editing.',
          hover: 'Click to add or edit a comment',
        };
    let state = { sourceHash: '', highlights: [], existingHighlights: [] };
    let current;
    let pending;
    let requestId = 0;
    let pointerStart;

    const panel = document.createElement('section');
    panel.className = 'pdf-comment-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'pdf-comment-title');
    const title = document.createElement('h2');
    title.id = 'pdf-comment-title';
    title.textContent = labels.title;
    const quote = document.createElement('blockquote');
    quote.className = 'pdf-comment-quote';
    const input = document.createElement('textarea');
    input.id = 'pdf-comment-input';
    input.setAttribute('aria-label', labels.title);
    input.placeholder = labels.placeholder;
    input.maxLength = 10000;
    input.rows = 6;
    const hint = document.createElement('p');
    hint.className = 'pdf-comment-hint';
    hint.textContent = labels.hint;
    const status = document.createElement('p');
    status.className = 'pdf-comment-status';
    status.setAttribute('aria-live', 'polite');
    const actions = document.createElement('div');
    actions.className = 'pdf-comment-actions';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.textContent = labels.apply;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = labels.cancel;
    actions.append(apply, cancel);
    panel.append(title, quote, input, hint, status, actions);
    document.body.appendChild(panel);

    const allHighlights = () => [
      ...(state.existingHighlights || []),
      ...state.highlights,
    ];

    function close() {
      panel.hidden = true;
      current = undefined;
      viewer.focus({ preventScroll: true });
    }

    function open(highlight) {
      if (pending) return;
      if (
        current &&
        current.id !== highlight.id &&
        input.value !== current.comment
      ) {
        status.textContent = labels.switch;
        input.focus();
        return;
      }
      if (current && current.id === highlight.id) {
        input.focus();
        return;
      }
      current = {
        id: highlight.id,
        sourceHash: state.sourceHash,
        comment: highlight.comment || '',
      };
      input.value = current.comment;
      quote.textContent = highlight.pages
        .map((page) => page.text)
        .filter(Boolean)
        .join('\n');
      quote.hidden = !quote.textContent;
      status.textContent = '';
      panel.hidden = false;
      input.focus({ preventScroll: true });
    }

    function commit(save = false, saveAs = false) {
      if (pending) {
        pending.save = pending.save || save;
        pending.saveAs = pending.saveAs || saveAs;
        return;
      }
      if (!current || input.value === current.comment) {
        if (current) close();
        if (save) vscode.postMessage({ type: 'save-document', saveAs });
        return;
      }
      pending = { id: ++requestId, save, saveAs };
      apply.disabled = cancel.disabled = input.disabled = true;
      status.textContent = labels.pending;
      vscode.postMessage({
        type: 'update-comment',
        sourceHash: current.sourceHash,
        highlightId: current.id,
        expectedComment: current.comment,
        comment: input.value,
        requestId: pending.id,
      });
    }

    function hitTest(event) {
      const page =
        event.target.closest && event.target.closest('#viewer .page');
      if (
        !page ||
        event.target.closest(
          'a, button, input, textarea, [contenteditable="true"]'
        )
      )
        return;
      const pageIndex = Number(page.dataset.pageNumber) - 1;
      const view = application.pdfViewer.getPageView(pageIndex);
      const canvas = page.querySelector('.canvasWrapper');
      if (!view || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const [x, y] = view.viewport.convertToPdfPoint(
        ((event.clientX - rect.left) * view.viewport.width) / rect.width,
        ((event.clientY - rect.top) * view.viewport.height) / rect.height
      );
      // Prefer the latest highlight when annotations overlap.
      return allHighlights()
        .reverse()
        .find((highlight) =>
          highlight.pages.some(
            (page) =>
              page.pageIndex === pageIndex &&
              page.quads.some((q) => {
                const xs = [q[0], q[2], q[4], q[6]],
                  ys = [q[1], q[3], q[5], q[7]];
                return (
                  x >= Math.min(...xs) &&
                  x <= Math.max(...xs) &&
                  y >= Math.min(...ys) &&
                  y <= Math.max(...ys)
                );
              })
          )
        );
    }

    viewer.addEventListener(
      'pointerdown',
      (event) => {
        pointerStart = { x: event.clientX, y: event.clientY };
      },
      true
    );
    viewer.addEventListener('pointermove', (event) => {
      if (event.buttons) return;
      const highlight = hitTest(event);
      viewer.classList.toggle('pdf-over-highlight', !!highlight);
      viewer.title = highlight
        ? (highlight.comment || labels.hover).slice(0, 300)
        : '';
    });
    viewer.addEventListener('pointerleave', () => {
      viewer.classList.remove('pdf-over-highlight');
      viewer.removeAttribute('title');
    });
    // PDF.js popups read the immutable base PDF and would show an old comment
    // after an in-memory edit. Use this editor for highlights instead.
    viewer.addEventListener(
      'mouseover',
      (event) => {
        if (event.target.closest('.highlightAnnotation') && hitTest(event))
          event.stopImmediatePropagation();
      },
      true
    );
    viewer.addEventListener(
      'click',
      (event) => {
        if (
          event.button !== 0 ||
          !pointerStart ||
          Math.hypot(
            event.clientX - pointerStart.x,
            event.clientY - pointerStart.y
          ) > 5 ||
          !window.getSelection().isCollapsed
        )
          return;
        const highlight = hitTest(event);
        if (!highlight) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        open(highlight);
      },
      true
    );
    apply.addEventListener('click', () => commit());
    cancel.addEventListener('click', close);
    panel.addEventListener('keydown', (event) => {
      if (event.isComposing || pending) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        commit();
      }
    });

    return {
      save: (saveAs) => commit(true, saveAs),
      setState(message) {
        state = message;
        if (!current) return;
        const highlight = allHighlights().find(
          (highlight) => highlight.id === current.id
        );
        if (current.sourceHash !== state.sourceHash || !highlight) {
          panel.hidden = true;
          current = undefined;
          return;
        }
        if (pending) return;
        if (input.value === current.comment) {
          current.comment = highlight.comment || '';
          input.value = current.comment;
        } else if (current.comment !== (highlight.comment || '')) {
          status.textContent = labels.changed;
        }
      },
      handleMessage(message) {
        if (
          message.type !== 'comment-updated' &&
          message.type !== 'comment-failed'
        )
          return false;
        if (!pending || message.requestId !== pending.id) return true;
        const completed = pending;
        pending = undefined;
        apply.disabled = cancel.disabled = input.disabled = false;
        if (message.type === 'comment-failed') {
          status.textContent = message.error;
          input.focus();
          return true;
        }
        close();
        if (completed.save)
          vscode.postMessage({
            type: 'save-document',
            saveAs: completed.saveAs,
          });
        return true;
      },
    };
  }
  return { install };
})();
