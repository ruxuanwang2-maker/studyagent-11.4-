import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseStructuredDocument, extractOfficePreviewImage } = require('../services/documents/pipeline.js');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studyagent-office-check-'));
function archive(name, files) {
  const source = path.join(fixtureRoot, name);
  fs.mkdirSync(source, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(source, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const output = path.join(fixtureRoot, `${name}.zip`);
  execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-a', '-c', '-f', output, '-C', source, '.'], { windowsHide: true });
  return fs.readFileSync(output);
}

try {
  const docx = archive('word', {
    'word/document.xml': `<w:document><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>高</w:t></w:r><w:r><w:t>等代数</w:t></w:r></w:p>
      <w:p><w:r><w:t>计算</w:t></w:r><m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:den></m:f></m:oMath><w:r><w:t>的值</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>列一</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc><w:tc><w:p><w:r><w:t>列三</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>`
  });
  const word = await parseStructuredDocument({ name: '高等代数.docx', buffer: docx });
  assert.equal(word.sections.length, 1, 'paragraphs must not each become separate pages');
  assert.equal(word.sections[0].title, '高等代数', 'formatting runs must not insert spaces');
  assert.deepEqual(word.sections[0].blocks.slice(1, 4).map(block => block.type), ['paragraph', 'formula', 'paragraph']);
  assert.equal(word.sections[0].blocks.find(block => block.type === 'formula').latex, '\\frac{1}{x^{2}}');
  assert.deepEqual(word.sections[0].blocks.find(block => block.type === 'table').headers, ['列一', '', '列三']);
  assert.ok(word.chunks.some(chunk => chunk.content.includes('\\frac{1}{x^{2}}')));

  const pptx = archive('slides', {
    'ppt/slides/slide1.xml': `<p:sld><p:cSld><p:sp><p:ph type="title"/><a:t>课</a:t><a:t>程标题</a:t></p:sp><p:pic><a:blip r:embed="rId2"/></p:pic><p:sp><a:t>图示之后</a:t></p:sp><a:tbl><a:tr><a:tc><a:t>标题</a:t></a:tc></a:tr></a:tbl><p:pic><a:blip r:embed="rId3"/></p:pic></p:cSld></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Target="../media/first.png" Id="rId2"/><Relationship Id="rId3" Target="../media/second.png"/></Relationships>',
    'ppt/media/first.png': 'first-image',
    'ppt/media/second.png': 'second-image',
    'ppt/notesSlides/notesSlide1.xml': '<p:notes><a:t>教师</a:t><a:t>备注</a:t></p:notes>'
  });
  const slides = await parseStructuredDocument({ name: '讲义.pptx', buffer: pptx });
  assert.equal(slides.sections[0].title, '课程标题');
  assert.deepEqual(slides.sections[0].blocks.map(block => block.type), ['heading', 'image', 'paragraph', 'table', 'image', 'note']);
  assert.equal(slides.sections[0].blocks.at(-1).text, 'Notes: 教师备注');
  assert.equal(slides.sections[0].locator.slide, 1);
  assert.equal((await extractOfficePreviewImage(pptx, 'pptx', 1, 0)).buffer.toString(), 'first-image');
  assert.equal((await extractOfficePreviewImage(pptx, 'pptx', 1, 1)).buffer.toString(), 'second-image');

  await assert.rejects(parseStructuredDocument({ name: '旧讲义.doc', buffer: Buffer.from('d0cf11e0a1b11ae1', 'hex') }), { code: 'OFFICE_CONVERTER_REQUIRED' });

  const userSample = 'C:/Users/王汝轩/Desktop/测试/新建文件夹/我的测试.docx';
  if (fs.existsSync(userSample)) {
    const sample = await parseStructuredDocument({ name: path.basename(userSample), buffer: fs.readFileSync(userSample) });
    assert.ok(sample.sections.length > 1 && sample.chunks.length > 1, 'real user DOCX must parse into readable pages and chunks');
    assert.ok(sample.sections[0].content.includes('建议下载后生成一个链接'), 'real user DOCX text must remain readable');
  }
  console.log('PASS: DOCX run boundaries, inline OMML, table columns, page grouping; PPTX slide order/notes/multiple images; legacy binary error; real DOCX when available');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
