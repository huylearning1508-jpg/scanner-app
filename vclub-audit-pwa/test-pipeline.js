// Test script for Field Extractor & Business Rules
import assert from 'node:assert';

function parseRtpString(rawStr) {
  if (!rawStr) return { value: null, autoCorrected: false, raw: '' };
  const cleaned = rawStr.replace(/%/g, '').trim();

  if (cleaned.includes('.')) {
    const num = parseFloat(cleaned);
    if (!isNaN(num)) {
      return { value: num, autoCorrected: false, raw: rawStr };
    }
  }

  const digitsOnly = cleaned.replace(/[^\d]/g, '');
  if (digitsOnly.length >= 3) {
    const firstTwo = digitsOnly.slice(0, 2);
    const decimals = digitsOnly.slice(2);
    const correctedStr = `${firstTwo}.${decimals}`;
    const val = parseFloat(correctedStr);
    if (!isNaN(val)) {
      return { value: val, autoCorrected: true, raw: rawStr };
    }
  } else if (digitsOnly.length === 2) {
    const val = parseFloat(digitsOnly);
    if (!isNaN(val)) {
      return { value: val, autoCorrected: false, raw: rawStr };
    }
  }

  return { value: null, autoCorrected: false, raw: rawStr };
}

function extractAuditFields(lines) {
  const result = {
    machineNo: null,
    rtp1: null,
    rtp2: null,
    totalMeters: null,
    periodicMeters: null,
    denom: null,
    confidence: { machineNo: 0, rtp1: 0, rtp2: 0, anchorFound: false },
    autoCorrected: false,
    warnings: [],
  };

  let dollarIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const txt = lines[i].text;
    if (txt.includes('$') || txt.startsWith('$')) {
      dollarIdx = i;
      result.denom = txt;
      break;
    }
  }

  const anchorFound = dollarIdx !== -1;
  result.confidence.anchorFound = anchorFound;

  if (!anchorFound) {
    result.warnings.push('Không tìm thấy anchor $');
  }

  let machineIdx = -1;
  const searchStart = anchorFound ? dollarIdx - 1 : lines.length - 1;

  for (let i = searchStart; i >= 0; i--) {
    const txt = lines[i].text;
    const digits = txt.replace(/[^\d]/g, '');
    if (digits.length > 0 && !txt.includes('%') && !txt.includes('$')) {
      machineIdx = i;
      result.machineNo = parseInt(digits, 10);
      result.confidence.machineNo = anchorFound ? 0.98 : 0.45;
      break;
    }
  }

  const rtpSearchStart = machineIdx !== -1 ? machineIdx - 1 : lines.length - 1;
  const rtpCandidates = [];

  for (let i = rtpSearchStart; i >= 0; i--) {
    const txt = lines[i].text;
    if (txt.includes('%') || (txt.includes('.') && txt.replace(/[^\d]/g, '').length >= 3)) {
      rtpCandidates.push({ line: lines[i], idx: i });
      if (rtpCandidates.length === 2) break;
    }
  }

  if (rtpCandidates.length >= 1) {
    const parsed = parseRtpString(rtpCandidates[0].line.text);
    result.rtp2 = parsed.value;
    if (parsed.autoCorrected) result.autoCorrected = true;
    result.confidence.rtp2 = parsed.autoCorrected ? 0.8 : 0.95;
  }

  if (rtpCandidates.length >= 2) {
    const parsed = parseRtpString(rtpCandidates[1].line.text);
    result.rtp1 = parsed.value;
    if (parsed.autoCorrected) result.autoCorrected = true;
    result.confidence.rtp1 = parsed.autoCorrected ? 0.8 : 0.95;
  }

  return result;
}

function extractDate(text) {
  let detectedYear = null;
  let detectedDay = null;

  const yearMatch = text.match(/\b(20[2-3]\d)\b/);
  if (yearMatch) detectedYear = parseInt(yearMatch[1], 10);

  const dayMatches = text.match(/\b([1-9]|[12]\d|3[01])\b/g);
  if (dayMatches) {
    for (const m of dayMatches) {
      const val = parseInt(m, 10);
      if (val >= 1 && val <= 31 && val !== detectedYear) {
        detectedDay = val;
        break;
      }
    }
  }

  return { day: detectedDay, year: detectedYear };
}

// 1. Test parseRtpString
console.log('[TEST 1] Testing parseRtpString...');
const r1 = parseRtpString('92.734%');
assert.strictEqual(r1.value, 92.734);
assert.strictEqual(r1.autoCorrected, false);

const r2 = parseRtpString('92734%'); // Fallback missing dot!
assert.strictEqual(r2.value, 92.734);
assert.strictEqual(r2.autoCorrected, true);

const r3 = parseRtpString('93.63%');
assert.strictEqual(r3.value, 93.63);
assert.strictEqual(r3.autoCorrected, false);

const r4 = parseRtpString('9363'); // Fallback missing dot!
assert.strictEqual(r4.value, 93.63);
assert.strictEqual(r4.autoCorrected, true);
console.log(' -> parseRtpString tests PASSED!');

// 2. Test extractAuditFields with dollar anchor
console.log('[TEST 2] Testing extractAuditFields with anchor $...');
const sampleLines = [
  { text: '58249012' },
  { text: '1420395' },
  { text: '92.734%' },
  { text: '93.63%' },
  { text: '12' },
  { text: '$0.01' },
];
const auditRes = extractAuditFields(sampleLines);
assert.strictEqual(auditRes.confidence.anchorFound, true);
assert.strictEqual(auditRes.machineNo, 12);
assert.strictEqual(auditRes.rtp1, 92.734);
assert.strictEqual(auditRes.rtp2, 93.63);
console.log(' -> extractAuditFields tests PASSED!');

// 3. Test Date Extraction
console.log('[TEST 3] Testing Date Extraction...');
const d1 = extractDate('Mon 23 Mar 2026 07:50:05');
assert.strictEqual(d1.day, 23);
assert.strictEqual(d1.year, 2026);
console.log(' -> Date Extraction tests PASSED!');

console.log('\n ALL UNIT VERIFICATION TESTS PASSED SUCCESSFULLY! ');
