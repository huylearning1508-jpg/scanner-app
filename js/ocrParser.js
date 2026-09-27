/**
 * ocrParser.js
 * -----------------------------------------------------------------------
 * Bóc tách dữ liệu từ kết quả nhận diện theo logic ANCHOR POINT MGMD:
 *
 * MỐC CHÍNH = DÒNG CHỮ "MGMD":
 * - Trên đó 1 dòng (mốc - 1) = dòng Denom ($0.01)
 * - Trên đó 2 dòng (mốc - 2) = Machine Number (ví dụ: 3)
 * - Trên đó 3 dòng (mốc - 3) = RTP 2 (ví dụ: 93.56%)
 * - Trên đó 4 dòng (mốc - 4) = RTP 1 (ví dụ: 93.966%)
 *
 * BƯỚC 2 (màn ngày):
 * - Đọc token ngày và năm từ model số.
 * -----------------------------------------------------------------------
 */

const OcrParser = (() => {
    const RTP_MIN = 80, RTP_MAX = 99.99;
    const MACHINE_NO_MIN = 0, MACHINE_NO_MAX = 900;
    const ROW_CONFIDENCE_OK = 0.6; // dưới ngưỡng này -> hạ confidence tổng

    /** Chèn dấu chấm khi model không đọc được "." — coi phần nguyên luôn 2 chữ số (RTP 80-99). */
    function fixMissingDecimalForRtp(digitsOnly) {
        if (digitsOnly.length <= 2) return { value: Number(digitsOnly), corrected: false };
        const intPart = digitsOnly.slice(0, 2);
        const fracPart = digitsOnly.slice(2);
        return { value: Number(`${intPart}.${fracPart}`), corrected: true };
    }

    /**
     * @param {string} rowText chuỗi ký tự đã ghép của 1 dòng
     * @returns {{numeric: number|null, hasDollar: boolean, autoCorrected: boolean}}
     */
    function parseNumericRow(rowText) {
        const hasDollar = rowText.includes('$');
        const digitsOnly = rowText.replace(/[^0-9]/g, '');
        if (!digitsOnly) return { numeric: null, hasDollar, autoCorrected: false };

        if (rowText.includes('.')) {
            const numMatch = rowText.match(/[0-9]+\.[0-9]+/);
            return { numeric: numMatch ? Number(numMatch[0]) : null, hasDollar, autoCorrected: false };
        }
        return { numeric: Number(digitsOnly), hasDollar, autoCorrected: false };
    }

    /**
     * @param {{text: string, meanConfidence: number, isMgmd?: boolean, hasDollar?: boolean}[]} rows
     * danh sách dòng đã nhận diện, thứ tự từ trên xuống dưới
     * @returns {null | {
     *   machineNo: number, rtp1: number, rtp2: number,
     *   confidence: {machineNo:number, rtp1:number, rtp2:number},
     *   autoCorrected: {rtp1:boolean, rtp2:boolean},
     *   allValid: boolean
     * }}
     */
    function parseStep1(rows) {
        if (!rows || rows.length === 0) return null;

        // 1. Xác định vị trí mốc MGMD
        // Ưu tiên dòng có cờ isMgmd = true hoặc chuỗi chứa "MGMD"
        let mgmdIdx = rows.findIndex((r) => r.isMgmd || (r.text && r.text.includes('MGMD')));

        // 2. Dự phòng: Nếu mốc MGMD không nhìn thấy chữ "MGMD", nhưng nhìn thấy dòng Denom ($)
        // Cấu trúc chuẩn: dòng Denom ($0.01) nằm ngay TRÊN dòng MGMD 1 dòng (mgmdIdx = dollarIdx + 1)
        if (mgmdIdx === -1) {
            const dollarIdx = rows.findIndex((r) => r.text && r.text.includes('$'));
            if (dollarIdx !== -1) {
                mgmdIdx = dollarIdx + 1;
            }
        }

        let machIdx, rtp2Idx, rtp1Idx;

        if (mgmdIdx !== -1 && mgmdIdx >= 4 && mgmdIdx <= rows.length) {
            // Chuẩn 100% theo yêu cầu:
            // Mốc = MGMD (mgmdIdx)
            // Trên đó 1 dòng (mgmdIdx - 1) = Denom
            // Trên đó 2 dòng (mgmdIdx - 2) = Machine No
            // Trên đó 3 dòng (mgmdIdx - 3) = RTP 2
            // Trên đó 4 dòng (mgmdIdx - 4) = RTP 1
            machIdx = mgmdIdx - 2;
            rtp2Idx = mgmdIdx - 3;
            rtp1Idx = mgmdIdx - 4;
        } else {
            // Fallback khi MGMD nằm ngoài đáy khung ngắm: nếu có dòng Denom ($) và đủ 3 dòng trên nó
            const dollarIdx = rows.findIndex((r) => r.text && r.text.includes('$'));
            if (dollarIdx >= 3) {
                machIdx = dollarIdx - 1;
                rtp2Idx = dollarIdx - 2;
                rtp1Idx = dollarIdx - 3;
            } else {
                return null;
            }
        }

        const machineRow = rows[machIdx];
        const rtp2Row = rows[rtp2Idx];
        const rtp1Row = rows[rtp1Idx];

        if (!machineRow || !rtp2Row || !rtp1Row) return null;

        const machineDigits = machineRow.text.replace(/[^0-9]/g, '');
        if (!machineDigits) return null;
        const machineNo = Number(machineDigits);

        const rtp1Digits = rtp1Row.text.replace(/[^0-9]/g, '');
        const rtp2Digits = rtp2Row.text.replace(/[^0-9]/g, '');
        if (!rtp1Digits || !rtp2Digits) return null;

        const rtp1Fallback = !rtp1Row.text.includes('.') && rtp1Digits.length > 2;
        const rtp2Fallback = !rtp2Row.text.includes('.') && rtp2Digits.length > 2;

        const rtp1 = rtp1Fallback
            ? fixMissingDecimalForRtp(rtp1Digits).value
            : Number((rtp1Row.text.match(/[0-9]+\.[0-9]+/) || [rtp1Digits])[0]);
        const rtp2 = rtp2Fallback
            ? fixMissingDecimalForRtp(rtp2Digits).value
            : Number((rtp2Row.text.match(/[0-9]+\.[0-9]+/) || [rtp2Digits])[0]);

        if ([machineNo, rtp1, rtp2].some((v) => Number.isNaN(v))) return null;

        const machineNoValid = machineNo >= MACHINE_NO_MIN && machineNo <= MACHINE_NO_MAX;
        const rtp1Valid = rtp1 >= RTP_MIN && rtp1 <= RTP_MAX;
        const rtp2Valid = rtp2 >= RTP_MIN && rtp2 <= RTP_MAX;

        return {
            machineNo, rtp1, rtp2,
            confidence: {
                machineNo: machineNoValid ? machineRow.meanConfidence : 0,
                rtp1: rtp1Valid ? rtp1Row.meanConfidence : 0,
                rtp2: rtp2Valid ? rtp2Row.meanConfidence : 0,
            },
            autoCorrected: { rtp1: rtp1Fallback, rtp2: rtp2Fallback },
            allValid: machineNoValid && rtp1Valid && rtp2Valid,
        };
    }

    /**
     * @param {{text: string, meanConfidence: number}[]} tokens token trên dòng ngày, thứ tự trái->phải
     * @returns {null | {day: number, year: number}}
     */
    function parseStep2(tokens) {
        if (!tokens || tokens.length === 0) return null;

        const reliableNumeric = tokens
            .map((t, idx) => ({ ...t, idx, digitsOnly: t.text.replace(/[^0-9]/g, '') }))
            .filter((t) => t.meanConfidence >= ROW_CONFIDENCE_OK && t.digitsOnly.length === t.text.length && t.digitsOnly.length > 0);

        const yearToken = reliableNumeric.find((t) => t.digitsOnly.length === 4);
        if (!yearToken) return null;

        const dayToken = reliableNumeric.find((t) => t.idx < yearToken.idx && t.digitsOnly.length <= 2);
        if (!dayToken) return null;

        const day = Number(dayToken.digitsOnly);
        const year = Number(yearToken.digitsOnly);
        if (day < 1 || day > 31) return null;

        return { day, year };
    }

    return { parseStep1, parseStep2, parseNumericRow, RTP_MIN, RTP_MAX, MACHINE_NO_MIN, MACHINE_NO_MAX };
})();
