// Conservative gate for study answers. OCR guesses are evidence, not verified solutions.
function textQuality(value) {
  const text = String(value || '').trim();
  const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const separatedHan = (text.match(/[\u3400-\u9fff]\s+(?=[\u3400-\u9fff])/g) || []).length;
  const damaged = (text.match(/[�□]/g) || []).length;
  const suspectMath = (text.match(/\b[45]\s+E\s+C\b|\b4z\b|\b4w\b|\bminzecn\b/gi) || []).length;
  const reasons = [];
  if (text.length < 35) reasons.push('too-short');
  if (damaged > 0) reasons.push('replacement-glyphs');
  if (han > 20 && separatedHan / han > 0.12) reasons.push('spaced-chinese-glyphs');
  if (suspectMath > 0) reasons.push('unverified-math-ocr');
  return { reliable: reasons.length === 0, reasons, han, separatedHan, suspectMath };
}

module.exports = { textQuality };
