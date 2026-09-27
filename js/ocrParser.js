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

        // 1. Ưu tiên số có dấu % đứng sau (ví dụ: 93.966%, 93.56%)
        const pctMatch = text.match(/(8\d|9\d)(?:\.(\d+))?\s*%/);
        if (pctMatch) {
            const val = pctMatch[2] ? Number(pctMatch[1] + '.' + pctMatch[2]) : Number(pctMatch[1]);
            if (val >= RTP_MIN && val <= RTP_MAX) return { val, autoCorrected: !pctMatch[2] };
        }

        // 2. Tìm số 8x hoặc 9x có dấu chấm thập phân
        const decMatch = text.match(/(8\d|9\d)\.(\d{2,4})/);
        if (decMatch) {
            const val = Number(decMatch[1] + '.' + decMatch[2]);
            if (val >= RTP_MIN && val <= RTP_MAX) return { val, autoCorrected: false };
        }

        // 3. Dự phòng không có dấu chấm: chuỗi 8x hoặc 9x liền sau 2-3 chữ số
        const digitsOnly = text.replace(/[^0-9]/g, '');
        const numMatch = digitsOnly.match(/(8\d|9\d)(\d{2,3})/);
        if (numMatch) {
            const val = Number(numMatch[1] + '.' + numMatch[2]);
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
        const digits = text.replace(/[^0-9]/g, '');
        if (!digits) return null;
        const val = Number(digits);
        if (val >= MACHINE_NO_MIN && val <= MACHINE_NO_MAX) return val;
        return null;
    }

    /**
     * Nhận diện dòng Denom (chứa $ hoặc mệnh giá như $0.01)
     * @param {string} text
     * @returns {boolean}
     */
    function isDenomRow(text) {
        if (!text) return false;
        return text.includes('$') || /0\.\d{2}/.test(text) || text.includes('001') || text.includes('002') || text.includes('005');
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

        let bestCandidate = null;
        let bestScore = -1;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const isAnchorMgmd = row.isMgmd || (row.text && row.text.includes('MGMD'));

            // Thử xét mốc i là MGMD (hoặc i là Denom -> MGMD là i + 1)
            let mgmdIdx = -1;
            if (isAnchorMgmd) {
                mgmdIdx = i;
            } else if (isDenomRow(row.text)) {
                mgmdIdx = i + 1; // Denom nằm ngay trên MGMD 1 dòng
            }

            if (mgmdIdx === -1 || mgmdIdx < 2) continue;

            // Đánh giá cấu trúc dòng phía trên theo đúng yêu cầu:
            // mgmdIdx - 1: Denom ($0.01)
            // mgmdIdx - 2: Machine No (3)
            // mgmdIdx - 3: RTP 2 (93.56%)
            // mgmdIdx - 4: RTP 1 (93.966%)

            let score = 0;
            if (mgmdIdx < rows.length && (rows[mgmdIdx].isMgmd || (rows[mgmdIdx].text && rows[mgmdIdx].text.includes('MGMD')))) {
                score += 20;
            }

            const denomRow = rows[mgmdIdx - 1];
            if (denomRow && isDenomRow(denomRow.text)) {
                score += 10;
            }

            // Machine No (vị trí chuẩn: mgmdIdx - 2, có dung sai nếu có dải nhiễu mỏng)
            let machVal = null, machRowUsed = null;
            for (const offset of [-2, -1, -3]) {
                const idx = mgmdIdx + offset;
                if (idx >= 0 && idx < rows.length && idx !== mgmdIdx - 1) {
                    const m = parseMachineNumber(rows[idx].text);
                    if (m !== null) {
                        machVal = m;
                        machRowUsed = rows[idx];
                        score += (offset === -2 ? 15 : 8);
                        break;
                    }
                }
            }

            // RTP 2 (vị trí chuẩn: mgmdIdx - 3)
            let rtp2Obj = null, rtp2RowUsed = null;
            for (const offset of [-3, -2, -4]) {
                const idx = mgmdIdx + offset;
                if (idx >= 0 && idx < rows.length && idx !== mgmdIdx - 1 && rows[idx] !== machRowUsed) {
                    const r = parseRtpValue(rows[idx].text);
                    if (r !== null) {
                        rtp2Obj = r;
                        rtp2RowUsed = rows[idx];
                        score += (offset === -3 ? 15 : 8);
                        break;
                    }
                }
            }

            // RTP 1 (vị trí chuẩn: mgmdIdx - 4)
            let rtp1Obj = null, rtp1RowUsed = null;
            for (const offset of [-4, -3, -5]) {
                const idx = mgmdIdx + offset;
                if (idx >= 0 && idx < rows.length && idx !== mgmdIdx - 1 && rows[idx] !== machRowUsed && rows[idx] !== rtp2RowUsed) {
                    const r = parseRtpValue(rows[idx].text);
                    if (r !== null) {
                        rtp1Obj = r;
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

    return { parseStep1, parseStep2, parseRtpValue, parseMachineNumber, RTP_MIN, RTP_MAX, MACHINE_NO_MIN, MACHINE_NO_MAX };
})();
