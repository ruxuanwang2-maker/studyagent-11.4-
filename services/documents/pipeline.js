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
function xmlDecode(value) { return String(value || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"); }
function xmlText(fragment) { return xmlDecode(String(fragment || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); }
function xmlTexts(fragment) { return [...String(fragment || '').matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>|<w:t[^>]*>([\s\S]*?)<\/w:t>|<t[^>]*>([\s\S]*?)<\/t>/g)].map(match => xmlDecode(match[1] || match[2] || match[3] || '')).join(' ').replace(/\s+/g, ' ').trim(); }
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
  const value = String(fragment || '');
  const child = (tag, source = value) => source.match(new RegExp(`<m:${tag}[^>]*>([\\s\\S]*?)<\\/m:${tag}>`, 'i'))?.[1] || '';
  const text = xmlTexts(value);
  const fraction = value.match(/<m:f[\s\S]*?<m:num>([\s\S]*?)<\/m:num>[\s\S]*?<m:den>([\s\S]*?)<\/m:den>[\s\S]*?<\/m:f>/i);
  if (fraction) return `\\frac{${ommlToLatex(fraction[1])}}{${ommlToLatex(fraction[2])}}`;
  const radical = value.match(/<m:rad[\s\S]*?<m:deg>([\s\S]*?)<\/m:deg>[\s\S]*?<m:e>([\s\S]*?)<\/m:e>[\s\S]*?<\/m:rad>/i);
  if (radical) return `\\sqrt${ommlToLatex(radical[1]) === '2' ? '' : `[${ommlToLatex(radical[1])}]`}{${ommlToLatex(radical[2])}}`;
  const superscript = value.match(/<m:sSup[\s\S]*?<m:e>([\s\S]*?)<\/m:e>[\s\S]*?<m:sup>([\s\S]*?)<\/m:sup>[\s\S]*?<\/m:sSup>/i);
  if (superscript) return `${ommlToLatex(superscript[1])}^{${ommlToLatex(superscript[2])}}`;
  const subscript = value.match(/<m:sSub[\s\S]*?<m:e>([\s\S]*?)<\/m:e>[\s\S]*?<m:sub>([\s\S]*?)<\/m:sub>[\s\S]*?<\/m:sSub>/i);
  if (subscript) return `${ommlToLatex(subscript[1])}_{${ommlToLatex(subscript[2])}}`;
  const base = child('e') || value;
  return xmlTexts(base) || text;
}

function tableRowsFromDocx(fragment) {
  return [...String(fragment || '').matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)].map(row => [...row[0].matchAll(/<w:tc[\s\S]*?<\/w:tc>/g)].map(cell => xmlTexts(cell[0])).filter(Boolean)).filter(row => row.length);
}

async function unzip(buffer) {
  const tempDir = fs.mkdtempSync(path.join(RUNTIME_TMP, 'studyagent-office-')); const archive = path.join(tempDir, 'source.zip'); fs.writeFileSync(archive, buffer);
  try { await execFileAsync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archive, '-C', tempDir], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); return { tempDir, cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }) }; }
  catch (error) { fs.rmSync(tempDir, { recursive: true, force: true }); const e = new Error('无法解压 Office Open XML 文件；请确认系统提供 tar/ZIP 解压能力。'); e.code = 'OFFICE_ARCHIVE_UNAVAILABLE'; e.cause = error; throw e; }
}
function readFileIfExists(root, relative) { const target = path.join(root, relative); return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''; }
function sortNumbered(files) { return files.sort((a, b) => (Number(a.match(/(\d+)/)?.[1] || 0) - Number(b.match(/(\d+)/)?.[1] || 0))); }

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
      const content = xmlTexts(raw); const style = raw.match(/<w:pStyle[^>]*w:val="([^"]+)"/i)?.[1] || ''; const heading = /heading/i.test(style); const listItem = /<w:numPr\b/i.test(raw); const image = /<w:drawing\b|<w:pict\b/i.test(raw); const formulaXml = [...raw.matchAll(/<m:oMath(?:Para)?\b[\s\S]*?<\/m:oMath(?:Para)?>/gi)].map(item => item[0]); const formulaBlocks = formulaXml.map(item => { const latex = ommlToLatex(item); return { type: 'formula', source: xmlTexts(item), latex, confidence: latex ? 0.9 : 0.5, sourceFormat: 'OMML' }; });
      if (!content && !formulaBlocks.length && !image) continue;
      index += 1; const blocks = []; if (content) blocks.push({ type: heading ? 'heading' : listItem ? 'list-item' : 'paragraph', text: content, style, list: listItem }); if (image) blocks.push({ type: 'image', alt: content || 'Embedded Word image', source: 'docx' }); blocks.push(...formulaBlocks); const text = [content, ...formulaBlocks.map(item => item.latex)].filter(Boolean).join('\n'); sections.push(section(`${name}-section-${index}`, heading ? content : heading ? content : `${listItem ? 'List item' : 'Paragraph'} ${index}`, text, { paragraph: index, style, list: listItem, image, formula: formulaBlocks.length > 0 }, heading ? 'heading' : formulaBlocks.length ? 'formula' : listItem ? 'list-item' : image ? 'image' : 'paragraph', index, blocks));
    }
    const mediaDir = path.join(archive.tempDir, 'word', 'media'); const hasImages = fs.existsSync(mediaDir) && fs.readdirSync(mediaDir).length > 0;
    return { sections: sections.length ? sections : splitTextSections(name, xmlText(xml)), metadata: { format: 'docx', structured: true, hasTables: /<w:tbl/.test(xml), hasImages, hasFormulas: /<m:oMath/.test(xml), sectionCount: sections.length } };
  } finally { archive.cleanup(); }
}

