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
  let currentPage = Math.min(Math.max(1, Number(options.page) || 1), pdf.numPages);
  let scale = Number(options.scale) || 1;
  let destroyed = false;
  let renderToken = 0;
  let preloadObserver = null;
  let currentPageObserver = null;
  const renderedPages = new Map();
  const scrollContainer = options.scrollContainer || root.closest('.viewer-wrap') || root;

  async function renderPage(pageNumber, pageEl, token) {
    if (destroyed || pageEl.dataset.rendering === 'true' || pageEl.dataset.rendered === 'true') return;
    pageEl.dataset.rendering = 'true';
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    if (destroyed || token !== renderToken) return;
    pageEl.replaceChildren();
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
    const context = canvas.getContext('2d', { alpha: false });
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: context, viewport }).promise;
    const textContent = await page.getTextContent();
    if (destroyed || token !== renderToken) return;
    renderTextLayer(textLayer, textContent, viewport);
    textLayer.addEventListener('mouseup', event => {
      const selection = window.getSelection()?.toString().trim();
      if (typeof options.onSelect !== 'function') return;
      const viewerRect = scrollContainer.getBoundingClientRect();
      options.onSelect({ text: selection || '', page: pageNumber, rect: { left: event.clientX - viewerRect.left, top: event.clientY - viewerRect.top } });
    });
    pageEl.dataset.rendering = 'false';
    pageEl.dataset.rendered = 'true';
    renderedPages.set(pageNumber, pageEl);
  }

  async function buildContinuousPages({ preservePage = currentPage } = {}) {
    const token = ++renderToken;
    preloadObserver?.disconnect();
    currentPageObserver?.disconnect();
    renderedPages.clear();
    root.replaceChildren();
    const firstPage = await pdf.getPage(1);
    const firstViewport = firstPage.getViewport({ scale });
    if (destroyed || token !== renderToken) return;
    const fragment = document.createDocumentFragment();
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const shell = document.createElement('section');
      shell.className = 'pdf-page pdf-page-shell';
      shell.dataset.page = String(pageNumber);
      shell.style.width = `${firstViewport.width}px`;
      shell.style.height = `${firstViewport.height}px`;
      shell.innerHTML = `<div class="pdf-page-placeholder">第 ${pageNumber} 页</div>`;
      fragment.append(shell);
    }
    root.append(fragment);
    const shells = [...root.querySelectorAll('.pdf-page-shell')];
    preloadObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) renderPage(Number(entry.target.dataset.page), entry.target, token).catch(() => {
        entry.target.dataset.rendering = 'false';
        entry.target.innerHTML = '<div class="pdf-reader-status">本页渲染失败，可继续滚动后重试。</div>';
      });
    }, { root: scrollContainer, rootMargin: '1200px 0px', threshold: 0.01 });
    currentPageObserver = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      const next = Number(visible.target.dataset.page);
      if (next === currentPage) return;
      currentPage = next;
      if (typeof options.onPageChange === 'function') options.onPageChange(next);
    }, { root: scrollContainer, threshold: [0.3, 0.5, 0.7] });
    shells.forEach(shell => { preloadObserver.observe(shell); currentPageObserver.observe(shell); });
    requestAnimationFrame(() => shells[Math.max(0, preservePage - 1)]?.scrollIntoView({ block: 'start' }));
  }

  await buildContinuousPages();
  return {
    pageCount: pdf.numPages,
    goToPage(next) {
      currentPage = Math.min(pdf.numPages, Math.max(1, Number(next) || 1));
      root.querySelector(`[data-page="${currentPage}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (typeof options.onPageChange === 'function') options.onPageChange(currentPage);
    },
    setZoom(next) { scale = Math.max(0.5, Math.min(3, Number(next) || 1)); buildContinuousPages({ preservePage: currentPage }).catch(() => {}); },
    async destroy() { destroyed = true; preloadObserver?.disconnect(); currentPageObserver?.disconnect(); root.replaceChildren(); await pdf.destroy(); }
  };
}
