const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const RUNTIME_TMP = path.join(__dirname, '..', '..', 'tmp', 'runtime');
fs.mkdirSync(RUNTIME_TMP, { recursive: true });

const supported = new Set(['pdf', 'docx', 'doc', 'pptx', 'ppt', 'md', 'markdown', 'txt', 'xlsx', 'xls', 'csv', 'png', 'jpg', 'jpeg', 'webp']);
const LEGACY_OFFICE_TARGETS = { doc: 'docx', ppt: 'pptx', xls: 'xlsx' };
let officeConverterPromise;
function extension(name) { return String(name || '').split('.').pop().toLowerCase(); }
function xmlDecode(value) { return String(value || '').replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (match, numeric, named) => {
  if (numeric) { const point = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric); return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match; }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named.toLowerCase()] || match;
}); }
function xmlText(fragment) { return xmlDecode(String(fragment || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); }
function xmlTexts(fragment) {
  const tokens = String(fragment || '').match(/<(?:a|w|m):t\b[^>]*>[\s\S]*?<\/(?:a|w|m):t>|<t\b[^>]*>[\s\S]*?<\/t>|<(?:w:tab|a:tab)\b[^>]*\/?\s*>|<(?:w:br|a:br|w:cr)\b[^>]*\/?\s*>/gi) || [];
  // OOXML frequently splits a single word or Chinese sentence over formatting runs.
  // Adding a space at every run boundary corrupts both visible text and retrieval.
  return tokens.map(token => {
    if (/^<(?:w:tab|a:tab)\b/i.test(token)) return '\t';
    if (/^<(?:w:br|a:br|w:cr)\b/i.test(token)) return '\n';
    return xmlDecode(token.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, ''));
  }).join('').replace(/[ \t]+\n/g, '\n').trim();
}
function officeParagraphText(fragment, tag) {
  const parts = [...String(fragment || '').matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'))].map(match => xmlTexts(match[0])).filter(Boolean);
  return parts.length ? parts.join('\n') : xmlTexts(fragment);
}
function fileType(ext) { return ext === 'markdown' ? 'MD' : ext.toUpperCase(); }
function metadataFor(name, ext) { return { originalName: name, extension: ext, parser: 'structured-document-pipeline', importedAt: new Date().toISOString() }; }
function section(id, title, content, locator, kind = 'paragraph', position = 0, blocks = []) { return { id, title, content: String(content || '').trim(), locator: locator || {}, kind, position, blocks: Array.isArray(blocks) ? blocks : [] }; }

function splitTextSections(name, text) {
  const ext = extension(name); const sections = []; const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (ext === 'md' || ext === 'markdown') {
    let current = section(`${name}-section-1`, 'Document', '', { position: 0 }, 'document', 0);
    let index = 0;
    for (const line of clean.split('\n')) {
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) { if (current.content) sections.push(current); index += 1; current = section(`${name}-section-${index}`, heading[2], '', { headingLevel: heading[1].length, position: index }, 'heading', index); }
      else if (line.trim()) current.content += `${current.content ? '\n' : ''}${line.trim()}`;
    }
    if (current.content || !sections.length) sections.push(current);
    return sections;
  }
  const paragraphs = clean.split(/\n\s*\n|\f+/).map(value => value.trim()).filter(Boolean);
  return (paragraphs.length ? paragraphs : ['']).map((value, index) => section(`${name}-section-${index + 1}`, `Section ${index + 1}`, value, { paragraph: index + 1 }, 'paragraph', index));
}

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < String(text || '').length; i += 1) { const char = text[i]; if (char === '"' && text[i + 1] === '"' && quoted) { cell += '"'; i += 1; } else if (char === '"') quoted = !quoted; else if (char === ',' && !quoted) { row.push(cell); cell = ''; } else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && text[i + 1] === '\n') i += 1; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += char; }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function ommlToLatex(fragment) {
  const root = { name: 'root', children: [] }; const stack = [root];
  for (const token of String(fragment || '').match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (token.startsWith('<')) {
      if (/^<\?/.test(token) || /^<!/.test(token)) continue;
      const name = token.match(/^<([\w:.-]+)/)?.[1]; if (!name) continue;
      const node = { name: name.split(':').pop(), children: [], attrs: token };
      stack.at(-1).children.push(node);
      if (!/\/\s*>$/.test(token)) stack.push(node);
    } else stack.at(-1).children.push({ name: '#text', text: xmlDecode(token), children: [] });
  }
  const child = (node, name) => node.children.find(item => item.name === name);
  const render = node => {
    if (!node) return '';
    if (node.name === '#text') return node.text;
    const part = name => render(child(node, name));
    if (node.name === 'f') return `\\frac{${part('num')}}{${part('den')}}`;
    if (node.name === 'rad') { const degree = part('deg'); return `\\sqrt${degree && degree !== '2' ? `[${degree}]` : ''}{${part('e')}}`; }
    if (node.name === 'sSup') return `${part('e')}^{${part('sup')}}`;
    if (node.name === 'sSub') return `${part('e')}_{${part('sub')}}`;
    if (node.name === 'sSubSup') return `${part('e')}_{${part('sub')}}^{${part('sup')}}`;
    if (node.name === 'd') return `\\left(${part('e')}\\right)`;
    if (node.name === 'm') return `\\begin{matrix}${node.children.filter(item => item.name === 'mr').map(render).join('\\\\')}\\end{matrix}`;
    if (node.name === 'mr') return node.children.filter(item => item.name === 'e').map(render).join(' & ');
    if (node.name === 't') return node.children.map(render).join('');
    return node.children.filter(item => !['rPr', 'ctrlPr', 'fPr', 'radPr', 'sSupPr', 'sSubPr', 'sSubSupPr', 'dPr', 'mPr', 'argPr'].includes(item.name)).map(render).join('');
  };
  return render(root).trim();
}