async function parsePptx(name, buffer) {
  const archive = await unzip(buffer); try { const slideDir = path.join(archive.tempDir, 'ppt', 'slides'); const files = fs.existsSync(slideDir) ? sortNumbered(fs.readdirSync(slideDir).filter(file => /^slide\d+\.xml$/i.test(file))) : []; const sections = files.map((file, index) => { const xml = fs.readFileSync(path.join(slideDir, file), 'utf8'); const blocks = []; for (const shape of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gi)) { const raw = shape[0]; const text = xmlTexts(raw); if (!text) continue; const isTitle = /<p:ph[^>]*type="title"/i.test(raw) || /<p:ph[^>]*type="ctrTitle"/i.test(raw); blocks.push({ type: isTitle ? 'heading' : 'paragraph', text, placeholder: isTitle ? 'title' : 'body' }); } for (const table of xml.matchAll(/<a:tbl\b[\s\S]*?<\/a:tbl>/gi)) { const rows = [...table[0].matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/gi)].map(row => [...row[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/gi)].map(cell => xmlTexts(cell[0]))).filter(row => row.length); if (rows.length) blocks.push({ type: 'table', headers: rows[0], rows: rows.slice(1), source: 'pptx' }); } for (const picture of xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/gi)) blocks.push({ type: 'image', alt: xmlTexts(picture[0]) || `Slide ${index + 1} image`, source: 'pptx' }); const notes = readFileIfExists(archive.tempDir, `ppt/notesSlides/notesSlide${index + 1}.xml`); if (notes) blocks.push({ type: 'note', text: `Notes: ${xmlTexts(notes)}` }); if (!blocks.some(item => item.type === 'heading' || item.type === 'paragraph')) blocks.unshift({ type: 'paragraph', text: xmlTexts(xml) }); const title = blocks.find(item => item.type === 'heading')?.text || `Slide ${index + 1}`; const content = blocks.map(item => item.type === 'table' ? [item.headers, ...item.rows].map(row => row.join(' | ')).join('\n') : item.text || item.alt || '').filter(Boolean).join('\n'); return section(`${name}-slide-${index + 1}`, title, content, { slide: index + 1, source: file, notes: Boolean(notes), shapes: blocks.filter(item => ['heading', 'paragraph'].includes(item.type)).length, tables: blocks.filter(item => item.type === 'table').length, images: blocks.filter(item => item.type === 'image').length }, 'slide', index, blocks); }); return { sections: sections.length ? sections : splitTextSections(name, ''), metadata: { format: 'pptx', structured: true, slideCount: files.length, hasNotes: sections.some(item => item.locator.notes), hasTables: sections.some(item => item.locator.tables > 0), hasImages: sections.some(item => item.locator.images > 0) } }; } finally { archive.cleanup(); }
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
    else { const sections = legacyOfficeSections(name, buffer); parsed = { sections, metadata: { format: type, structured: false, warning: 'legacy-binary-parser-limited', textExtraction: sections.some(item => !item.content.startsWith('此旧版 Office 文件已保存')) ? 'printable-run-fallback' : 'none', conversion: 'unavailable-or-failed', conversionError: conversionError?.message || null } }; }
  }
  else parsed = { sections: splitTextSections(name, buffer.toString('utf8')), metadata: { format: type, structured: true } };
  const sections = parsed.sections.filter(item => item.content || item.kind === 'image').map((item, index) => ({ ...item, locator: { ...(item.locator || {}), page: Number(item.locator?.page || item.locator?.slide || item.locator?.sheet || index + 1) } })); const chunks = []; for (const item of sections) { const paragraphs = item.content.split(/\n{2,}|(?<=[。！？.!?])\s+/).map(value => value.trim()).filter(Boolean); let current = ''; let index = 0; for (const paragraph of paragraphs.length ? paragraphs : ['']) { if (current && current.length + paragraph.length + 1 > 900) { chunks.push({ id: `${item.id}-chunk-${index++}`, sectionId: item.id, content: current, chunkIndex: index, metadata: { ...item.locator, title: item.title, kind: item.kind } }); current = ''; } current += `${current ? '\n' : ''}${paragraph}`; } if (current) chunks.push({ id: `${item.id}-chunk-${index++}`, sectionId: item.id, content: current, chunkIndex: index, metadata: { ...item.locator, title: item.title, kind: item.kind } }); }
  for (const item of sections) { const blocks = (item.blocks || []).map((block, index) => ({ block, index, content: blockContent(block) })).filter(entry => entry.content); if (!blocks.length) continue; for (let index = chunks.length - 1; index >= 0; index -= 1) if (chunks[index].sectionId === item.id) chunks.splice(index, 1); for (const entry of blocks) chunks.push({ id: `${item.id}-block-${entry.index}`, sectionId: item.id, content: entry.content, chunkIndex: entry.index, metadata: { ...item.locator, title: item.title, kind: item.kind, blockType: entry.block.type || 'paragraph', blockIndex: entry.index } }); }
  return { fileType: type, sections, chunks, metadata: { ...metadataFor(name, ext), ...parsed.metadata } };
}

module.exports = { supported, extension, parseStructuredDocument, legacyOfficeStatus };
