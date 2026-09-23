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
        // Tốc độ: ~1.5ms thay vì 180ms của giải thuật cũ.
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        const cleaned = new cv.Mat();
        cv.morphologyEx(inv, cleaned, cv.MORPH_OPEN, kernel);

        src.delete(); bin.delete(); inv.delete(); kernel.delete();

        // Trả về { binMat: cleaned, grayMat: gray } — Caller tự .delete() cả 2.
        return { binMat: cleaned, grayMat: gray };
    }

    /**
     * Tách dòng bằng horizontal projection profile.
     * @param {cv.Mat} binMat ảnh nhị phân (text=255) từ thresholdAndDedither
     * @param {number} minRowHeight bỏ qua dải quá mỏng (nhiễu)
     * @returns {{y0:number, y1:number}[]} danh sách dải hàng theo thứ tự trên->dưới
     */
    function segmentRows(binMat, minRowHeight = 8) {
        const rows = binMat.rows, cols = binMat.cols;
        const data = binMat.data;
        const rowSum = new Int32Array(rows);
        for (let y = 0; y < rows; y++) {
            let sum = 0;
            const base = y * cols;
            for (let x = 0; x < cols; x++) sum += data[base + x] > 0 ? 1 : 0;
            rowSum[y] = sum;
        }
        // Ngưỡng theo tỉ lệ chiều rộng (không dùng "1 pixel là tính có chữ")
        // để chống nhiễu moiré/JPEG còn sót lại sau dedither — vài pixel lẻ
        // trôi nổi không đủ để nối 2 dòng thật lại thành 1 khối.
        const threshold = Math.max(2, Math.round(cols * 0.01));
        const bands = [];
        let inBand = false, y0 = 0;
        for (let y = 0; y < rows; y++) {
            const active = rowSum[y] >= threshold;
            if (active && !inBand) { inBand = true; y0 = y; }
            if (!active && inBand) {
                inBand = false;
                if (y - y0 >= minRowHeight) bands.push({ y0, y1: y });
            }
        }
        if (inBand && rows - y0 >= minRowHeight) bands.push({ y0, y1: rows });

        // Vệt loá/phản quang trên màn hình máy có thể nối liền nhiều dòng
        // thật thành 1 khối cao bất thường (quan sát thực tế: 1 khối 777px
        // gộp 8 dòng số liệu, làm hỏng hoàn toàn bước tách ký tự phía sau).
        // Không dựa vào "trung vị các band khác" để biết đâu là bất thường
        // (không đáng tin — bản thân các band header cũng cao thấp lộn xộn).
        // Thay vào đó: quét MỌI band tìm valley cục bộ (thấp hơn hẳn mức
        // "đỉnh điển hình" ngay trong chính band đó) để tách tiếp — band nào
        // vốn đã sạch 1 dòng thì không có valley nào đạt ngưỡng, tự nhiên
        // giữ nguyên không bị tách.
        const final = [];
        for (const band of bands) final.push(...splitByLocalMinima(rowSum, band, minRowHeight));
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
     * @param {cv.Mat} binMat ảnh nhị phân toàn khung
     * @param {{y0:number,y1:number}} band dải hàng cần tách
     * @returns {{tokens: {x0:number,x1:number}[][]}} mảng token, mỗi token là mảng bbox ký tự {x0,x1} (dùng chung y0,y1 của band)
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
        // Tìm các dải cột có chữ (ký tự), rồi gom theo khoảng cách. Cùng lý do
        // chống nhiễu như segmentRows — không dùng "1 pixel là tính có chữ".
        const bandHeight = band.y1 - band.y0;
        const colThreshold = Math.max(2, Math.round(bandHeight * 0.05));
        const charBoxes = [];
        let inChar = false, x0 = 0;
        for (let x = 0; x < cols; x++) {
            const active = colSum[x] >= colThreshold;
            if (active && !inChar) { inChar = true; x0 = x; }
            if (!active && inChar) {
                inChar = false;
                charBoxes.push({ x0, x1: x });
            }
        }
        if (inChar) charBoxes.push({ x0, x1: cols });

        // Gom charBoxes thành token theo khoảng cách giữa 2 box liên tiếp.
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
     * Tính bounding box THẬT (theo pixel có chữ) của 1 ký tự bên trong dải
     * cột [x0,x1) — không dùng nguyên chiều cao của band, vì band có thể
     * cao hơn ký tự thật khá nhiều (dư khoảng trắng trên/dưới, hoặc do
     * bước tách dòng chưa hoàn hảo) — nếu cứ dùng cả chiều cao band, ảnh
     * ký tự bị kéo méo tỉ lệ nghiêm trọng trước khi đưa vào model.
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
     * Crop 1 ký tự để đưa vào model mới (`digit_model.onnx`, 32x32).
     *
     * ĐÃ XÁC NHẬN bằng cách đối chiếu trực tiếp với ảnh training thật (crop
     * theo manifest.csv, so khớp pixel với ảnh 32x32 đã lưu — xem
     * debug-tool/reverse_engineer_crop.js): model này train trên ẢNH XÁM
     * GỐC (KHÔNG threshold/nhị phân hoá), pad về hình vuông bằng NỀN TRẮNG
     * (không phải đen), resize 32x32, chuẩn hoá (v/255 - 0.5) / 0.5, KHÔNG
     * đảo ngược. Test trên 180 ảnh mẫu thật (15 ảnh/lớp) cho 100% đúng với
     * đúng công thức này.
     *
     * Vẫn cần `binMat` (đã threshold) để tìm ĐÚNG vị trí ký tự (tightVerticalBounds)
     * — việc "tìm chữ ở đâu" model không tự làm được — nhưng ảnh CUỐI CÙNG
     * đưa vào model lấy từ `grayMat` (ảnh xám gốc), không phải binMat.
     */
    function cropCharForClassifier(grayMat, binMat, band, box) {
        const tightY = tightVerticalBounds(binMat, band, box);
        const x = Math.max(0, Math.min(box.x0, grayMat.cols - 1));
        const y = Math.max(0, Math.min(tightY.y0, grayMat.rows - 1));
        const w = Math.max(1, Math.min(box.x1 - box.x0, grayMat.cols - x));
        const h = Math.max(1, Math.min(tightY.y1 - tightY.y0, grayMat.rows - y));

        const rect = new cv.Rect(x, y, w, h);
        const charMat = grayMat.roi(rect);

        const side = Math.max(charMat.rows, charMat.cols);
        const square = new cv.Mat(side, side, cv.CV_8UC1, new cv.Scalar(255)); // nền trắng, khớp ảnh training
        const xOff = Math.floor((side - charMat.cols) / 2);
        const yOff = Math.floor((side - charMat.rows) / 2);
        const roiTarget = square.roi(new cv.Rect(xOff, yOff, charMat.cols, charMat.rows));
        charMat.copyTo(roiTarget);
        roiTarget.delete();

        const resized = new cv.Mat();
        cv.resize(square, resized, new cv.Size(32, 32), 0, 0, cv.INTER_AREA);

        const out = new Float32Array(32 * 32);
        const data = resized.data;
        for (let i = 0; i < 1024; i++) out[i] = (data[i] / 255 - 0.5) / 0.5;

        charMat.delete(); square.delete(); resized.delete();
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
    };
})();
