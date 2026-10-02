import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const uploadDir = path.join(root, 'uploads');
const baseUrl = process.env.STUDYAGENT_URL || 'http://127.0.0.1:4173';

function fail(message) {
  console.error(`PDF regression failed: ${message}`);
  process.exitCode = 1;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let payload = null;
  try { payload = await response.json(); } catch { /* keep the response status as the useful diagnostic */ }
  return { response, payload };
}

const sample = fs.readdirSync(uploadDir, { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.pdf$/i.test(entry.name))
  .map(entry => ({ name: entry.name, mtime: fs.statSync(path.join(uploadDir, entry.name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];

if (!sample) {
  fail('no PDF sample exists in uploads/');
} else {
  const { response: parserResponse, payload: parser } = await fetchJson(`${baseUrl}/api/parser/status`);
  const { payload: status } = await fetchJson(`${baseUrl}/api/ocr/status`);
  const { payload: docs } = await fetchJson(`${baseUrl}/api/documents`);
  const pdfjsAsset = await fetch(`${baseUrl}/vendor/pdfjs/pdf.min.mjs`);
  const doc = docs.find(item => item.sourceFile === sample.name);
  if (!doc) {
    fail(`latest sample ${sample.name} is not associated with an imported document`);
  } else {
    const { response: reprocessed, payload: reprocessedDoc } = await fetchJson(`${baseUrl}/api/documents/${doc.id}/reprocess`, { method: 'POST' });
    if (!reprocessed.ok) fail(`sample reprocess returned HTTP ${reprocessed.status}`);
    const { payload: pages } = await fetchJson(`${baseUrl}/api/documents/${doc.id}/pages`);
    const { response: pageApiResponse, payload: firstPage } = await fetchJson(`${baseUrl}/api/documents/${doc.id}/pages/1`);
    const formulaCount = pages.reduce((total, page) => total + (page.formulas || []).length, 0);
    const sampleFormula = pages.flatMap(page => page.formulas || [])[0];
    const { response: correctionResponse, payload: correction } = sampleFormula ? await fetchJson(`${baseUrl}/api/documents/${doc.id}/formula`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: pages.find(page => (page.formulas || []).some(formula => formula.id === sampleFormula.id))?.page, formulaId: sampleFormula.id, latex: sampleFormula.latex }) }) : { response: { ok: false, status: 0 }, payload: null };
    const { payload: correctedPages } = sampleFormula ? await fetchJson(`${baseUrl}/api/documents/${doc.id}/pages`) : { payload: [] };
    const persistedCorrection = Boolean(correctionResponse.ok && correctedPages.some(page => (page.formulas || []).some(formula => formula.id === sampleFormula.id && formula.latex === sampleFormula.latex && formula.provenance?.corrected === true)));
    const pageImage = await fetch(`${baseUrl}/api/documents/${doc.id}/page-image/1`);
    const originalPdf = await fetch(`${baseUrl}/api/documents/${doc.id}/file`);
    const blockCount = pages.reduce((total, page) => total + (page.blocks || []).length, 0);
    const astComplete = pages.every(page => page.source && page.extraction && Array.isArray(page.blocks) && page.blocks.every(block => block.id && block.provenance && 'bbox' in block));
    const result = {
      sample: sample.name,
      documentId: doc.id,
      extraction: reprocessedDoc?.extraction || doc.extraction,
      ocrAvailable: status.available,
      parser,
      parserStatus: parserResponse.status,
      pdfjsAsset: { status: pdfjsAsset.status, contentType: pdfjsAsset.headers.get('content-type') },
      pages: pages.length,
      blocks: blockCount,
      astComplete,
      pageApi: { status: pageApiResponse.status, page: firstPage?.page || null, width: firstPage?.width || null, height: firstPage?.height || null },
      formulas: formulaCount,
      firstLatex: pages[0]?.formulas?.[0]?.latex || null,
      formulaCorrection: { status: correctionResponse.status, persisted: persistedCorrection },
      originalPage: { status: pageImage.status, contentType: pageImage.headers.get('content-type') },
      originalPdf: { status: originalPdf.status, contentType: originalPdf.headers.get('content-type') }
    };
    console.log(JSON.stringify(result, null, 2));
    if (!status.available) fail('local OCR is unavailable');
    if (!parserResponse.ok || !parser?.pdfjs) fail('local PDF.js parser assets are unavailable');
    if (!pdfjsAsset.ok || !pdfjsAsset.headers.get('content-type')?.includes('javascript')) fail('PDF.js browser asset is unavailable');
    if (!pages.length) fail('no page was extracted');
    if (!astComplete) fail('page AST is missing source, provenance, block ids, or bbox fields');
    if (!pageApiResponse.ok || firstPage?.page !== 1 || !Array.isArray(firstPage?.blocks)) fail('single-page AST API is unavailable');
    if (!formulaCount) fail('no formula block was produced from the sample');
    if (!persistedCorrection) fail('formula correction was not persisted back to the document and index');
    if (!pageImage.ok || pageImage.headers.get('content-type') !== 'image/png') fail('original page image is unavailable');
    if (!originalPdf.ok || originalPdf.headers.get('content-type') !== 'application/pdf') fail('original PDF stream is unavailable');
  }
}
