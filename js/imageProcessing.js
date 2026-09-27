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

        // Bước 1: adaptive threshold — nền về trắng (255), chữ tối hơn.
        const bin = new cv.Mat();
        cv.adaptiveThreshold(
            gray, bin, 255,
            cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY,
            21, 12
        );

        // Đảo âm bản: chữ = trắng (255) trên nền đen (0), chuẩn cho
        // connectedComponents (mong đợi foreground trắng).
        const inv = new cv.Mat();
        cv.bitwise_not(bin, inv);

        // Bước 2: Tối ưu hóa siêu tốc — thay thế connectedComponents và 700.000 vòng lặp JS
        // bằng toán tử hình thái học MORPH_OPEN thuần C++ WASM.
        // Opening (erode + dilate) với kernel 2x2 loại bỏ triệt để các hạt dither 1-2px,
        // trong khi bảo toàn 100% nét chữ số (dày 3-5px).
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        const cleaned = new cv.Mat();
        cv.morphologyEx(inv, cleaned, cv.MORPH_OPEN, kernel);

        src.delete(); bin.delete(); inv.delete(); kernel.delete();

        // Bước 3: Khử viền biên và đường kẻ dọc bảng biểu của màn hình máy đánh bạc
        const rCount = cleaned.rows, cCount = cleaned.cols;
        const cData = cleaned.data;

        // Xóa viền biên trái / phải (3px) để triệt tiêu viền khung cắt / viền màn hình
        for (let y = 0; y < rCount; y++) {
            for (let x = 0; x < 3; x++) cData[y * cCount + x] = 0;
            for (let x = Math.max(0, cCount - 3); x < cCount; x++) cData[y * cCount + x] = 0;
        }

        // Các cột có tỉ lệ điểm trắng > 30% chiều cao là đường kẻ dọc cột, gây nhiễu dính liền các dòng
        const colsToClear = [];
        for (let x = 3; x < cCount - 3; x++) {
            let colWhite = 0;
            for (let y = 0; y < rCount; y++) {
                if (cData[y * cCount + x] > 0) colWhite++;
            }
            if (colWhite > rCount * 0.30) {
                colsToClear.push(x);
            }
        }
        for (const cx of colsToClear) {
            for (let dx = -1; dx <= 1; dx++) {
                const targetX = cx + dx;
                if (targetX >= 0 && targetX < cCount) {
                    for (let y = 0; y < rCount; y++) {
                        cData[y * cCount + targetX] = 0;
                    }
                }
            }
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
        // Dùng trễ ngưỡng (hysteresis) để không bỏ sót các dòng chỉ có 1 chữ số mỏng (như Machine No '3' hay '1')
        // Ngưỡng kích hoạt dải: rowSum >= 3 (bắt đầu theo dõi nét chữ)
        // Điều kiện chấp nhận dải: chiều cao >= minRowHeight (6px) VÀ đỉnh nét chữ rowSum >= 8 (loại bỏ nhiễu mờ)
        const thActive = 3;
        const bands = [];
        let inBand = false, y0 = 0;
        for (let y = 0; y < rows; y++) {
            const active = rowSum[y] >= thActive;
            if (active && !inBand) { inBand = true; y0 = y; }
            if (!active && inBand) {
                inBand = false;
                let maxVal = 0;
                for (let k = y0; k < y; k++) if (rowSum[k] > maxVal) maxVal = rowSum[k];
                if (y - y0 >= minRowHeight && maxVal >= 8) bands.push({ y0, y1: y });
            }
        }
        if (inBand && rows - y0 >= minRowHeight) {
            let maxVal = 0;
            for (let k = y0; k < rows; k++) if (rowSum[k] > maxVal) maxVal = rowSum[k];
            if (maxVal >= 8) bands.push({ y0, y1: rows });
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
    function segmentCharsIntoTokens(binMat, band, gapForTokenBreak = 10) {
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
                if (x - x0 >= 3) {
                    charBoxes.push({ x0, x1: x });
                }
            }
        }
        if (inChar && (cols - x0 >= 3)) {
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
        if (top === -1) return { y0: band.y0, y1: band.y1 };
        return { y0: top, y1: bottom + 1 };
    }

    /**
     * Chuẩn hoá crop về kích thước 32x128 cho Model 4.0:
     * - Giữ nguyên tỉ lệ (aspect ratio).
     * - Đặt ở giữa khung canvas 32x128 có viền trắng 255.
     * - Chuẩn hoá (v / 127.5) - 1.0 (dải [-1.0, 1.0]).
     */
    function getBorderMedian(mat) {
        const w = mat.cols;
        const h = mat.rows;
        const data = mat.data;
        const borderPixels = [];

        // Hàng trên cùng & hàng dưới cùng
        for (let x = 0; x < w; x++) {
            borderPixels.push(data[x]);
            borderPixels.push(data[(h - 1) * w + x]);
        }
        // Cột trái & cột phải
        for (let y = 1; y < h - 1; y++) {
            borderPixels.push(data[y * w]);
            borderPixels.push(data[y * w + (w - 1)]);
        }
        if (borderPixels.length === 0) return 255;
        borderPixels.sort((a, b) => a - b);
        return borderPixels[Math.floor(borderPixels.length / 2)];
    }

    /**
     * Tiền xử lý chuẩn cho Model 4.0 (32x128) đồng nhất 100% với Python predict_model4.py:
     * - Giữ nguyên aspect ratio, co/giãn về kích thước (newW, newH) vừa vặn trong 32x128
     * - Lấy median các pixel viền ngoài (border median) làm màu nền đệm
     * - Đặt ký tự vào chính giữa canvas 32x128
     * - Chuẩn hoá điểm ảnh: (pixel / 127.5) - 1.0 (dải [-1.0, 1.0])
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

        const padColor = getBorderMedian(resized);
        const canvasMat = new cv.Mat(targetH, targetW, cv.CV_8UC1, new cv.Scalar(padColor));
        const xOff = Math.floor((targetW - newW) / 2);
        const yOff = Math.floor((targetH - newH) / 2);
        const roiTarget = canvasMat.roi(new cv.Rect(xOff, yOff, newW, newH));
        resized.copyTo(roiTarget);
        roiTarget.delete();

        const out = new Float32Array(targetH * targetW);
        const data = canvasMat.data;
        for (let i = 0; i < targetH * targetW; i++) {
            out[i] = (data[i] / 127.5) - 1.0;
        }

        resized.delete();
        canvasMat.delete();
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

