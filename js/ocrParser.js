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
    const RTP_MIN = 80, RTP_MAX = 99.999;
    const MACHINE_NO_MIN = 0, MACHINE_NO_MAX = 900;
    const ROW_CONFIDENCE_OK = 0.6; // dưới ngưỡng này -> hạ confidence tổng

    /**
     * Bóc tách giá trị RTP từ chuỗi text của dòng (80.00% - 99.999%)
     * @param {string} text
     * @returns {null | {val: number, autoCorrected: boolean}}
     */
    function parseRtpValue(text) {
        if (!text) return null;

        // Chuẩn hóa: nếu có ký tự $ trước dấu chấm hoặc trước % (nhận nhầm số 5 thành $), sửa thành 5
        let fixed = text;
        if (fixed.includes('%') || /\.\d{2,}/.test(fixed)) {
            fixed = fixed.replace(/\$/g, '5');
        }

        // 1. Chuẩn: Tìm số 8x hoặc 9x có dấu chấm thập phân (ví dụ: 95.427%, 94.05%, 92.030, 91.85)
        const decMatch = fixed.match(/(8\d|9\d)\.(\d{2,4})\s*%?/);
        if (decMatch) {
            const val = Number(decMatch[1] + '.' + decMatch[2]);
            if (val >= RTP_MIN && val <= RTP_MAX) return { val, autoCorrected: false };
        }

        // 2. Mất dấu chấm nhưng có 4-5 chữ số liền nhau (ví dụ: 9405% -> 94.05, 94237% -> 94.237, 9185% -> 91.85)
        const noDotMatch = fixed.match(/(8\d|9\d)(\d{2,3})\s*%/);
        if (noDotMatch) {
            const val = Number(noDotMatch[1] + '.' + noDotMatch[2]);
            if (val >= RTP_MIN && val <= RTP_MAX) return { val, autoCorrected: true };
        }

        return null;
    }

    /**
     * Bóc tách Machine No (số nguyên từ 0 đến 900)
     * @param {string} text
     * @returns {number|null}
     */
    function parseMachineNumber(text) {
        if (!text) return null;
        if (text.includes('%') || isDenomRow(text) || text.includes('MGMD')) return null;
        const digits = text.replace(/[^0-9]/g, '');
        if (!digits) return null;
        const val = Number(digits);
        if (val >= MACHINE_NO_MIN && val <= MACHINE_NO_MAX) return val;
        return null;
    }

    /**
     * Nhận diện dòng Denom (chứa $0.01, $0.02, $0.05, 50.01, S0.01, 0.01,...)
     * @param {string} text
     * @returns {boolean}
     */
    function isDenomRow(text) {
        if (!text) return false;
        const clean = text.replace(/\s+/g, '');
        if (/(?:\$|5|s)\s*0?\s*[.,]\s*0\s*[125]/i.test(clean)) return true;
        if (/(?:0|00)\s*[.,]\s*0\s*[125]/.test(clean)) return true;
        if (/\b0\.0[125]\b/.test(clean)) return true;
        if (/\$0\.\d{2}/.test(clean) || /\$1\.00/.test(clean)) return true;
        if (/001|002|005/.test(clean)) return true;
        return false;
    }

    /**
     * @param {{text: string, meanConfidence: number, isMgmd?: boolean, mgmdConfidence?: number}[]} rows
     * danh sách dòng đã nhận diện, thứ tự từ trên xuống dưới
     * @returns {null | {
     *   machineNo: number, rtp1: number, rtp2: number, denom?: string,
     *   confidence: {machineNo:number, rtp1:number, rtp2:number},
     *   autoCorrected: {rtp1:boolean, rtp2:boolean},
     *   allValid: boolean
     * }}
     */
    function parseStep1(rows) {
        if (!rows || rows.length === 0) return null;

        let bestCandidate = null;
        let bestScore = -1;

        // Tối ưu theo vị trí người dùng căn mép dưới khung ngắm sát dòng MGMD:
        // Đánh giá cấu trúc dòng tính từ mốc MGMD
        const evaluateAnchor = (mgmdIdx) => {
            if (mgmdIdx < 2) return;

            let score = 0;
            // Điểm thưởng vị trí: Ưu tiên cao nhất cho mốc ở sát cạnh đáy khung ngắm
            const distFromBottom = (rows.length - 1) - mgmdIdx;
            if (distFromBottom === 0) {
                score += 40; // MGMD là dòng cuối cùng sát mép dưới
            } else if (distFromBottom === 1) {
                score += 30; // MGMD cách mép dưới 1 dòng (ví dụ có dòng 13 Buttons)
            } else if (distFromBottom <= 2) {
                score += 15;
            }

            if (mgmdIdx < rows.length && (rows[mgmdIdx].isMgmd || (rows[mgmdIdx].text && rows[mgmdIdx].text.includes('MGMD')))) {
                score += 25;
            }

            let denomVal = null;
            if (mgmdIdx >= 1 && isDenomRow(rows[mgmdIdx - 1].text)) {
                score += 15;
                denomVal = rows[mgmdIdx - 1].text;
            }

            // Machine No (vị trí chuẩn: mgmdIdx - 2, có dung sai +-1 dòng nếu có dải nhiễu mỏng)
            let machVal = null, machIdx = -1, machRowUsed = null;
            for (const offset of [-2, -1, -3]) {
                const idx = mgmdIdx + offset;
                if (idx >= 0 && idx < rows.length && idx !== mgmdIdx - 1) {
                    const m = parseMachineNumber(rows[idx].text);
                    if (m !== null && m < 80) { // Machine No thực tế 1-80
                        machVal = m;
                        machIdx = idx;
                        machRowUsed = rows[idx];
                        score += (offset === -2 ? 15 : 8);
                        break;
                    }
                }
            }

            // RTP 2 (vị trí chuẩn: mgmdIdx - 3)
            let rtp2Obj = null, rtp2Idx = -1, rtp2RowUsed = null;
            for (const offset of [-3, -2, -4]) {
                const idx = mgmdIdx + offset;
                if (idx >= 0 && idx < rows.length && idx !== mgmdIdx - 1 && idx !== machIdx) {
                    const r = parseRtpValue(rows[idx].text);
                    if (r !== null) {
                        rtp2Obj = r;
                        rtp2Idx = idx;
                        rtp2RowUsed = rows[idx];
                        score += (offset === -3 ? 15 : 8);
                        break;
                    }
                }
            }

            // RTP 1 (vị trí chuẩn: mgmdIdx - 4, luôn nằm trên RTP 2)
            let rtp1Obj = null, rtp1Idx = -1, rtp1RowUsed = null;
            for (const offset of [-4, -3, -5]) {
                const idx = mgmdIdx + offset;
                if (idx >= 0 && idx < rows.length && idx !== mgmdIdx - 1 && idx !== machIdx && idx !== rtp2Idx) {
                    if (rtp2Idx !== -1 && idx > rtp2Idx) continue; // RTP 1 phải nằm trên RTP 2
                    const r = parseRtpValue(rows[idx].text);
                    if (r !== null) {
                        rtp1Obj = r;
                        rtp1Idx = idx;
                        rtp1RowUsed = rows[idx];
                        score += (offset === -4 ? 15 : 8);
                        break;
                    }
                }
            }

            if (machVal !== null && rtp2Obj !== null && rtp1Obj !== null) {
                if (score > bestScore) {
                    bestScore = score;
                    bestCandidate = {
                        machineNo: machVal,
                        rtp1: rtp1Obj.val,
                        rtp2: rtp2Obj.val,
                        denom: denomVal,
                        confidence: {
                            machineNo: machRowUsed ? machRowUsed.meanConfidence : 1,
                            rtp1: rtp1RowUsed ? rtp1RowUsed.meanConfidence : 1,
                            rtp2: rtp2RowUsed ? rtp2RowUsed.meanConfidence : 1
                        },
                        autoCorrected: {
                            rtp1: rtp1Obj.autoCorrected,
                            rtp2: rtp2Obj.autoCorrected
                        },
                        allValid: true
                    };
                }
            }
        };

        // Quét từ đáy lên tìm mốc MGMD hoặc Denom
        for (let mIdx = rows.length - 1; mIdx >= 0; mIdx--) {
            const row = rows[mIdx];
            const isRowMgmd = row.isMgmd || (row.text && row.text.includes('MGMD'));
            if (isRowMgmd) {
                evaluateAnchor(mIdx);
            } else if (isDenomRow(row.text)) {
                evaluateAnchor(mIdx + 1); // Denom nằm ngay trên MGMD 1 dòng
            }
        }

        // Nếu ảnh chụp sát mép dưới mà model chưa nhận diện rõ chữ 'MGMD' hay '$0.01':
        // Thử giả thuyết mặc định theo vị trí căn mép dưới của người dùng
        if (bestScore < 40 && rows.length >= 3) {
            evaluateAnchor(rows.length - 1);
            if (rows.length >= 4) evaluateAnchor(rows.length - 2);
            if (rows.length >= 2) evaluateAnchor(rows.length); // Denom là dòng cuối cùng
        }

        return bestCandidate;
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

    return { parseStep1, parseStep2, parseRtpValue, parseMachineNumber, isDenomRow, RTP_MIN, RTP_MAX, MACHINE_NO_MIN, MACHINE_NO_MAX };
})();
