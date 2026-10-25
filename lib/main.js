'use strict'
;(function () {
  function loadConfig() {
    const elem = document.getElementById('pdf-preview-config')
    if (elem) {
      return JSON.parse(elem.getAttribute('data-config'))
    }
    throw new Error('Could not load configuration.')
  }
  function cursorTools(name) {
    if (name === 'hand') {
      return 1
    }
    return 0
  }
  function scrollMode(name) {
    switch (name) {
      case 'vertical':
        return 0
      case 'horizontal':
        return 1
      case 'wrapped':
        return 2
      default:
        return -1
    }
  }
  function spreadMode(name) {
    switch (name) {
      case 'none':
        return 0
      case 'odd':
        return 1
      case 'even':
        return 2
      default:
        return -1
    }
  }
  window.addEventListener(
    'load',
    async function () {
      const config = loadConfig()
      const vscode = acquireVsCodeApi()
      await PDFViewerApplication.initializedPromise
      const highlights = PdfHighlights.install(
        PDFViewerApplication,
        config,
        vscode
      )
      PDFViewerApplicationOptions.set('cMapUrl', config.cMapUrl)
      PDFViewerApplicationOptions.set(
        'standardFontDataUrl',
        config.standardFontDataUrl
      )
      const loadOpts = {
        useWorkerFetch: false,
        cMapUrl: config.cMapUrl,
        cMapPacked: true,
        standardFontDataUrl: config.standardFontDataUrl,
      }
      const application = PDFViewerApplication
      const defaults = config.defaults
      const optsOnLoad = () => {
        application.pdfCursorTools.switchTool(cursorTools(defaults.cursor))
        application.pdfViewer.currentScaleValue = defaults.scale
        application.pdfViewer.scrollMode = scrollMode(defaults.scrollMode)
        application.pdfViewer.spreadMode = spreadMode(defaults.spreadMode)
        if (defaults.sidebar) {
          application.pdfSidebar.open()
        } else {
          application.pdfSidebar.close()
        }
        application.eventBus.off('documentinit', optsOnLoad)
      }
      application.eventBus.on('documentinit', optsOnLoad)

      let location
      application.eventBus.on('updateviewarea', (event) => {
        location = event.location
      })
      let loadChain = Promise.resolve()
      window.addEventListener('message', function (event) {
        const message = event.data
        if (!message || typeof message.type !== 'string') return
        if (highlights.handleMessage(message)) return
        if (message.type !== 'load-document') return
        highlights.setState(message)
        loadChain = loadChain
          .then(() => loadDocument(message))
          .catch((error) => console.error('Could not load PDF', error))
      })
      vscode.postMessage({ type: 'ready' })

      async function loadDocument(message) {
        const hadDocument = !!application.pdfDocument
        const viewer = application.pdfViewer
        const bookmark = location
          ? location.pdfOpenParams.substring(1)
          : `page=${viewer.currentPageNumber}&zoom=${viewer.currentScale * 100}`
        const rotation = viewer.pagesRotation
        const pageNumber = viewer.currentPageNumber
        const scroll = viewer.scrollMode
        const spread = viewer.spreadMode
        const sidebar = application.pdfSidebar.visibleView
        let onInit
        const initialized = new Promise((resolve) => {
          onInit = () => {
            application.eventBus.off('documentinit', onInit)
            if (hadDocument) {
              viewer.scrollMode = scroll
              viewer.spreadMode = spread
              viewer.pagesRotation = rotation
              application.pdfLinkService.setHash(bookmark)
              if (
                viewer.currentPageNumber !==
                Math.min(pageNumber, viewer.pagesCount)
              ) {
                viewer.currentPageNumber = Math.min(
                  pageNumber,
                  viewer.pagesCount
                )
              }
              application.pdfSidebar.switchView(sidebar, true)
              if (sidebar === 0) application.pdfSidebar.close()
            }
            resolve()
          }
          application.eventBus.on('documentinit', onInit)
        })
        // Only opening, reverting, or an external file change replaces the PDF.
        // Adding highlights and saving leave the page canvases untouched.
        try {
          await application.open(new Uint8Array(message.data), loadOpts)
          application.setTitleUsingUrl(config.path)
          if (!application.pdfDocument) {
            throw new Error('The PDF could not be reopened.')
          }
          await initialized
        } finally {
          application.eventBus.off('documentinit', onInit)
        }
      }
    },
    { once: true }
  )

  window.onerror = function () {
    const msg = document.createElement('body')
    msg.innerText =
      'An error occurred while loading the file. Please open it again.'
    document.body = msg
  }
})()
