import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const escSource = source.match(/^const esc=.*$/m)?.[0];
const mathSource = source.match(/^function mathmlForLatex.*$/m)?.[0];
const renderStart = source.indexOf('function renderPlainAiText');
const renderEnd = source.indexOf('function normalizeReviewFormulaText');

assert.ok(escSource && mathSource && renderStart >= 0 && renderEnd > renderStart, 'AI math renderer source was not found');

const renderAiText = new Function(
  `${escSource}\n${mathSource}\n${source.slice(renderStart, renderEnd)}\nreturn renderAiText;`,
)();

const cases = [
  { text: String.raw`设误差为 $E_{rel}=\frac{|x-\hat{x}|}{|x|}$。`, expected: ['<math', '<mfrac>'] },
  { text: String.raw`\`\frac{a}{b}\``, expected: ['<math', '<mfrac>'] },
  { text: ['```latex', String.raw`\int_0^1 x^2 \, dx = \frac{1}{3}`, '```'].join('\n'), expected: ['<math', '<mfrac>', '∫'] },
  { text: String.raw`相对偏差为 100\%。`, expected: ['<math', '%'] },
  { text: 'x^2 + y^2 = z^2', expected: ['<math', '<msup>'] },
];

for (const item of cases) {
  const html = renderAiText(item.text);
  for (const token of item.expected) assert.ok(html.includes(token), `Expected ${token} in rendered output for ${item.text}`);
  assert.equal(/\\(?:frac|int|hat|%)/.test(html.replace(/aria-label="[^"]*"/g, '')), false, `Raw LaTeX leaked into visible output: ${html}`);
}

console.log(`AI math rendering ok: ${cases.length} formats converted to MathML`);
