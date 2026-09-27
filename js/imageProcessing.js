/**
 * imageProcessing.js
 * -----------------------------------------------------------------------
 * Xử lý ảnh bằng OpenCV.js, thay thế Tesseract.js — chuẩn bị dữ liệu cho
 * DigitClassifier (model số tự train), theo đúng logic đã mô tả:
 *
 *   Bước 1: Adaptive threshold cục bộ (blockSize=21, C=12) ép nền về trắng.
 *   Bước 2: Tẩy hạt dither bằng connected-components + overlap mask với
 *           nét chữ gốc (opening rồi dilate nhẹ để lấy "lõi nét chữ",
 *           thành phần liên thông nào không chạm lõi này bị loại).
 *   Bước 3: Tách dòng bằng horizontal projection profile.
 *   Bước 4: Tách ký tự trong từng dòng bằng vertical projection profile,
 *           gom thành "token" (cụm ký tự liền nhau, cách nhau bởi khoảng
 *           trắng lớn = ranh giới token — dùng cho màn ngày có nhiều cụm
 *           trên 1 dòng: "Sat 24 Jan 2026 08:07:32").
 *
 * Toàn bộ chạy client-side bằng OpenCV.js (WASM), không gửi ảnh lên server.
 * -----------------------------------------------------------------------
 */

