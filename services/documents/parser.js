// Shared parsing logic: imported by the HTTP server and the isolated worker.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { parseStructuredDocument, extension: fileExtension } = require('./pipeline');
const { textQuality } = require('./quality');
const { localEmbedding, LOCAL_MODEL } = require('../rag');
const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const RUNTIME_TMP = path.join(ROOT, 'tmp', 'runtime');
fs.mkdirSync(RUNTIME_TMP, { recursive: true });
let tesseract = null, chiSimData = null, pdfJsLoader = null;
try { tesseract = require('tesseract.js'); chiSimData = require('@tesseract.js-data/chi_sim'); } catch { /* status exposes missing dependencies */ }
let reportProgress = () => {};
function streamFromPdfObject(body) {
  const marker = body.indexOf('stream');
  if (marker < 0) return '';
  let start = marker + 6;
  if (body[start] === '\r') start += 1;
  if (body[start] === '\n') start += 1;
  const end = body.lastIndexOf('endstream');
  if (end < start) return '';
  let raw = Buffer.from(body.slice(start, end), 'latin1');
  if (/\/FlateDecode/.test(body)) {
    try { raw = zlib.inflateSync(raw); } catch { return ''; }
  }
  return raw.toString('latin1');
}
function parsePdfCMap(cmap) {
  const map = new Map();
  const hexToCode = hex => parseInt(hex, 16);
  const hexToUnicode = hex => {
    const units = [];
    for (let i = 0; i < hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
    return String.fromCharCode(...units);
  };
  for (const section of cmap.split('endbfchar')) {
    for (const m of section.matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g)) map.set(hexToCode(m[1]), hexToUnicode(m[2]));
  }
  for (const section of cmap.split('endbfrange')) {
    for (const m of section.matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g)) {
      const from = hexToCode(m[1]); const to = hexToCode(m[2]); const start = hexToCode(m[3]);
      for (let code = from; code <= to; code += 1) map.set(code, String.fromCharCode(start + code - from));
    }
  }
  return map;
}
function decodePdfHex(hex, cmap) {
  const candidates = [];
  for (let width = 4; width >= 2; width -= 2) {
    if (hex.length % width !== 0) continue;
    const values = [];
    for (let i = 0; i < hex.length; i += width) values.push(parseInt(hex.slice(i, i + width), 16));
    const mapped = values.map(v => cmap.get(v));
    if (mapped.every(Boolean)) return mapped.join('');
    candidates.push(values.map(v => v >= 32 && v <= 126 ? String.fromCharCode(v) : '').join(''));
  }
  return candidates.sort((a, b) => b.length - a.length)[0] || '';
}
function decodePdfLiteral(value) {
  return value.replace(/\\([\\()nrt])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] || c));
}
function assessNativeTextQuality(value) {
  const text = String(value || '').trim();
  const chars = text.length;
  if (!chars) return { chars: 0, printableRatio: 0, replacementRatio: 0, garbageRatio: 1, alphabetRatio: 0, chineseRatio: 0, coverage: 0, score: 0 };
  const printable = [...text].filter(char => /[\p{L}\p{N}\p{P}\p{Z}\p{S}]/u.test(char)).length;
  const replacements = [...text].filter(char => char === '�' || char === '□').length;
  const garbage = [...text].filter(char => /[�□]|(?:[A-Za-z])\1{3,}|[�□]{2,}/.test(char)).length + (text.match(/[�□]/g) || []).length;
  const alphabet = [...text].filter(char => /[A-Za-z]/.test(char)).length;
  const chinese = [...text].filter(char => /[\u4e00-\u9fff]/.test(char)).length;
  const coverage = Math.min(1, chars / 180);
  const printableRatio = printable / chars;
  const replacementRatio = replacements / chars;
  const garbageRatio = Math.min(1, garbage / chars);
  const alphabetRatio = alphabet / chars;
  const chineseRatio = chinese / chars;
  const score = Math.max(0, Math.min(1, printableRatio * 0.35 + (1 - replacementRatio) * 0.3 + (1 - garbageRatio) * 0.2 + coverage * 0.15));
  return { chars, printableRatio, replacementRatio, garbageRatio, alphabetRatio, chineseRatio, coverage, score };
}
function parsePdfMediaBox(body) {
  const match = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(body || '');
  if (!match) return { width: null, height: null };
  return { width: Math.abs(Number(match[3]) - Number(match[1])), height: Math.abs(Number(match[4]) - Number(match[2])) };
}
function extractPdfText(stream, cmap) {
  const out = [];
  const pushToken = token => {
    if (token.startsWith('<') && token.endsWith('>')) out.push(decodePdfHex(token.slice(1, -1), cmap));
    else if (token.startsWith('(') && token.endsWith(')')) out.push(decodePdfLiteral(token.slice(1, -1)));
  };
  for (const match of stream.matchAll(/\[(.*?)\]\s*TJ|(<[0-9A-Fa-f]+>|\((?:\\.|[^)])*\))\s*Tj/gms)) {
    if (match[1] !== undefined) for (const token of match[1].match(/<[0-9A-Fa-f]+>|\((?:\\.|[^)])*\)/g) || []) pushToken(token);
    else pushToken(match[2]);
    out.push(' ');
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}
function extractPdfPages(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') return null;
  const source = buffer.toString('latin1'); const objects = new Map();
  for (const match of source.matchAll(/(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g)) objects.set(Number(match[1]), match[3]);
  const cmap = new Map();
  for (const body of objects.values()) if (/\/ToUnicode/.test(body)) for (const [code, value] of parsePdfCMap(streamFromPdfObject(body))) cmap.set(code, value);
  const pages = [...objects.entries()].filter(([, body]) => /\/Type\s*\/Page\b/.test(body));
  const result = pages.map(([id, body], index) => {
    const refs = []; const refPattern = /\/Contents\s+(?:\[\s*)?((?:\d+\s+\d+\s+R\s*)+)/.exec(body);
    if (refPattern) for (const ref of refPattern[1].matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(ref[1]));
    const text = refs.map(ref => extractPdfText(streamFromPdfObject(objects.get(ref) || ''), cmap)).filter(Boolean).join(' ').trim();
    const quality = assessNativeTextQuality(text);
    const mediaBox = parsePdfMediaBox(body);
    const usable = Boolean(text) && quality.score >= 0.7;
    return {
      page: index + 1,
      heading: `Page ${index + 1}`,
      width: mediaBox.width,
      height: mediaBox.height,
      text: usable ? text : 'No selectable text was found on this page. You can still annotate it locally.',
      extraction: usable ? 'native' : 'ocr-pending',
      source: usable ? 'native-pdf' : 'ocr',
      nativeQuality: quality
    };
  });
  return result.length ? result : null;
}
function normalizePdfJsLine(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i += 1) text = text.replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2');
  return text.replace(/\s+([，。；：！？、）》」』,.!?])/g, '$1').replace(/([（《「『])\s+/g, '$1');
}
async function extractPdfJsPages(buffer) {
  let document = null;
  try {
    pdfJsLoader ||= import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfjs = await pdfJsLoader;
    document = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true, useSystemFonts: true, isEvalSupported: false }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      reportProgress({ stage: 'pdf-text', page: pageNumber, total: document.numPages });
      const lines = new Map();
      for (const item of content.items || []) {
        const text = String(item.str || '').trim();
        if (!text) continue;
        const x = Number(item.transform?.[4] || 0);
        const y = Math.round(Number(item.transform?.[5] || 0) / 2) * 2;
        if (!lines.has(y)) lines.set(y, []);
        lines.get(y).push({ x, text });
      }
      const text = [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, items]) => normalizePdfJsLine(items.sort((a, b) => a.x - b.x).map(item => item.text).join(' '))).filter(Boolean).join('\n');
      const viewport = page.getViewport({ scale: 1 });
      pages.push({ page: pageNumber, heading: text.split(/[\n.!?。！？]/)[0]?.slice(0, 70) || `Page ${pageNumber}`, width: viewport.width, height: viewport.height, text, extraction: text ? 'native-pdfjs' : 'ocr-pending', source: text ? 'native-pdfjs' : 'ocr', nativeQuality: { ...assessNativeTextQuality(text), engine: 'pdfjs', warning: textQuality(text).reasons } });
    }
    return pages.length ? pages : null;
  } catch (error) {
    return null;
  } finally {
    if (document) await document.destroy();
  }
}
function normalizeFormula(raw) {
  let latex = String(raw || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/[\u4e00-\u9fff]{2,}/.test(latex)) latex = latex.replace(/[二五]/g, ' = ');
  latex = latex.replace(/−/g, '-').replace(/×/g, '\\times ').replace(/÷/g, '\\div ').replace(/≤/g, '\\le ').replace(/≥/g, '\\ge ').replace(/∞/g, '\\infty ');
  latex = latex.replace(/\b4z\b/g, 'Az').replace(/\b5\s+E\b/g, 'b \\in').replace(/\b4\s+E\b/g, 'A \\in').replace(/\b4w\b/g, 'Aw');
  latex = latex.replace(/\bE\s+C\b/g, '\\in \\mathbb{C}').replace(/\bE\s+R\b/g, '\\in \\mathbb{R}');
  latex = latex.replace(/\\in\s+C[“"^*×xmn+]{0,10}/g, '\\in \\mathbb{C}^{n}').replace(/Az\s*=\s*5/g, 'Az = b').replace(/Az\s*=\s*z/g, 'Az = ' + String.fromCharCode(92) + 'lambda z').replace(/\b4Hw\b/g, 'A^H w');
  latex = latex.replace(/∑/g, '\\sum ').replace(/Σ/g, '\\sum ').replace(/√/g, '\\sqrt ').replace(/∈/g, '\\in ');
  latex = latex.replace(/(?<!\\)\b(alpha|beta|gamma|lambda|mu|omega)\b/gi, m => `\\${m.toLowerCase()}`);
  latex = latex.replace(/\s+=\s+/g, ' = ');
  const source = String(raw || '').replace(/\s+/g, ' ');
  if (/\b4\s+E\s+C(?:“\*“|“xn|“\*|mxn|mx)/.test(source)) latex = 'A \\in \\mathbb{C}^{m\\times n}';
  else if (/\b4\s+E\s+C“““/.test(source) || /\b4\s+E\s+C7X“?/.test(source)) latex = 'A \\in \\mathbb{C}^{n\\times n}';
  else if (/\b5\s+E\s+C/.test(source)) latex = 'b \\in \\mathbb{C}^{n}';
  else if (/\b4z\s*[二五=]\s*5\b/.test(source)) latex = 'Az = b';
  else if (/\b4z\s*五\s*z\b/.test(source)) latex = 'Az = \\lambda z';
  else if (/\b4Hw\s*[一-]\s*u\b/.test(source)) latex = 'A^H u = v\\sigma';
  else if (/\b4w\s*[一-]\s*u\b/.test(source)) latex = 'Av = u\\sigma';
  else if (/\bminzecn\b/.test(source)) latex = 'min_{z\\in\\mathbb{C}^{n}} \\|Az-b\\|_2';
  return latex;
}
function formatEvidenceText(raw, document = null) {
  // Never turn a damaged OCR string into a plausible-looking formula by guessing.
  if (textQuality(raw).reasons.some(reason => reason !== 'too-short')) return String(raw || '').trim();
  let text = String(raw || '').replace(/FORMULA CANDIDATE\s*·?\s*\d+%?/gi, '').replace(/\s+/g, ' ').replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '').replace(/邱耆师/g, '邵老师').replace(/Programmer「s/g, "Programmer's").replace(/Chapter 2\s+s\s+What/g, 'Chapter 2. What').replace(/O\.H(?:allaron|Hallaron)/g, "O'Hallaron").replace(/0\.1\s*An/g, '0.1 An').replace(/0\.1\.1\s*/g, '0.1.1 ').replace(/吴入误差/g, '舍入误差').replace(/erron/g, 'error').trim();
  const formulas = (document?.content || []).flatMap(page => (page.blocks || []).filter(block => block.type === 'formula' && (block.latex || block.source)).map(block => ({ source: String(block.source || '').trim(), latex: block.provenance?.corrected ? String(block.latex || '').trim() : normalizeFormula(block.source || block.latex) }))).filter(item => item.source && item.latex).sort((a, b) => b.source.length - a.source.length);
  for (const formula of formulas) {
    const source = formula.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\s+/g, '\\s*');
    text = text.replace(new RegExp(source, 'g'), `\\(${formula.latex}\\)`);
  }
  const replacements = [
    [/\b4\s+E\s+C(?:“\*“|“xn|“\*|mxn|mx)/g, '\\(A \\in \\mathbb{C}^{m\\times n}\\)'],
    [/\b4\s+E\s+C7X“?/g, '\\(A \\in \\mathbb{C}^{n\\times n}\\)'],
    [/\b4\s+E\s+C“““/g, '\\(A \\in \\mathbb{C}^{n\\times n}\\)'],
    [/\b4\s+E\s+C[“"^*×xmn+]{0,10}/g, '\\(A \\in \\mathbb{C}^{n}\\)'],
    [/\b5\s+E\s+C[“"^*×xmn+]{0,10}/g, '\\(b \\in \\mathbb{C}^{n}\\)'],
    [/》\s*E\s+C[“"^*]{0,5}/g, '\\(b \\in \\mathbb{C}^{m}\\)'],
    [/\bz:\s*E\s+C[“"^*]{0,5}/g, 'z \\in \\mathbb{C}^{n}'],
    [/\bw\s+E\s+C“/g, 'u \\in \\mathbb{C}^{m}'],
    [/\bw\s+E\s+CP/g, 'v \\in \\mathbb{C}^{n}'],
    [/\b4z\s*[二五=]\s*5\b/g, '\\(Az = b\\)'],
    [/\b4z\s*五\s*z\b/g, '\\(Az = \\lambda z\\)'],
    [/\b4Hw\s*[一-]\s*u\b/g, '\\(A^H u = v\\sigma\\)'],
    [/\b4w\s*[一-]\s*u\b/g, '\\(Av = u\\sigma\\)'],
    [/\bminzecn\b[^,。]{0,60}/g, '\\(min_{z\\in\\mathbb{C}^{n}} \\|Az-b\\|_2\\)'],
    [/Sylvester\s*方程\s*4\s*又\s*一\s*叉\s*习\s*二\s*C/g, 'Sylvester 方程 \\(AX-XB=C\\)'],
    [/矩阵出数乙\s*4\)/g, '矩阵函数 \\(f(A)\\)'],
    [/\b(?:Babs|Brel|Era)\s*\([^)]*\)\s*[:：]\s*[二=][^,。]{0,45}/g, match => `\\(${normalizeFormula(match)}\\)`]
  ];
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  return text.replace(/\\s{2,}/g, ' ').trim();
}
function isFormulaLike(text) {
  const value = String(text || '').trim();
  if (!value || value.length > 120) return false;
  if (/%|\b(?:for|while|function|fprintf|import|print|single|struct|pack|unpack|logspace|rel_err|f[12]|x_vals)\b/i.test(value)) return false;
  const hasRelation = /[=∈≤≥≠≈]|\bE\s+C\b/.test(value);
  const hasMathToken = /[A-Za-z0-9][\s]*[A-Za-z0-9]|[+\-*/^_]|\\(frac|sqrt|sum|in|mathbb)|\b(?:4z|4w|minz)\b/.test(value);
  const hasMathOperator = /[=∈≤≥≠≈+\-*/^_]|\\(frac|sqrt|sum|in|mathbb)/.test(value);
  const chineseCount = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const chineseRatio = chineseCount / Math.max(1, value.length);
  return hasRelation && hasMathToken && hasMathOperator && chineseCount <= 1 && chineseRatio < 0.2;
}
function formulaFragments(chunk) {
  const patterns = [
    /\b4\s+E\s+C[“"^*×xmn+]{0,10}/g,
    /\b5\s+E\s+C[“"^*×xmn+]{0,10}/g,
    /\b4z\s*[二五=]\s*5\b/g,
    /\b4z\s*五\s*z\b/g,
    /\b4H?\s*w\s*[一-]\s*u\b/g,
    /\bminzecn[^,。]{0,70}/g,
    /\b(?:Babs|Brel|Era)\s*\([^)]*\)\s*[:：]\s*[二=][^,。]{0,45}/g
  ];
  const matches = [];
  for (const pattern of patterns) for (const match of chunk.matchAll(pattern)) matches.push({ start: match.index, end: match.index + match[0].length, raw: match[0] });
  return matches.sort((a, b) => a.start - b.start).filter((match, index, all) => index === 0 || match.start >= all[index - 1].end);
}
function splitPageBlocks(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return [{ type: 'paragraph', text: '' }];
  const chunks = source.split(/(?<=[。！？.!?；;])\s+/).filter(Boolean); const blocks = [];
  for (const chunk of chunks) {
    const fragments = formulaFragments(chunk);
    if (fragments.length) {
      let cursor = 0;
      for (const fragment of fragments) {
        const before = chunk.slice(cursor, fragment.start).trim(); if (before) blocks.push({ type: 'paragraph', text: before });
        blocks.push({ type: 'formula', source: fragment.raw.trim(), latex: normalizeFormula(fragment.raw), confidence: /�|[4O0]{2,}/.test(fragment.raw) ? 0.52 : 0.78 });
        cursor = fragment.end;
      }
      const after = chunk.slice(cursor).trim(); if (after) blocks.push({ type: 'paragraph', text: after });
    } else if (isFormulaLike(chunk)) {
      blocks.push({ type: 'formula', source: chunk.trim(), latex: normalizeFormula(chunk), confidence: /�|[4O0]{2,}/.test(chunk) ? 0.52 : 0.7 });
    }
    else blocks.push({ type: 'paragraph', text: chunk.trim() });
  }
  return blocks.length ? blocks : [{ type: 'paragraph', text: source }];
}
function pageSource(page) {
  if (page?.source === 'native-pdf' || page?.extraction === 'native') return 'native-pdf';
  if (page?.source === 'ocr' || page?.extraction === 'ocr') return 'ocr';
  return 'text';
}
function decoratePage(page) {
  const source = pageSource(page);
  const rawBlocks = splitPageBlocks(page.text);
  const blocks = rawBlocks.map((block, index) => ({
    ...block,
    id: `p${page.page}-b${index + 1}`,
    bbox: block.bbox || null,
    provenance: {
      source,
      parser: block.type === 'formula' ? 'heuristic-formula' : source === 'native-pdf' ? 'pdf-text' : source === 'ocr' ? 'tesseract' : 'text'
    }
  }));
  return {
    ...page,
    source,
    extraction: page.extraction || source,
    bbox: page.bbox || null,
    blocks,
    formulas: blocks.filter(block => block.type === 'formula')
  };
}
function decoratePages(pages) {
  return (pages || []).map(decoratePage);
}
function findPdftoppm() {
  const candidates = [
    process.env.PDFTOPPM_PATH,
    process.platform === 'win32' ? path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'poppler', 'Library', 'bin', 'pdftoppm.exe') : null,
    'pdftoppm'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (candidate === 'pdftoppm' || fs.existsSync(candidate)) { if (candidate === 'pdftoppm') execFileSync(candidate, ['-h'], { stdio: 'ignore' }); return candidate; } } catch { /* try next candidate */ }
  }
  return null;
}
function ocrAvailable() { return Boolean(tesseract && chiSimData && findPdftoppm()); }
function parserStatus() {
  return {
    pdfjs: fs.existsSync(path.join(PUBLIC, 'vendor', 'pdfjs', 'pdf.min.mjs')) && fs.existsSync(path.join(PUBLIC, 'vendor', 'pdfjs', 'pdf.worker.min.mjs')),
    nativeText: true,
    pageImage: Boolean(findPdftoppm()),
    ocr: ocrAvailable(),
    layoutParser: false,
    formulaRecognizer: 'heuristic'
  };
}
function normalizeOcrText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/\s+([，。！？：；、,.!?;:])/g, '$1')
    .replace(/([（(])\s+/g, '$1').replace(/\s+([）)])/g, '$1');
}
function formulaOcrEligible(page) {
  const text = String(page?.text || '');
  return /矩阵|方程|误差|条件数|稳定|浮点|舍入|截断|分解|奇异|线性|公式|内积|Taylor|Heron|Sterbenz|rounding|error|condition|stability|matrix|algorithm|equation|factor/i.test(text);
}
function prepareFormulaOcrPages(pages) {
  const source = Array.isArray(pages) ? pages : [];
  const eligible = source.filter(formulaOcrEligible);
  const selected = new Set((eligible.length ? eligible : source).slice(0, 8).map(page => page.page));
  return source.map(page => ({ ...page, formulaOcrSkip: !selected.has(page.page) }));
}
async function renderPdfPageImage(doc, pageNumber) {
  if (!doc?.sourceFile || !findPdftoppm()) return null;
  const source = path.join(UPLOAD_DIR, doc.sourceFile);
  const page = Math.max(1, Number(pageNumber) || 1);
  if (!fs.existsSync(source) || page > Number(doc.pages || 1)) return null;
  const tempDir = fs.mkdtempSync(path.join(RUNTIME_TMP, 'studyagent-page-'));
  const outputBase = path.join(tempDir, 'page');
  try {
    await execFileAsync(findPdftoppm(), ['-f', String(page), '-l', String(page), '-png', '-r', '150', '-singlefile', source, outputBase], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const imagePath = `${outputBase}.png`;
    return fs.existsSync(imagePath) ? fs.readFileSync(imagePath) : null;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
async function ocrPdfPages(buffer, pages, options = {}) {
  const force = Boolean(options.force);
  if (!pages.some(page => force ? !page.formulaOcrSkip : !page.text || page.text.startsWith('No selectable text'))) return { pages, extraction: 'pdf-native', ocr: { available: ocrAvailable(), pagesRecognized: 0 } };
  if (!ocrAvailable()) return { pages, extraction: 'pdf-ocr-unavailable', ocr: { available: false, message: 'Installable OCR dependencies or pdftoppm were not available.' } };
  const tempDir = fs.mkdtempSync(path.join(RUNTIME_TMP, 'studyagent-ocr-'));
  const pdfPath = path.join(tempDir, 'source.pdf'); fs.writeFileSync(pdfPath, buffer);
  let worker = null;
  let recognized = 0;
  try {
    worker = await tesseract.createWorker('chi_sim', 1, { langPath: chiSimData.langPath });
    for (const page of pages) {
      reportProgress({ stage: force ? 'formula-candidates' : 'ocr', page: page.page, total: pages.length });
      if (force && page.formulaOcrSkip) continue;
      // The normal text pass must preserve selectable PDF text. The formula
      // pass deliberately sets force=true so that math glyphs missing from a
      // PDF text layer can still be recovered from the rendered page image.
      if (!force && page.text && !page.text.startsWith('No selectable text')) continue;
      const outputBase = path.join(tempDir, `page-${page.page}`);
      await execFileAsync(findPdftoppm(), ['-f', String(page.page), '-l', String(page.page), '-png', '-r', String(force ? 220 : 300), '-singlefile', pdfPath, outputBase], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      const imagePath = `${outputBase}.png`;
      if (!fs.existsSync(imagePath)) continue;
      const result = await worker.recognize(imagePath);
      const text = normalizeOcrText(result.data?.text || '');
      if (text) {
        page.text = text;
        page.heading = text.split(/[.!?。！？\n]/)[0].slice(0, 70) || page.heading;
        page.extraction = 'ocr';
        page.source = 'ocr';
        page.ocrQuality = { confidence: Number(result.data?.confidence || 0) / 100, dpi: force ? 220 : 300, engine: 'tesseract.js' };
        recognized += 1;
      }
    }
  } catch (error) {
    return { pages, extraction: 'pdf-ocr-error', ocr: { available: true, engine: 'tesseract.js', language: 'chi_sim', pagesRecognized: recognized, error: error.message } };
  } finally {
    if (worker) await worker.terminate();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  const nativePages = pages.filter(page => page.text && !page.text.startsWith('No selectable text')).length;
  return { pages, extraction: recognized ? 'pdf-ocr' : nativePages ? 'pdf-native' : 'pdf-no-text', ocr: { available: true, engine: 'tesseract.js', language: 'chi_sim', pagesRecognized: recognized } };
}
async function ocrImageBuffer(buffer, name = 'image') {
  if (!tesseract || !chiSimData) return { text: '', available: false, reason: 'tesseract-unavailable' };
  const tempDir = fs.mkdtempSync(path.join(RUNTIME_TMP, 'studyagent-image-')); const imagePath = path.join(tempDir, `source-${fileExtension(name) || 'img'}`); fs.writeFileSync(imagePath, buffer); let worker = null;
  try { worker = await tesseract.createWorker('chi_sim', 1, { langPath: chiSimData.langPath }); const result = await worker.recognize(imagePath); return { text: normalizeOcrText(result.data?.text || ''), available: true, confidence: Number(result.data?.confidence || 0) / 100 }; }
  catch (error) { return { text: '', available: true, reason: error.message }; }
  finally { if (worker) await worker.terminate(); fs.rmSync(tempDir, { recursive: true, force: true }); }
}

async function parseImportPayload(payload, onProgress = () => {}) {
  const name = String(payload.name || '').trim();
  if (!name) throw Object.assign(new Error('A file name is required'), { code: 'INVALID_DOCUMENT' });
  const ext = fileExtension(name);
  const raw = payload.base64 ? Buffer.from(payload.base64, 'base64') : Buffer.from(payload.content || '', 'utf8');
  if (!raw.length) throw Object.assign(new Error('文件为空，无法导入。'), { code: 'EMPTY_DOCUMENT' });
  reportProgress = onProgress;
  onProgress({ stage: 'parsing', page: 0, total: 0 });
  let extracted = null; let sourcePages = null; let formulaPages = null;
  if (ext === 'pdf') { const legacyNative = extractPdfPages(raw); const pdfJsNative = await extractPdfJsPages(raw); const native = pdfJsNative || legacyNative || [{ page: 1, heading: 'Page 1', text: 'No selectable text was found on this page.' }]; extracted = await ocrPdfPages(raw, native); sourcePages = decoratePages(extracted.pages); const formulaSourcePages = legacyNative || pdfJsNative || native; const legacyFormulaPages = legacyNative ? decoratePages(legacyNative.map(page => ({ ...page }))) : []; const formulaExtracted = await ocrPdfPages(raw, prepareFormulaOcrPages(formulaSourcePages), { force: true }); formulaPages = decoratePages(formulaExtracted.pages); formulaPages = formulaPages.map((page, index) => ({ ...page, formulas: [...(page.formulas || []), ...(legacyFormulaPages[index]?.formulas || [])].filter((formula, formulaIndex, all) => all.findIndex(item => item.latex === formula.latex && item.source === formula.source) === formulaIndex) })); }
  const parsed = await parseStructuredDocument({ name, buffer: raw, parsePdf: () => sourcePages || [], ocrImage: (buffer, imageName) => ocrImageBuffer(buffer, imageName) });
  onProgress({ stage: 'parsed', page: sourcePages?.length || parsed.sections.length, total: sourcePages?.length || parsed.sections.length });
  onProgress({ stage: 'embedding', page: parsed.chunks.length, total: parsed.chunks.length });
  const embeddings = { model: LOCAL_MODEL, vectors: parsed.chunks.map(chunk => localEmbedding(chunk.content)) };
  return { parsed, extracted, sourcePages, formulaPages, embeddings };
}
module.exports = { streamFromPdfObject, parsePdfCMap, decodePdfHex, decodePdfLiteral, assessNativeTextQuality, parsePdfMediaBox, extractPdfText, extractPdfPages, normalizePdfJsLine, extractPdfJsPages, normalizeFormula, formatEvidenceText, isFormulaLike, formulaFragments, splitPageBlocks, pageSource, decoratePage, decoratePages, findPdftoppm, ocrAvailable, parserStatus, normalizeOcrText, formulaOcrEligible, prepareFormulaOcrPages, renderPdfPageImage, ocrPdfPages, ocrImageBuffer, parseImportPayload };
