import type { PDFDocumentProxy } from 'pdfjs-dist';

let library: Promise<typeof import('pdfjs-dist')> | null = null;

function load() {
  library ??= Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs as unknown as typeof import('pdfjs-dist');
  });
  return library;
}

export async function openPdf(url: string) {
  const pdfjs = await load();
  return pdfjs.getDocument({
    url,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/'
  });
}

/** Largest bitmap drawn for one page; beyond it the page is drawn smaller and scaled up. */
const MAX_PIXELS = 16_000_000;

/**
 * Draws a page into a canvas at the given width in CSS pixels.
 * `cancel` stops a drawing that is no longer wanted, e.g. because the zoom changed again.
 */
export function renderPage(document: PDFDocumentProxy, pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number) {
  let cancelled = false;
  let task: { cancel: () => void } | null = null;
  const promise = (async () => {
    const page = await document.getPage(pageNumber);
    if (cancelled) return;
    const base = page.getViewport({ scale: 1 });
    const wanted = (cssWidth / base.width) * (window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: Math.min(wanted, Math.sqrt(MAX_PIXELS / (base.width * base.height))) });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${Math.floor((cssWidth * base.height) / base.width)}px`;
    const rendering = page.render({ canvas, viewport });
    task = rendering;
    await rendering.promise;
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      task?.cancel();
    }
  };
}

const thumbnails = new Map<string, Promise<string>>();

/** First page of a PDF as an image, cached by content hash. */
export function pdfThumbnail(url: string, sha256: string) {
  let pending = thumbnails.get(sha256);
  if (!pending) {
    pending = (async () => {
      const task = await openPdf(url);
      const document = await task.promise;
      try {
        const canvas = window.document.createElement('canvas');
        await renderPage(document, 1, canvas, 480).promise;
        return canvas.toDataURL('image/png');
      } finally {
        void task.destroy();
      }
    })();
    thumbnails.set(sha256, pending);
    pending.catch(() => thumbnails.delete(sha256));
  }
  return pending;
}