const ImageProcessing = (() => {
    let cvReady = false;

    /**
     * Chờ OpenCV.js sẵn sàng.
     *
     * QUAN TRỌNG: bản `@techstark/opencv-js` (dist/opencv.js) dùng UMD —
     * khi tải qua thẻ <script> thường (không phải module), nó gán
     * `window.cv = factory()`, và `factory()` trả về **1 Promise** (vì hàm
     * khởi tạo lõi là `async function`), CHỨ KHÔNG PHẢI object cv dùng ngay
     * được. Poll trực tiếp `cv.Mat` trên cái Promise đó sẽ không bao giờ
     * đúng (Promise không có `.Mat`) — đây là nguyên nhân thật của lỗi
     * timeout trên iOS và lỗi "không nhận diện được gì" âm thầm trên Android
     * (đã xác nhận bằng cách đọc trực tiếp file build của package).
     *
     * Cách xử lý đúng: đợi `cv` xuất hiện (script tải xong), rồi `await`
     * chính nó nếu là Promise, sau đó GHI ĐÈ lại `window.cv` bằng giá trị
     * đã resolve — để toàn bộ code còn lại (`cv.Mat`, `cv.imread`...) dùng
     * đúng object thật.
     */
    function waitForOpenCv(timeoutMs = 45000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            (function poll() {
                if (typeof cv !== 'undefined') {
                    const maybePromise = cv && typeof cv.then === 'function' ? cv : Promise.resolve(cv);
                    maybePromise.then((resolvedCv) => {
                        window.cv = resolvedCv;
                        if (!resolvedCv || !resolvedCv.Mat) {
                            reject(new Error('OpenCV.js tải xong nhưng thiếu API Mat (bản build không tương thích)'));
                            return;
                        }
                        cvReady = true;
                        resolve();
                    }).catch((e) => reject(new Error('OpenCV.js khởi tạo lỗi: ' + e.message)));
                    return;
                }
                if (Date.now() - start > timeoutMs) {
                    reject(new Error('OpenCV.js không tải được (timeout) — kiểm tra kết nối mạng rồi thử lại'));
                    return;
                }
                setTimeout(poll, 150);
            })();
        });
    }

    function isReady() { return cvReady; }

    /**
     * Threshold rẻ, dùng cho "live filter" hiển thị mượt trên liveview
     * (không chạy dedither/segment nặng — chỉ để nhân viên thấy ảnh sạch
     * hay nhiễu mà tự canh chỉnh).
     * @param {HTMLCanvasElement} srcCanvas
     * @param {HTMLCanvasElement} outCanvas vẽ kết quả ra đây
     */
    function liveThresholdPreview(srcCanvas, outCanvas) {
        const src = cv.imread(srcCanvas);
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        const bin = new cv.Mat();
        cv.adaptiveThreshold(
            gray, bin, 255,
            cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY,
            21, 12
        );
        cv.imshow(outCanvas, bin);
        src.delete(); gray.delete(); bin.delete();
    }

    /**
     * Threshold + dedither — dùng để TÁCH VỊ TRÍ dòng/ký tự (segmentRows,
     * segmentCharsIntoTokens, tightVerticalBounds), KHÔNG dùng làm ảnh đưa
     * vào model nữa (model mới train trên ảnh xám gốc, xem cropCharForClassifier).
     * Trả về { binMat, grayMat } — CALLER PHẢI tự .delete() cả 2 Mat.
     */
    function thresholdAndDedither(srcCanvas) {
        const src = cv.imread(srcCanvas);
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

        // Bước 1: GaussianBlur nhẹ 3x3 trước adaptive threshold để triệt tiêu nhiễu lưới moiré / dithering LCD
        // mà vẫn bảo toàn 100% hình thái nét chữ số thật.
        const blur = new cv.Mat();
        cv.GaussianBlur(gray, blur, new cv.Size(3, 3), 0);

        const bin = new cv.Mat();
        cv.adaptiveThreshold(
            blur, bin, 255,
            cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY,
            21, 16
        );

        // Đảo âm bản: chữ = trắng (255) trên nền đen (0) chuẩn cho tách dòng/ký tự.
        const cleaned = new cv.Mat();
        cv.bitwise_not(bin, cleaned);

        src.delete(); blur.delete(); bin.delete();

        // Bước 2: Xóa viền biên trái / phải (3px) để triệt tiêu viền khung cắt
        const rCount = cleaned.rows, cCount = cleaned.cols;
        const cData = cleaned.data;
        for (let y = 0; y < rCount; y++) {
            const rowBase = y * cCount;
            for (let x = 0; x < 3; x++) cData[rowBase + x] = 0;
            for (let x = Math.max(0, cCount - 3); x < cCount; x++) cData[rowBase + x] = 0;
        }

        // Trả về { binMat: cleaned, grayMat: gray } — Caller tự .delete() cả 2.
        return { binMat: cleaned, grayMat: gray };
    }

    /**
     * Tách dòng bằng horizontal projection profile.
     * @param {cv.Mat} binMat ảnh nhị phân (text=255) từ thresholdAndDedither
     * @param {number} minRowHeight bỏ qua dải quá mỏng (nhiễu)
     * @returns {{y0:number, y1:number}[]} danh sách dải hàng theo thứ tự trên->dưới
     */
    function segmentRows(binMat, minRowHeight = 6) {
        const rows = binMat.rows, cols = binMat.cols;
        const data = binMat.data;
        const rowSum = new Int32Array(rows);
        for (let y = 0; y < rows; y++) {
            let sum = 0;
            const base = y * cols;
            for (let x = 0; x < cols; x++) sum += data[base + x] > 0 ? 1 : 0;
            rowSum[y] = sum;
        }
        // Dùng trễ ngưỡng (hysteresis):
        // Ngưỡng kích hoạt dải: rowSum >= 8 (loại bỏ hoàn toàn đốm dither li ti giữa các dòng)
        // Điều kiện chấp nhận dải: chiều cao >= minRowHeight (6px) VÀ đỉnh nét chữ rowSum >= 15
        const thActive = 8;
        const bands = [];
        let inBand = false, y0 = 0;
        for (let y = 0; y < rows; y++) {
            const active = rowSum[y] >= thActive;
            if (active && !inBand) { inBand = true; y0 = y; }
            if (!active && inBand) {
                inBand = false;
                let maxVal = 0;
                for (let k = y0; k < y; k++) if (rowSum[k] > maxVal) maxVal = rowSum[k];
                if (y - y0 >= minRowHeight && maxVal >= 15) bands.push({ y0, y1: y });
            }
        }
        if (inBand && rows - y0 >= minRowHeight) {
            let maxVal = 0;
            for (let k = y0; k < rows; k++) if (rowSum[k] > maxVal) maxVal = rowSum[k];
            if (maxVal >= 15) bands.push({ y0, y1: rows });
        }

        // Gom các dải quá gần nhau (< 5px) lại thành 1 dòng thống nhất
        const mergedBands = [];
        for (const band of bands) {
            if (mergedBands.length === 0) {
                mergedBands.push(band);
            } else {
                const prev = mergedBands[mergedBands.length - 1];
                if (band.y0 - prev.y1 < 5) {
                    mergedBands[mergedBands.length - 1] = { y0: prev.y0, y1: band.y1 };
                } else {
                    mergedBands.push(band);
                }
            }
        }

        const final = [];
        for (const band of mergedBands) final.push(...splitByLocalMinima(rowSum, band, minRowHeight));
        return final;
    }

    function splitByLocalMinima(rowSum, band, minRowHeight) {
        const vals = [];
        for (let y = band.y0; y < band.y1; y++) if (rowSum[y] > 0) vals.push(rowSum[y]);
        if (vals.length === 0) return [band];
        vals.sort((a, b) => a - b);
        const peakRef = vals[Math.floor(vals.length * 0.8)]; // mức "đỉnh" điển hình (percentile 80)
        const valleyThreshold = peakRef * 0.25;

        const win = 3;
        const splitPoints = [];
        let lastSplit = band.y0;
        for (let y = band.y0 + minRowHeight; y < band.y1 - minRowHeight; y++) {
            if (rowSum[y] > valleyThreshold) continue;
            if (y - lastSplit < minRowHeight) continue;
            let isLocalMin = true;
            for (let k = Math.max(band.y0, y - win); k <= Math.min(band.y1 - 1, y + win); k++) {
                if (rowSum[k] < rowSum[y]) { isLocalMin = false; break; }
            }
            if (isLocalMin) { splitPoints.push(y); lastSplit = y; }
        }
        if (splitPoints.length === 0) return [band];

        const result = [];
        let prev = band.y0;
        for (const sp of splitPoints) { result.push({ y0: prev, y1: sp }); prev = sp; }
        result.push({ y0: prev, y1: band.y1 });
        return result.filter((b) => b.y1 - b.y0 >= minRowHeight);
    }

    /**
     * Tách ký tự trong 1 dải hàng bằng vertical projection profile, gom
     * thành token (cụm ký tự cách nhau khoảng trắng lớn = ranh giới token).
     */
    function segmentCharsIntoTokens(binMat, band, gapForTokenBreak = 20) {
        const cols = binMat.cols;
        const data = binMat.data;
        const colSum = new Int32Array(cols);
        for (let x = 0; x < cols; x++) {
            let sum = 0;
            for (let y = band.y0; y < band.y1; y++) {
                sum += data[y * cols + x] > 0 ? 1 : 0;
            }
            colSum[x] = sum;
        }
        const bandHeight = band.y1 - band.y0;
        const colThreshold = Math.max(2, Math.round(bandHeight * 0.05));
        const charBoxes = [];
        let inChar = false, x0 = 0;
        for (let x = 0; x < cols; x++) {
            const active = colSum[x] >= colThreshold;
            if (active && !inChar) { inChar = true; x0 = x; }
            if (!active && inChar) {
                inChar = false;
                // Chữ số thật có bề ngang tối thiểu >= 6px (loại bỏ vết nhiễu sọc bảng dọc < 6px)
                if (x - x0 >= 6) {
                    charBoxes.push({ x0, x1: x });
                }
            }
        }
        if (inChar && (cols - x0 >= 6)) {
            charBoxes.push({ x0, x1: cols });
        }

        const tokens = [];
        let current = [];
        for (let i = 0; i < charBoxes.length; i++) {
            if (current.length === 0) {
                current.push(charBoxes[i]);
                continue;
            }
            const prev = current[current.length - 1];
            const gap = charBoxes[i].x0 - prev.x1;
            if (gap > gapForTokenBreak) {
                tokens.push(current);
                current = [charBoxes[i]];
            } else {
                current.push(charBoxes[i]);
            }
        }
        if (current.length > 0) tokens.push(current);

        return tokens;
    }

    /**
     * Tính bounding box THẬT (theo pixel có chữ) của 1 ký tự bên trong dải cột [x0,x1)
     */
    function tightVerticalBounds(binMat, band, box) {
        const cols = binMat.cols;
        const data = binMat.data;
        let top = -1, bottom = -1;
        // Quét tìm top/bottom yêu cầu tối thiểu 2 pixel ink trong dòng để loại bỏ hạt nhiễu đơn lẻ
        for (let y = band.y0; y < band.y1; y++) {
            let inkCount = 0;
            const base = y * cols;
            for (let x = box.x0; x < box.x1; x++) {
                if (data[base + x] > 0) inkCount++;
            }
            if (inkCount >= 2) {
                if (top === -1) top = y;
                bottom = y;
            }
        }
        // Fallback nếu ký tự quá mảnh (chỉ 1px)
        if (top === -1) {
            for (let y = band.y0; y < band.y1; y++) {
                let hasInk = false;
                const base = y * cols;
                for (let x = box.x0; x < box.x1; x++) {
                    if (data[base + x] > 0) { hasInk = true; break; }
                }
                if (hasInk) {
                    if (top === -1) top = y;
                    bottom = y;
                }
            }
        }
        if (top === -1) return { y0: band.y0, y1: band.y1 };
        return { y0: top, y1: bottom + 1 };
    }

    /**
     * Chuẩn hoá crop về kích thước 32x128 cho Model 4.0:
     * - Giữ nguyên tỉ lệ (aspect ratio).
     * - Đặt ở giữa khung canvas 32x128 có viền trắng 255.
     * - Chuẩn hoá (v / 127.5) - 1.0 (dải [-1.0, 1.0]).
     */
    /**
     * Tính median mức xám của viền ngoài bằng histogram 256 mức:
     * O(N) cực nhanh, không cấp phát mảng, không tốn thời gian gọi .sort().
     */
    function getBorderMedianFast(data, w, h) {
        const hist = new Uint16Array(256);
        let total = 0;
        // Hàng trên cùng & hàng dưới cùng
        const topRow = 0;
        const btmRow = (h - 1) * w;
        for (let x = 0; x < w; x++) {
            hist[data[topRow + x]]++;
            hist[data[btmRow + x]]++;
            total += 2;
        }
        // Cột trái & cột phải
        for (let y = 1; y < h - 1; y++) {
            const rowOffset = y * w;
            hist[data[rowOffset]]++;
            hist[data[rowOffset + (w - 1)]]++;
            total += 2;
        }
        if (total === 0) return 255;
        const mid = total >> 1;
        let count = 0;
        for (let v = 0; v < 256; v++) {
            count += hist[v];
            if (count >= mid) return v;
        }
        return 255;
    }

    /**
     * Tiền xử lý chuẩn cho Model 4.0 (32x128):
     * Tối ưu hóa hiệu năng cao:
     * - Co/giãn giữ nguyên tỉ lệ aspect ratio.
     * - Tính padColor qua getBorderMedianFast (O(N)).
     * - Ghi trực tiếp vào Float32Array(4096), triệt tiêu hoàn toàn việc tạo canvasMat,
     *   roiTarget, copyTo trong WASM.
     */
    function padAndNormalizeForModel4(cropMat) {
        const targetH = 32;
        const targetW = 128;
        const h = cropMat.rows;
        const w = cropMat.cols;

        const scale = Math.min(targetH / Math.max(1, h), targetW / Math.max(1, w));
        const newW = Math.max(1, Math.round(w * scale));
        const newH = Math.max(1, Math.round(h * scale));

        const resized = new cv.Mat();
        cv.resize(cropMat, resized, new cv.Size(newW, newH), 0, 0, scale < 1 ? cv.INTER_AREA : cv.INTER_CUBIC);

        const rData = resized.data;
        const padColor = getBorderMedianFast(rData, newW, newH);
        const padNorm = (padColor / 127.5) - 1.0;

        const out = new Float32Array(4096);
        out.fill(padNorm);

        const xOff = Math.floor((targetW - newW) / 2);
        const yOff = Math.floor((targetH - newH) / 2);

        for (let y = 0; y < newH; y++) {
            const srcBase = y * newW;
            const dstBase = (yOff + y) * targetW + xOff;
            for (let x = 0; x < newW; x++) {
                out[dstBase + x] = (rData[srcBase + x] / 127.5) - 1.0;
            }
        }

        resized.delete();
        return out;
    }

    /**
     * Crop 1 ký tự đơn lẻ đưa vào Model 4.0 (32x128)
     */
    function cropCharForClassifier(grayMat, binMat, band, box) {
        const tightY = tightVerticalBounds(binMat, band, box);
        const x = Math.max(0, Math.min(box.x0, grayMat.cols - 1));
        const y = Math.max(0, Math.min(tightY.y0, grayMat.rows - 1));
        const w = Math.max(1, Math.min(box.x1 - box.x0, grayMat.cols - x));
        const h = Math.max(1, Math.min(tightY.y1 - tightY.y0, grayMat.rows - y));

        const rect = new cv.Rect(x, y, w, h);
        const charMat = grayMat.roi(rect);
        const out = padAndNormalizeForModel4(charMat);
        charMat.delete();
        return out;
    }

    /**
     * Crop 1 cụm ký tự (cluster/token, ví dụ cụm "MGMD") đưa vào Model 4.0
     */
    function cropClusterForClassifier(grayMat, binMat, band, x0, x1) {
        const box = { x0, x1 };
        const tightY = tightVerticalBounds(binMat, band, box);
        const x = Math.max(0, Math.min(x0, grayMat.cols - 1));
        const y = Math.max(0, Math.min(tightY.y0, grayMat.rows - 1));
        const w = Math.max(1, Math.min(x1 - x0, grayMat.cols - x));
        const h = Math.max(1, Math.min(tightY.y1 - tightY.y0, grayMat.rows - y));

        const rect = new cv.Rect(x, y, w, h);
        const clusterMat = grayMat.roi(rect);
        const out = padAndNormalizeForModel4(clusterMat);
        clusterMat.delete();
        return out;
    }

    return {
        waitForOpenCv,
        isReady,
        liveThresholdPreview,
        thresholdAndDedither,
        segmentRows,
        segmentCharsIntoTokens,
        tightVerticalBounds,
        cropCharForClassifier,
        cropClusterForClassifier,
    };
})();

