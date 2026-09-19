/**
 * Anchor-Relative Field Extractor
 * Bóc tách các trường dữ liệu theo quy tắc mỏ neo '$':
 * - anchor     : Dòng mệnh giá / tiền tệ ($)
 * - anchor - 1 : Machine No (0 - 900)
 * - anchor - 2 : RTP2 (80 - 99 %)
 * - anchor - 3 : RTP1 (80 - 99 %)
 * - upper lines: Total Meters & Periodic Meters
 * - Fallback mất dấu chấm (RTP): chèn '.' sau 2 số đầu (raw / 10^(len-2))
 * - Validation & Confidence scoring
 */

import type { AuditFieldResult, DateScanResult, DetectedLine } from '../types';

/**
 * Xử lý chuỗi RTP: trích xuất số thập phân, tự sửa nếu thiếu dấu '.'
 */
export function parseRtpString(rawStr: string): {
  value: number | null;
  autoCorrected: boolean;
  raw: string;
} {
  if (!rawStr) return { value: null, autoCorrected: false, raw: '' };

  // Loại bỏ ký tự '%' và khoảng trắng
  const cleaned = rawStr.replace(/%/g, '').trim();

  // Trường hợp 1: Có dấu chấm rõ ràng (vd: "92.734", "93.63")
  if (cleaned.includes('.')) {
    const num = parseFloat(cleaned);
    if (!isNaN(num)) {
      return { value: num, autoCorrected: false, raw: rawStr };
    }
  }

  // Trường hợp 2: Fallback mất dấu chấm (RTP only) - spec: chèn sau đúng 2 chữ số đầu
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
    // Chỉ có 2 chữ số (vd: "92")
    const val = parseFloat(digitsOnly);
    if (!isNaN(val)) {
      return { value: val, autoCorrected: false, raw: rawStr };
    }
  }

  return { value: null, autoCorrected: false, raw: rawStr };
}

/**
 * Bóc tách trường từ các dòng màn hình Audit
 */
