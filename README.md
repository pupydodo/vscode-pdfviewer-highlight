# pdf

Display pdf in VSCode.

## Highlight selected text

Requires VS Code 1.72 or newer.

1. Open a PDF with **Pdf Preview** and use the text selection cursor.
2. Select text, then right-click the selection and choose **Highlight** (**高亮** in Chinese).
3. The selected text is highlighted in yellow immediately. Changes stay in memory
   and the editor is marked as modified; the PDF is not reloaded.
4. Press **Ctrl+S** (**Cmd+S** on macOS) to write the highlights to the PDF.

Saving also keeps the current page canvases, zoom, rotation, and scroll position.
**Ctrl+Z / Ctrl+Y** (macOS: **Cmd+Z / Cmd+Shift+Z**) undo and redo highlights,
including edits made before the last save. Closing a modified editor uses VS
Code's normal save/discard handling. Save As, Revert File, and recovery of unsaved
changes after restarting VS Code are supported.

The editor follows VS Code's **Files: Auto Save** setting, like a code editor. If
you want to save only with Ctrl+S, leave Auto Save off.

Saved highlights are standard PDF annotations: they remain after reopening the file and
are visible in other PDF readers. Partial words, multiple lines, and selections
across rendered pages are supported, including when zoomed or rotated. Existing
text, links, and annotations are retained.

The PDF must be writable and unencrypted. Scanned image-only PDFs need OCR before
text can be selected. Highlights already present when the PDF is opened can be
removed with a PDF editor that supports deleting existing annotations.

## Edit highlight comments

Click a highlighted area (without dragging a text selection) to open its comment
editor. This works for new highlights and highlights already saved in the PDF.

- Enter a multiline comment and choose **Apply** or press **Ctrl+Enter** to stage
  the change. **Ctrl+S** saves it to the PDF; pressing Ctrl+S inside the comment
  editor also applies the current draft before saving.
- **Cancel** or **Escape** discards the current unapplied draft.
- Clear the comment and apply it to remove the comment while keeping the highlight.
- Applied changes support the same undo/redo, Save As, and backup recovery as
  highlights. On macOS, use Cmd in place of Ctrl.

Comments use the PDF annotation's standard text content and remain editable after
reopening, including in other PDF readers. Cross-page highlights created by this
version share a comment across their pages. Editing and saving do not reload the
PDF.

## Development

```sh
npm ci
npm test
npm run lint
npm run package
```

Press **F5** to launch the extension in a development window. To test the browser
selection and save flow, install Chromium for Playwright and run:

```sh
npx playwright-core install chromium
npm run test:browser
```

Alternatively set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chromium
executable. The browser tests exercise the real PDF.js viewer with a simulated
VS Code message bridge; the native VS Code menu can be checked in the F5 window.

![screenshot](https://user-images.githubusercontent.com/3643499/84454816-98fcd600-ac96-11ea-822c-3ae1e1599a13.gif)

## Contribute

### Upgrade PDF.js

1. Download latest [Prebuilt(older browsers)](https://mozilla.github.io/pdf.js/getting_started/#download).
1. Extract the ZIP file.
1. Overwrite ./lib/* by extracted directories.
   - If lib/web/viewer.html has changes, apply these changes to HTML template at pdfPreview.ts.
1. To not use sample pdf.
  - Remove sample pdf called `compressed.tracemonkey-pldi-09.pdf`.
  - Remove code about using sample pdf from lib/web/viewer.js.
    ```js
    defaultUrl: {
      value: "", // "compressed.tracemonkey-pldi-09.pdf"
      kind: OptionKind.VIEWER
    },
    ```

## Change log
See [CHANGELOG.md](CHANGELOG.md).

## License
Please see [LICENSE](./LICENSE)