function tableRowsFromDocx(fragment) {
  return [...String(fragment || '').matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map(row => [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(cell => officeParagraphText(cell[0], 'w:p'))).filter(row => row.length);
}

function paginateDocxSections(name, sourceSections) {
  const pages = [];
  let current = [];
  let characters = 0;
  const flush = () => {
    if (!current.length) return;
    const pageNumber = pages.length + 1;
    const blocks = current.flatMap(item => item.blocks || []);
    const heading = blocks.find(block => block.type === 'heading' && block.text)?.text;
    const content = current.map(item => item.content).filter(Boolean).join('\n');
    pages.push(section(
      `${name}-page-${pageNumber}`,
      heading || `Page ${pageNumber}`,
      content,
      {
        page: pageNumber,
        paragraphs: current.filter(item => item.kind !== 'table').length,
        tables: current.filter(item => item.kind === 'table').length,
        explicitPageBreak: current.some(item => item.locator?.explicitPageBreak)
      },
      'page',
      pageNumber - 1,
      blocks
    ));
    current = [];
    characters = 0;
  };
  for (const item of sourceSections) {
    const itemLength = String(item.content || '').length;
    const explicitBreak = Boolean(item.locator?.explicitPageBreak);
    const headingStartsPage = item.kind === 'heading' && current.length >= 8 && characters >= 1400;
    const capacityReached = current.length >= 18 || characters + itemLength > 5000;
    if (current.length && (explicitBreak || headingStartsPage || capacityReached)) flush();
    current.push(item);
    characters += itemLength;
  }
  flush();
  return pages;
}

async function unzip(buffer) {
  const tempDir = fs.mkdtempSync(path.join(RUNTIME_TMP, 'studyagent-office-')); const archive = path.join(tempDir, 'source.zip'); fs.writeFileSync(archive, buffer);
  try { await execFileAsync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archive, '-C', tempDir], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); return { tempDir, cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }) }; }
  catch (error) { fs.rmSync(tempDir, { recursive: true, force: true }); const e = new Error('无法解压 Office Open XML 文件；请确认系统提供 tar/ZIP 解压能力。'); e.code = 'OFFICE_ARCHIVE_UNAVAILABLE'; e.cause = error; throw e; }
}
function readFileIfExists(root, relative) { const target = path.join(root, relative); return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''; }
function sortNumbered(files) { return files.sort((a, b) => (Number(a.match(/(\d+)/)?.[1] || 0) - Number(b.match(/(\d+)/)?.[1] || 0))); }

