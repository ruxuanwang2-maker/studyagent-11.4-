import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const base = process.env.STUDYAGENT_URL || 'http://127.0.0.1:4173';
let cookie = '';

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) } });
  cookie = (response.headers.get('set-cookie') || '').split(';')[0] || cookie;
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${data?.error?.message || text}`);
  return data;
}
function sessionFetch(path, options = {}) { return fetch(`${base}${path}`, { ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) } }); }

const suffix = Date.now().toString(36);
const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'multiformat-http-fixtures');

function archiveFixture(name, files) {
  const source = path.join(fixtureRoot, name);
  const archive = path.join(fixtureRoot, `${name}.zip`);
  fs.mkdirSync(source, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(source, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, Buffer.isBuffer(content) ? undefined : 'utf8');
  }
  execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-a', '-c', '-f', archive, '-C', source, '.'], { stdio: 'ignore' });
  return fs.readFileSync(archive);
}

fs.rmSync(fixtureRoot, { recursive: true, force: true });
const fixtures = [
  { name: `http-${suffix}.md`, content: '# Retrieval notes\n\n## Pivoting\nPartial pivoting reduces error growth.' , kind: 'heading' },
  { name: `http-${suffix}.txt`, content: 'Plain text learning material.\n\nA second paragraph remains a separate chunk.', kind: 'paragraph' },
  { name: `http-${suffix}.csv`, content: 'concept,mastery\nPivoting,0.64\nCondition Number,0.41\n', kind: 'sheet' },
  {
    name: `http-${suffix}.docx`,
    buffer: archiveFixture('docx', {
      'word/document.xml': '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>HTTP DOCX heading</w:t></w:r></w:p><w:p><w:r><w:t>Structured paragraph.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
    }),
    check: (catalogued) => catalogued.content.length === 1 && catalogued.content.some(item => item.type === 'page' && item.blocks?.some(block => block.type === 'heading') && item.blocks?.some(block => block.type === 'table'))
  },
  {
    name: `http-${suffix}.pptx`,
    buffer: archiveFixture('pptx', {
      'ppt/slides/slide1.xml': '<p:sld><p:cSld><p:sp><p:nvSpPr><p:ph type="title"/></p:nvSpPr><a:t>HTTP Slide</a:t></p:sp><p:sp><a:t>Slide body</a:t></p:sp><p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic><a:tbl><a:tr><a:tc><a:t>Header</a:t></a:tc></a:tr></a:tbl><p:pic><p:blipFill><a:blip r:embed="rId3"/></p:blipFill></p:pic></p:cSld></p:sld>',
      'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/><Relationship Target="../media/image2.png" Id="rId3"/></Relationships>',
      'ppt/media/image1.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      'ppt/media/image2.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      'ppt/notesSlides/notesSlide1.xml': '<p:notes><a:t>HTTP notes</a:t></p:notes>'
    }),
    check: (catalogued) => catalogued.content.some(item => item.locator?.slide === 1 && item.blocks?.some(block => block.type === 'note' || block.type === 'table'))
  },
  {
    name: `http-${suffix}.xlsx`,
    buffer: archiveFixture('xlsx', {
      'xl/workbook.xml': '<workbook><sheets><sheet name="HTTP Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/sharedStrings.xml': '<sst><si><t>Concept</t></si><si><t>Mastery</t></si><si><t>Pivoting</t></si>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row><c r="A2" t="s"><v>2</v></c><c r="B2"><f>0.8+0.04</f><v>0.84</v></c></row></sheetData></worksheet>'
    }),
    check: (catalogued) => catalogued.content.some(item => item.locator?.sheet === 1 && item.blocks?.some(block => block.type === 'table'))
  },
  {
    name: `http-${suffix}.png`,
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    check: (catalogued) => catalogued.metadata?.ocr === true && catalogued.content.some(item => item.type === 'image' && item.locator?.image === 1 && item.blocks?.some(block => block.type === 'image'))
  }
];
const created = [];
try {
  for (const fixture of fixtures) {
    const payload = fixture.buffer
      ? { name: fixture.name, base64: fixture.buffer.toString('base64') }
      : { name: fixture.name, content: fixture.content };
    const imported = await request('/api/documents/upload', { method: 'POST', body: JSON.stringify(payload) });
    if (!imported.id || !imported.structure?.chunks || !Array.isArray(imported.content) || imported.content.length < 1) throw new Error(`${fixture.name} upload returned no structured document`);
    created.push(imported.id);
    const catalogued = await request(`/api/documents/${encodeURIComponent(imported.id)}`);
    if (catalogued.id !== imported.id || !Array.isArray(catalogued.content) || catalogued.structure?.parser !== 'structured-document-pipeline') throw new Error(`${fixture.name} was not persisted in the SQLite document catalog`);
    if (fixture.kind === 'sheet' && !catalogued.content.some(item => item.type === 'sheet' || item.locator?.sheet)) throw new Error(`${fixture.name} lost sheet structure`);
    if (fixture.kind === 'heading' && !catalogued.content.some(item => item.type === 'heading' || item.locator?.heading)) throw new Error(`${fixture.name} lost heading structure`);
    if (fixture.check && !fixture.check(catalogued)) throw new Error(`${fixture.name} lost native structure in HTTP upload`);
    if (fixture.name.endsWith('.png')) {
      const original = await sessionFetch(`/api/documents/${encodeURIComponent(imported.id)}/file`);
      if (!original.ok || original.headers.get('content-type') !== 'image/png' || (await original.arrayBuffer()).byteLength < 20) throw new Error(`${fixture.name} original image endpoint is unavailable`);
    }
    if (fixture.name.endsWith('.pptx')) {
      const preview = await sessionFetch(`/api/documents/${encodeURIComponent(imported.id)}/office-preview/1`);
      const previewBytes = Buffer.from(await preview.arrayBuffer());
      if (!preview.ok || preview.headers.get('content-type') !== 'image/png' || previewBytes.byteLength < 20) throw new Error(`${fixture.name} embedded slide preview endpoint is unavailable (${preview.status} ${preview.headers.get('content-type') || 'no content type'}: ${previewBytes.toString('utf8').slice(0, 300)})`);
      const second = await sessionFetch(`/api/documents/${encodeURIComponent(imported.id)}/office-preview/1?image=1`);
      if (!second.ok || second.headers.get('content-type') !== 'image/png' || (await second.arrayBuffer()).byteLength < 20) throw new Error(`${fixture.name} second slide image is unavailable`);
    }
  }
  const batch = await request('/api/documents/upload-batch', {
    method: 'POST',
    body: JSON.stringify({
      files: [
        { name: `batch-${suffix}.md`, content: '# Batch heading\n\nBatch markdown remains structured.' },
        { name: `batch-${suffix}.docx`, base64: fixtures.find(item => item.name.endsWith('.docx')).buffer.toString('base64') }
      ]
    })
  });
  if (batch.imported !== 2 || batch.failed !== 0 || !Array.isArray(batch.documents) || batch.documents.length !== 2) {
    throw new Error('batch upload did not import all files');
  }
  for (const document of batch.documents) {
    if (!document.id || document.structure?.parser !== 'structured-document-pipeline') throw new Error('batch upload lost structured document data');
    created.push(document.id);
  }
} finally {
  for (const id of created) await request(`/api/learning/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: true, formats: ['MD', 'TXT', 'CSV', 'DOCX', 'PPTX', 'XLSX', 'PNG'], batch: 'upload-batch -> structured documents -> delete', flow: 'upload -> structured sections/chunks -> SQLite catalog -> delete' }));
