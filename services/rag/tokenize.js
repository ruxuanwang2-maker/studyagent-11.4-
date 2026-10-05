// Deterministic Chinese bigrams improve lexical matching without a model download.
function tokenize(value) {
  const tokens = [];
  for (const match of String(value || '').toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) {
    for (const part of match[0].match(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu) || []) {
      if (/^\p{Script=Han}+$/u.test(part)) {
        const chars = [...part];
        for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1]);
      } else if (part.length > 1) tokens.push(part);
    }
  }
  return [...new Set(tokens)];
}
module.exports = { tokenize };