function imageMime(file) {
  const ext = extension(file);
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', emf: 'image/emf', wmf: 'image/wmf' })[ext] || 'application/octet-stream';
}

async function extractOfficePreviewImage(buffer, format, pageNumber = 1, imageIndex = 0) {
  const ext = String(format || '').toLowerCase();
  if (!['docx', 'pptx'].includes(ext)) return null;
  const archive = await unzip(buffer);
  try {
    let target = '';
    if (ext === 'pptx') {
      const slide = Math.max(1, Number(pageNumber) || 1);
      const slideXml = readFileIfExists(archive.tempDir, `ppt/slides/slide${slide}.xml`);
      const relsXml = readFileIfExists(archive.tempDir, `ppt/slides/_rels/slide${slide}.xml.rels`);
      const embedIds = [...slideXml.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/gi)].map(match => match[1]);
      const relationships = new Map([...relsXml.matchAll(/<Relationship\b[^>]*>/gi)].map(match => {
        const id = match[0].match(/\bId="([^"]+)"/i)?.[1];
        const target = match[0].match(/\bTarget="([^"]+)"/i)?.[1];
        return [id, xmlDecode(target)];
      }).filter(([id, value]) => id && value));
      const mediaTarget = embedIds.map(id => relationships.get(id)).filter(value => value && /\.(png|jpe?g|webp|gif|svg|emf|wmf)$/i.test(value))[Math.max(0, Number(imageIndex) || 0)];
      if (mediaTarget) target = path.resolve(archive.tempDir, 'ppt', 'slides', mediaTarget);
    } else {
      const mediaDir = path.join(archive.tempDir, 'word', 'media');
      const files = fs.existsSync(mediaDir) ? sortNumbered(fs.readdirSync(mediaDir).filter(file => /\.(png|jpe?g|webp|gif|svg|emf|wmf)$/i.test(file))) : [];
      if (files.length) target = path.join(mediaDir, files[Math.min(files.length - 1, Math.max(0, Number(pageNumber) - 1 + (Number(imageIndex) || 0)))]);
    }
    const resolvedRoot = path.resolve(archive.tempDir);
    const resolvedTarget = target ? path.resolve(target) : '';
    if (!resolvedTarget || !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`) || !fs.existsSync(resolvedTarget)) return null;
    return { buffer: fs.readFileSync(resolvedTarget), mime: imageMime(resolvedTarget), fileName: path.basename(resolvedTarget) };
  } finally {
    archive.cleanup();
  }
}

async function parseDocx(name, buffer) {
  const archive = await unzip(buffer); try { const xml = readFileIfExists(archive.tempDir, 'word/document.xml'); const body = xml.match(/<w:body[\s\S]*?<\/w:body>/i)?.[0] || xml; const sections = []; let index = 0; let cursor = 0;
    const blockStart = /<(w:p|w:tbl)\b[^>]*>/gi; let match;
    while ((match = blockStart.exec(body))) {
      if (match.index < cursor) continue;
      const tag = match[1].toLowerCase(); const closeTag = `</${tag}>`; const end = body.toLowerCase().indexOf(closeTag, match.index);
      if (end < 0) continue;
      const raw = body.slice(match.index, end + closeTag.length); cursor = end + closeTag.length;
      if (tag === 'w:tbl') {
        const rows = tableRowsFromDocx(raw); if (!rows.length) continue;
        index += 1; const tableBlocks = [{ type: 'table', headers: rows[0], rows: rows.slice(1), source: 'docx' }]; sections.push(section(`${name}-table-${index}`, `Table ${index}`, rows.map(row => row.join(' | ')).join('\n'), { table: index, rows: rows.length, columns: Math.max(...rows.map(row => row.length)) }, 'table', index, tableBlocks)); continue;
      }
      const formulaMatches = [...raw.matchAll(/<m:oMath\b[\s\S]*?<\/m:oMath>/gi)];
      const style = raw.match(/<w:pStyle[^>]*w:val="([^"]+)"/i)?.[1] || ''; const heading = /heading/i.test(style); const listItem = /<w:numPr\b/i.test(raw); const image = /<w:drawing\b|<w:pict\b/i.test(raw); const explicitPageBreak = /<w:lastRenderedPageBreak\b|<w:pageBreakBefore\b|<w:br\b[^>]*w:type="page"/i.test(raw);
      const blocks = []; let offset = 0;
      for (const formula of formulaMatches) {
        const before = xmlTexts(raw.slice(offset, formula.index));
        if (before) blocks.push({ type: heading ? 'heading' : listItem ? 'list-item' : 'paragraph', text: before, style, list: listItem });
        const latex = ommlToLatex(formula[0]);
        blocks.push({ type: 'formula', source: xmlTexts(formula[0]), latex, confidence: latex ? 0.9 : 0.5, sourceFormat: 'OMML', provenance: { source: 'omml', verified: true } });
        offset = formula.index + formula[0].length;
      }
      const after = xmlTexts(raw.slice(offset));
      if (after) blocks.push({ type: heading ? 'heading' : listItem ? 'list-item' : 'paragraph', text: after, style, list: listItem });
      if (image) blocks.push({ type: 'image', alt: blocks.find(block => block.text)?.text || 'Embedded Word image', source: 'docx' });
      if (!blocks.length) continue;
      index += 1;
      const text = blocks.map(block => block.text || block.latex).filter(Boolean).join('');
      const content = blocks.filter(block => block.type !== 'image').map(block => block.text || block.latex).filter(Boolean).join('');
      const formulaCount = formulaMatches.length;
      sections.push(section(`${name}-section-${index}`, heading ? content : `${listItem ? 'List item' : 'Paragraph'} ${index}`, text, { paragraph: index, style, list: listItem, image, formula: formulaCount > 0, explicitPageBreak }, heading ? 'heading' : formulaCount ? 'formula' : listItem ? 'list-item' : image ? 'image' : 'paragraph', index, blocks));
    }
    const mediaDir = path.join(archive.tempDir, 'word', 'media'); const hasImages = fs.existsSync(mediaDir) && fs.readdirSync(mediaDir).length > 0;
    const paginated = sections.length ? paginateDocxSections(name, sections) : splitTextSections(name, xmlText(xml));
    return { sections: paginated, metadata: { format: 'docx', structured: true, hasTables: /<w:tbl/.test(xml), hasImages, hasFormulas: /<m:oMath/.test(xml), sourceBlockCount: sections.length, pageCount: paginated.length, pagination: 'explicit-breaks-plus-layout-groups' } };
  } finally { archive.cleanup(); }
}

async function parsePptx(name, buffer) {
  const archive = await unzip(buffer);
  try {
    const slideDir = path.join(archive.tempDir, 'ppt', 'slides');
    const files = fs.existsSync(slideDir) ? sortNumbered(fs.readdirSync(slideDir).filter(file => /^slide\d+\.xml$/i.test(file))) : [];
    const sections = files.map((file, index) => {
      const xml = fs.readFileSync(path.join(slideDir, file), 'utf8');
      const elements = [
        ...[...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gi)].map(match => ({ position: match.index, kind: 'shape', raw: match[0] })),
        ...[...xml.matchAll(/<a:tbl\b[\s\S]*?<\/a:tbl>/gi)].map(match => ({ position: match.index, kind: 'table', raw: match[0] })),
        ...[...xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/gi)].map(match => ({ position: match.index, kind: 'image', raw: match[0] }))
      ].sort((a, b) => a.position - b.position);
      const blocks = [];
      for (const element of elements) {
        if (element.kind === 'shape') {
          const text = officeParagraphText(element.raw, 'a:p');
          if (!text) continue;
          const isTitle = /<p:ph\b[^>]*type="(?:title|ctrTitle)"/i.test(element.raw);
          blocks.push({ type: isTitle ? 'heading' : 'paragraph', text, placeholder: isTitle ? 'title' : 'body' });
        } else if (element.kind === 'table') {
          const rows = [...element.raw.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/gi)].map(row => [...row[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/gi)].map(cell => xmlTexts(cell[0]))).filter(row => row.length);
          if (rows.length) blocks.push({ type: 'table', headers: rows[0], rows: rows.slice(1), source: 'pptx' });
        } else blocks.push({ type: 'image', alt: xmlTexts(element.raw) || `Slide ${index + 1} image`, source: 'pptx' });
      }
      const notes = readFileIfExists(archive.tempDir, `ppt/notesSlides/notesSlide${index + 1}.xml`);
      const notesText = xmlTexts(notes);
      if (notesText) blocks.push({ type: 'note', text: `Notes: ${notesText}` });
      if (!blocks.length) blocks.push({ type: 'paragraph', text: xmlTexts(xml) });
      const title = blocks.find(item => item.type === 'heading')?.text || `Slide ${index + 1}`;
      const content = blocks.map(item => item.type === 'table' ? [item.headers, ...item.rows].map(row => row.join(' | ')).join('\n') : item.text || item.alt || '').filter(Boolean).join('\n');
      return section(`${name}-slide-${index + 1}`, title, content, { slide: index + 1, source: file, notes: Boolean(notesText), shapes: blocks.filter(item => ['heading', 'paragraph'].includes(item.type)).length, tables: blocks.filter(item => item.type === 'table').length, images: blocks.filter(item => item.type === 'image').length }, 'slide', index, blocks);
    });
    return { sections: sections.length ? sections : splitTextSections(name, ''), metadata: { format: 'pptx', structured: true, slideCount: files.length, hasNotes: sections.some(item => item.locator.notes), hasTables: sections.some(item => item.locator.tables > 0), hasImages: sections.some(item => item.locator.images > 0) } };
  } finally { archive.cleanup(); }
}

async function parseXlsx(name, buffer) {
  const archive = await unzip(buffer); try { const sharedXml = readFileIfExists(archive.tempDir, 'xl/sharedStrings.xml'); const shared = [...sharedXml.matchAll(/<si[\s\S]*?<\/si>/g)].map(match => xmlTexts(match[0])); const workbook = readFileIfExists(archive.tempDir, 'xl/workbook.xml'); const sheetNames = [...workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"/gi)].map(match => xmlDecode(match[1])); const sheetDir = path.join(archive.tempDir, 'xl', 'worksheets'); const files = fs.existsSync(sheetDir) ? sortNumbered(fs.readdirSync(sheetDir).filter(file => /^sheet\d+\.xml$/i.test(file))) : []; const sections = files.map((file, index) => { const xml = fs.readFileSync(path.join(sheetDir, file), 'utf8'); const rows = [...xml.matchAll(/<row\b[^>]*>[\s\S]*?<\/row>/g)].map(row => [...row[0].matchAll(/<c\b([^>]*)>[\s\S]*?<\/c>/g)].map(cell => { const attrs = cell[1]; const body = cell[0]; const ref = attrs.match(/\br="([^"]+)"/)?.[1] || ''; const type = attrs.match(/\bt="([^"]+)"/)?.[1] || 'n'; const rawValue = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || ''; const value = type === 's' ? (shared[Number(rawValue)] || '') : type === 'inlineStr' ? xmlTexts(body.match(/<is>[\s\S]*?<\/is>/)?.[0] || '') : type === 'b' ? (rawValue === '1' ? 'TRUE' : 'FALSE') : xmlDecode(rawValue); const formula = body.match(/<f[^>]*>([\s\S]*?)<\/f>/)?.[1] || ''; return { ref, value, formula, type }; })).filter(row => row.length); const headers = rows[0]?.map(cell => cell.value) || []; const content = rows.map(row => row.map(cell => `${cell.ref ? `${cell.ref}=` : ''}${cell.value}${cell.formula ? ` [formula: ${cell.formula}]` : ''}`).join('\t')).join('\n'); const blocks = [{ type: 'table', headers, rows: rows.slice(1), source: 'xlsx', cellCount: rows.reduce((count, row) => count + row.length, 0) }]; return section(`${name}-sheet-${index + 1}`, sheetNames[index] || `Sheet ${index + 1}`, content, { sheet: index + 1, sheetName: sheetNames[index] || `Sheet ${index + 1}`, source: file, rows: rows.length, columns: Math.max(0, ...rows.map(row => row.length)), headers, cellTypes: [...new Set(rows.flat().map(cell => cell.type))] }, 'sheet', index, blocks); }); return { sections: sections.length ? sections : splitTextSections(name, ''), metadata: { format: 'xlsx', structured: true, sheetCount: files.length, sheetNames } }; } finally { archive.cleanup(); }
}

async function findOfficeConverter() {
  if (!officeConverterPromise) officeConverterPromise = (async () => {
    const candidates = [process.env.STUDYAGENT_OFFICE_CONVERTER, 'soffice', 'libreoffice'].filter(Boolean);
    for (const candidate of candidates) {
      if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
      try { await execFileAsync(candidate, ['--version'], { windowsHide: true, timeout: 2500, maxBuffer: 256 * 1024 }); return candidate; } catch { /* try the next converter */ }
    }
    return null;
  })();
  return officeConverterPromise;
}

async function legacyOfficeStatus() {
  const converter = await findOfficeConverter();
  return { available: Boolean(converter), command: converter, formats: Object.keys(LEGACY_OFFICE_TARGETS).map(value => value.toUpperCase()), mode: converter ? 'convert-to-ooxml' : 'printable-run-fallback' };
}

async function convertLegacyOffice(name, buffer, ext) {
  const targetExtension = LEGACY_OFFICE_TARGETS[ext];
  const converter = targetExtension ? await findOfficeConverter() : null;
  if (!converter) return null;
  const tempDir = fs.mkdtempSync(path.join(RUNTIME_TMP, 'studyagent-legacy-office-'));
  const sourcePath = path.join(tempDir, `source.${ext}`);
  try {
    fs.writeFileSync(sourcePath, buffer);
    await execFileAsync(converter, ['--headless', '--convert-to', targetExtension, '--outdir', tempDir, sourcePath], { windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    const convertedPath = path.join(tempDir, `source.${targetExtension}`);
    if (!fs.existsSync(convertedPath)) return null;
    const parsed = await parseStructuredDocument({ name: `source.${targetExtension}`, buffer: fs.readFileSync(convertedPath) });
    return { ...parsed, metadata: { ...parsed.metadata, format: fileType(ext), originalName: name, originalExtension: ext, convertedTo: targetExtension.toUpperCase(), conversion: 'office-converter' } };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function printableRuns(value) { return [...String(value || '').matchAll(/[\u0020-\u007e\u4e00-\u9fff]{3,}/g)].map(match => match[0].replace(/\s+/g, ' ').trim()).filter(value => value.length >= 3 && !/^([A-F0-9]{8,}|Microsoft|Normal|Root Entry)$/i.test(value)); }
function legacyOfficeText(buffer) { const candidates = [buffer.toString('utf8'), buffer.toString('latin1'), buffer.toString('utf16le')]; const values = []; const seen = new Set(); for (const candidate of candidates) for (const value of printableRuns(candidate)) { if (!seen.has(value)) { seen.add(value); values.push(value); } } return values.slice(0, 200).join('\n').trim(); }
function legacyOfficeSections(name, buffer) { const text = legacyOfficeText(buffer); const paragraphs = text.split(/\r?\n+|(?<=[。！？.!?])\s+/).map(value => value.trim()).filter(Boolean).slice(0, 80); return (paragraphs.length ? paragraphs : ['此旧版 Office 文件已保存，但当前运行时未提供完整二进制 Office 解析器。']).map((value, index) => section(`${name}-legacy-${index + 1}`, `Legacy paragraph ${index + 1}`, value, { legacyBinary: true, paragraph: index + 1 }, 'legacy', index)); }
function verifiedFormula(block) { return block?.type === 'formula' && Boolean(block.provenance?.corrected || block.provenance?.source === 'mathpix' || block.sourceFormat === 'OMML'); }
function blockContent(block) { if (!block || typeof block !== 'object') return ''; if (block.type === 'formula') return verifiedFormula(block) ? [block.latex, block.source].filter(Boolean).join(' | ') : ''; if (block.type === 'table') return [[...(block.headers || [])], ...(block.rows || [])].map(row => (Array.isArray(row) ? row : []).map(cell => typeof cell === 'object' && cell !== null ? `${cell.ref ? `${cell.ref}=` : ''}${cell.value ?? cell.text ?? cell.formula ?? ''}` : String(cell ?? '')).join(' | ')).filter(Boolean).join('\n'); return String(block.text || block.content || block.alt || block.source || '').trim(); }
async function parseStructuredDocument({ name, buffer, parsePdf, ocrImage, visionImage }) {
  const ext = extension(name); if (!supported.has(ext)) { const error = new Error(`暂不支持 ${ext || 'unknown'} 文件格式`); error.code = 'UNSUPPORTED_FILE_TYPE'; throw error; }
  const type = fileType(ext); let parsed;
  if (ext === 'pdf') parsed = { sections: (parsePdf ? parsePdf(buffer) : []).map((page, index) => { const blocks = Array.isArray(page.blocks) ? page.blocks : []; const formulaText = blocks.filter(verifiedFormula).map(block => block.latex || block.source).filter(Boolean); const content = [page.text, ...formulaText].filter(Boolean).join('\n'); return section(`${name}-page-${page.page || index + 1}`, page.heading || `Page ${page.page || index + 1}`, content, { page: page.page || index + 1, bbox: page.bbox || null, extraction: page.extraction || page.source || null, formulaCount: formulaText.length, unverifiedFormulaCount: blocks.filter(block => block.type === 'formula' && !verifiedFormula(block)).length }, page.type === 'formula' ? 'formula' : 'page', index, blocks); }), metadata: { format: 'pdf', structured: true } };
  else if (ext === 'docx') parsed = await parseDocx(name, buffer);
  else if (ext === 'pptx') parsed = await parsePptx(name, buffer);
  else if (ext === 'xlsx') parsed = await parseXlsx(name, buffer);
  else if (ext === 'csv') { const rows = parseCsv(buffer.toString('utf8')); parsed = { sections: [section(`${name}-sheet-1`, 'CSV', rows.map(row => row.join('\t')).join('\n'), { sheet: 1, rows: rows.length, columns: rows[0]?.length || 0, headers: rows[0] || [] }, 'sheet', 0, [{ type: 'table', headers: rows[0] || [], rows: rows.slice(1).map(row => row.map(value => ({ value, type: value !== '' && !Number.isNaN(Number(value)) ? 'number' : 'string' }))), source: 'csv' }])], metadata: { format: 'csv', structured: true, rows: rows.length, columns: rows[0]?.length || 0 } }; }
  else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) { const ocr = ocrImage ? await ocrImage(buffer, name) : { text: '', available: false }; const vision = visionImage ? await visionImage(buffer, name) : null; const visionText = String(vision?.text || vision?.answer || '').trim(); const blocks = [{ type: 'image', alt: name, source: type }, ...(ocr.text ? [{ type: 'paragraph', text: ocr.text, source: 'ocr' }] : []), ...(visionText ? [{ type: 'vision', text: visionText, source: 'vision', provider: vision.provider, model: vision.model }] : [])]; const content = [ocr.text, visionText].filter(Boolean).join('\n') || '未获得可提取的图片文字。'; parsed = { sections: [section(`${name}-image-1`, 'Image OCR', content, { image: 1, ocr: Boolean(ocr.text), vision: Boolean(visionText), visionProvider: vision?.provider || null, visionModel: vision?.model || null }, 'image', 0, blocks)], metadata: { format: type, structured: true, ocr: ocr.available, vision: Boolean(visionText), visionDescription: visionText ? 'persisted-vision-result' : 'requires-configured-vision-provider', visionError: vision?.error || null } }; }
  else if (ext === 'doc' || ext === 'ppt' || ext === 'xls') {
    let converted = null; let conversionError = null;
    try { converted = await convertLegacyOffice(name, buffer, ext); } catch (error) { conversionError = error; }
    if (converted) parsed = converted;
    else {
      // A binary OLE Office file is not text. Indexing incidental printable bytes
      // would make the document look imported while silently corrupting study data.
      if (buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) {
        const error = new Error(`旧版 ${type} 需要安装 LibreOffice 转换器，或先在 WPS/Office 中另存为 ${LEGACY_OFFICE_TARGETS[ext].toUpperCase()} 再导入。`);
        error.code = 'OFFICE_CONVERTER_REQUIRED'; error.cause = conversionError; throw error;
      }
      const sections = legacyOfficeSections(name, buffer);
      parsed = { sections, metadata: { format: type, structured: false, warning: 'legacy-binary-parser-limited', textExtraction: 'printable-run-fallback', conversion: 'unavailable-or-failed', conversionError: conversionError?.message || null } };
    }
  }
  else parsed = { sections: splitTextSections(name, buffer.toString('utf8')), metadata: { format: type, structured: true } };
  const sections = parsed.sections.filter(item => item.content || item.kind === 'image').map((item, index) => ({ ...item, locator: { ...(item.locator || {}), page: Number(item.locator?.page || item.locator?.slide || item.locator?.sheet || index + 1) } })); const chunks = []; for (const item of sections) { const paragraphs = item.content.split(/\n{2,}|(?<=[。！？.!?])\s+/).map(value => value.trim()).filter(Boolean); let current = ''; let index = 0; for (const paragraph of paragraphs.length ? paragraphs : ['']) { if (current && current.length + paragraph.length + 1 > 900) { chunks.push({ id: `${item.id}-chunk-${index++}`, sectionId: item.id, content: current, chunkIndex: index, metadata: { ...item.locator, title: item.title, kind: item.kind } }); current = ''; } current += `${current ? '\n' : ''}${paragraph}`; } if (current) chunks.push({ id: `${item.id}-chunk-${index++}`, sectionId: item.id, content: current, chunkIndex: index, metadata: { ...item.locator, title: item.title, kind: item.kind } }); }
  for (const item of sections) { const blocks = (item.blocks || []).map((block, index) => ({ block, index, content: blockContent(block) })).filter(entry => entry.content); if (!blocks.length) continue; for (let index = chunks.length - 1; index >= 0; index -= 1) if (chunks[index].sectionId === item.id) chunks.splice(index, 1); for (const entry of blocks) chunks.push({ id: `${item.id}-block-${entry.index}`, sectionId: item.id, content: entry.content, chunkIndex: entry.index, metadata: { ...item.locator, title: item.title, kind: item.kind, blockType: entry.block.type || 'paragraph', blockIndex: entry.index } }); }
  return { fileType: type, sections, chunks, metadata: { ...metadataFor(name, ext), ...parsed.metadata } };
}

module.exports = { supported, extension, parseStructuredDocument, legacyOfficeStatus, paginateDocxSections, extractOfficePreviewImage };
