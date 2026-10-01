import { getDocument, GlobalWorkerOptions, Util } from '/vendor/pdfjs/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

function renderTextLayer(container, textContent, viewport) {
  container.replaceChildren();
  for (const item of textContent.items || []) {
    if (!item.str) continue;
    const span = document.createElement('span');
    const transform = Util.transform(viewport.transform, item.transform);
    const fontSize = Math.max(5, Math.hypot(transform[2], transform[3]));
    span.textContent = item.str;
    span.style.left = `${transform[4]}px`;
    span.style.top = `${transform[5] - fontSize}px`;
    span.style.fontSize = `${fontSize}px`;
    span.style.width = `${Math.max(item.width * viewport.scale, fontSize * 0.25)}px`;
    span.style.height = `${Math.max(fontSize * 1.25, 8)}px`;
    span.dataset.source = 'native-pdf';
    container.append(span);
  }
}

export async function mountPdfReader(root, options) {
  root.replaceChildren();
  root.className = 'pdf-reader-surface';
  const loading = document.createElement('div');
  loading.className = 'pdf-reader-status';
  loading.textContent = 'Loading original PDF…';
  root.append(loading);
  const task = getDocument({ url: options.url });
  const pdf = await task.promise;
  const pageNumber = Math.min(Math.max(1, Number(options.page) || 1), pdf.numPages);
  let scale = Number(options.scale) || 1;
  let destroyed = false;
  let renderToken = 0;

  async function renderPage() {
    const token = ++renderToken;
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    if (destroyed || token !== renderToken) return;
    root.replaceChildren();
    const pageEl = document.createElement('div');
    pageEl.className = 'pdf-page';
    pageEl.style.width = `${viewport.width}px`;
    pageEl.style.height = `${viewport.height}px`;
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.ceil(viewport.width * dpr);
    canvas.height = Math.ceil(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const textLayer = document.createElement('div');
    textLayer.className = 'pdf-text-layer';
    const annotationLayer = document.createElement('div');
    annotationLayer.className = 'pdf-annotation-layer';
    pageEl.append(canvas, textLayer, annotationLayer);
    root.append(pageEl);
    const context = canvas.getContext('2d', { alpha: false });
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: context, viewport }).promise;
    const textContent = await page.getTextContent();
    renderTextLayer(textLayer, textContent, viewport);
    textLayer.addEventListener('mouseup', event => {
      const selection = window.getSelection()?.toString().trim();
      if (!selection || typeof options.onSelect !== 'function') return;
      const rect = textLayer.getBoundingClientRect();
      options.onSelect({ text: selection, rect: { left: event.clientX - rect.left, top: event.clientY - rect.top } });
    });
  }

  await renderPage();
  return {
    pageCount: pdf.numPages,
    setZoom(next) { scale = Math.max(0.5, Math.min(3, Number(next) || 1)); renderPage().catch(() => {}); },
    async destroy() { destroyed = true; root.replaceChildren(); await pdf.destroy(); }
  };
}