export function extractAuditFields(lines: DetectedLine[]): AuditFieldResult {
  const result: AuditFieldResult = {
    machineNo: null,
    rtp1: null,
    rtp2: null,
    totalMeters: null,
    periodicMeters: null,
    denom: null,
    confidence: {
      machineNo: 0,
      rtp1: 0,
      rtp2: 0,
      anchorFound: false,
    },
    autoCorrected: false,
    warnings: [],
    rawStrings: {},
  };

  if (!lines || lines.length === 0) {
    result.warnings.push('Không phát hiện thấy dòng chữ nào trên màn hình.');
    return result;
  }

  // 1. Tìm vị trí dòng Dollar ($) làm Anchor
  let dollarIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const txt = lines[i].text;
    if (txt.includes('$') || txt.startsWith('$')) {
      dollarIdx = i;
      result.denom = txt;
      result.rawStrings.denom = txt;
      break;
    }
  }

  const anchorFound = dollarIdx !== -1;
  result.confidence.anchorFound = anchorFound;

  if (!anchorFound) {
    result.warnings.push(
      'Không tìm thấy anchor ký tự "$" — Độ tin cậy thấp, bắt buộc xác nhận thủ công.'
    );
  }

  // 2. Tìm Machine ID (anchor - 1 hoặc dòng số nguyên gần nhất kề trên $)
  let machineIdx = -1;
  const searchStart = anchorFound ? dollarIdx - 1 : lines.length - 1;

  for (let i = searchStart; i >= 0; i--) {
    const txt = lines[i].text;
    const digits = txt.replace(/[^\d]/g, '');

    // Machine No là số nguyên, không có % hay $
    if (digits.length > 0 && !txt.includes('%') && !txt.includes('$')) {
      const parsedNum = parseInt(digits, 10);
      machineIdx = i;
      result.machineNo = parsedNum;
      result.rawStrings.machineNo = txt;

      // Tính confidence trung bình của các ký tự trong số máy
      const avgConf =
        lines[i].chars.reduce((acc, c) => acc + c.confidence, 0) /
        Math.max(1, lines[i].chars.length);
      result.confidence.machineNo = anchorFound ? avgConf : avgConf * 0.5;
      break;
    }
  }

  // 3. Tìm 2 dòng RTP (%) nằm phía trên dòng Machine ID
  const rtpSearchStart = machineIdx !== -1 ? machineIdx - 1 : lines.length - 1;
  const rtpCandidates: { line: DetectedLine; idx: number }[] = [];

  for (let i = rtpSearchStart; i >= 0; i--) {
    const txt = lines[i].text;
    // Dòng RTP thường có chứa '%' hoặc có dạng số thập phân
    if (txt.includes('%') || (txt.includes('.') && txt.replace(/[^\d]/g, '').length >= 3)) {
      rtpCandidates.push({ line: lines[i], idx: i });
      if (rtpCandidates.length === 2) break;
    }
  }

  // RTP2 là dòng % gần Machine No nhất (anchor - 2)
  if (rtpCandidates.length >= 1) {
    const cand = rtpCandidates[0];
    const parsed = parseRtpString(cand.line.text);
    result.rtp2 = parsed.value;
    result.rawStrings.rtp2 = cand.line.text;
    if (parsed.autoCorrected) {
      result.autoCorrected = true;
      result.warnings.push('RTP2: Đã tự động sửa dấu chấm thập phân.');
    }

    const avgConf =
      cand.line.chars.reduce((acc, c) => acc + c.confidence, 0) /
      Math.max(1, cand.line.chars.length);
    result.confidence.rtp2 = parsed.autoCorrected ? avgConf * 0.8 : avgConf;
  }

  // RTP1 là dòng % ở trên nữa (anchor - 3)
  if (rtpCandidates.length >= 2) {
    const cand = rtpCandidates[1];
    const parsed = parseRtpString(cand.line.text);
    result.rtp1 = parsed.value;
    result.rawStrings.rtp1 = cand.line.text;
    if (parsed.autoCorrected) {
      result.autoCorrected = true;
      result.warnings.push('RTP1: Đã tự động sửa dấu chấm thập phân.');
    }

    const avgConf =
      cand.line.chars.reduce((acc, c) => acc + c.confidence, 0) /
      Math.max(1, cand.line.chars.length);
    result.confidence.rtp1 = parsed.autoCorrected ? avgConf * 0.8 : avgConf;
  }

  // 4. Tìm Total Meters và Periodic Meters (ở phần trên của màn Audit)
  const highestRtpIdx =
    rtpCandidates.length > 0 ? Math.min(...rtpCandidates.map((c) => c.idx)) : machineIdx;

  if (highestRtpIdx > 0) {
    const meterLines: DetectedLine[] = [];
    for (let i = 0; i < highestRtpIdx; i++) {
      const digits = lines[i].text.replace(/[^\d]/g, '');
      // Dòng meter thường là chuỗi số dài (>= 4 chữ số)
      if (digits.length >= 4) {
        meterLines.push(lines[i]);
      }
    }

    if (meterLines.length >= 1) {
      const totalDigits = meterLines[0].text.replace(/[^\d]/g, '');
      result.totalMeters = parseInt(totalDigits, 10) || null;
      result.rawStrings.totalMeters = meterLines[0].text;
    }
    if (meterLines.length >= 2) {
      const periodicDigits = meterLines[1].text.replace(/[^\d]/g, '');
      result.periodicMeters = parseInt(periodicDigits, 10) || null;
      result.rawStrings.periodicMeters = meterLines[1].text;
    }
  }

  // 5. Validation Rules theo Spec
  // Machine No in [0, 900]
  if (result.machineNo !== null) {
    if (result.machineNo < 0 || result.machineNo > 900) {
      result.confidence.machineNo *= 0.4;
      result.warnings.push(
        `Machine No (${result.machineNo}) ngoài dải hợp lệ [0–900].`
      );
    }
  } else {
    result.warnings.push('Chưa tìm thấy Machine No.');
  }

  // RTP1 / RTP2 in [80, 99]
  if (result.rtp1 !== null) {
    if (result.rtp1 < 80 || result.rtp1 > 99.999) {
      result.confidence.rtp1 *= 0.5;
      result.warnings.push(`RTP1 (${result.rtp1}%) ngoài dải hợp lệ [80–99%].`);
    }
  } else {
    result.warnings.push('Chưa tìm thấy RTP1.');
  }

  if (result.rtp2 !== null) {
    if (result.rtp2 < 80 || result.rtp2 > 99.999) {
      result.confidence.rtp2 *= 0.5;
      result.warnings.push(`RTP2 (${result.rtp2}%) ngoài dải hợp lệ [80–99%].`);
    }
  } else {
    result.warnings.push('Chưa tìm thấy RTP2.');
  }

  return result;
}

/**
 * Trích xuất Ngày và Năm từ dòng ngày (Bước 2)
 * Ví dụ: "Mon 23 Mar 2026 07:50:05" hoặc "23 Mar 2026"
 */
export function extractDateFromLines(lines: DetectedLine[]): DateScanResult {
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1; // 1-12

  let detectedDay: number | null = null;
  let detectedYear: number | null = null;
  let fullText = '';
  let conf = 0.5;

  for (const line of lines) {
    const text = line.text;
    fullText += ' ' + text;

    // Tìm năm: chuỗi 4 chữ số (2020 - 2035)
    const yearMatch = text.match(/\b(20[2-3]\d)\b/);
    if (yearMatch && !detectedYear) {
      detectedYear = parseInt(yearMatch[1], 10);
    }

    // Tìm ngày: số 1 - 31 (trước tên tháng hoặc đứng độc lập)
    const dayMatches = text.match(/\b([1-9]|[12]\d|3[01])\b/g);
    if (dayMatches && !detectedDay) {
      for (const m of dayMatches) {
        const val = parseInt(m, 10);
        // Bỏ qua nếu trùng với năm hoặc quá lớn
        if (val >= 1 && val <= 31 && val !== detectedYear) {
          detectedDay = val;
          break;
        }
      }
    }
  }

  if (detectedDay && detectedYear) {
    conf = 0.9;
  } else if (detectedDay || detectedYear) {
    conf = 0.7;
  }

  return {
    day: detectedDay,
    month: currentMonth, // Tháng chọn tay dropdown theo Giai đoạn 1
    year: detectedYear || currentYear,
    rawText: fullText.trim(),
    confidence: conf,
  };
}
