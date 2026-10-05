import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractPdfJsPages, formatEvidenceText } = require('../services/documents/parser');
const { textQuality } = require('../services/documents/quality');
const lecture = path.join(os.homedir(), 'Desktop', '讲义', 'FDU 数值算法 0. 基础知识.pdf');
assert.ok(fs.existsSync(lecture), 'Real FDU lecture is required for OCR regression');
const pages = await extractPdfJsPages(fs.readFileSync(lecture));
assert.equal(pages.length, 16);
assert.match(pages[0].text, /FDU 数值算法 0\. 基础知识/);
assert.match(pages[0].text, /求解线性方程组/);
assert.match(pages[0].text, /舍入误差/);
assert.equal(textQuality(pages[0].text).reliable, true);
assert.ok(pages[0].nativeQuality.score > 0.7);

const damaged = 'K * FDU 数 值 算 法 给 定 非 奇 异 矩 阵 4 E C“““ 和 向 量 5 E C+，计 算 4z 二 5 的 解';
assert.equal(textQuality(damaged).reliable, false);
assert.equal(formatEvidenceText(damaged), damaged, 'Damaged OCR must not be silently converted into confident LaTeX');
console.log('OCR quality regression passed: 16 real lecture pages, readable native text, and damaged formula quarantine');
