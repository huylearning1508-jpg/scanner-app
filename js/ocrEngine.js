/**
 * ocrEngine.js
 * -----------------------------------------------------------------------
 * Thay thế bản Tesseract.js cũ — pipeline nhanh dùng model số tự train:
 * threshold+dedither (ImageProcessing) -> tách dòng/ký tự -> batch qua
 * DigitClassifier (onnxruntime-web) -> trả về DÒNG/TOKEN đã nhận diện cho
 * OcrParser xử lý tiếp (anchor-"$" ở Bước 1, ngày/năm ở Bước 2).
 *
 * Tối ưu tốc độ:
 *  - Chỉ xử lý dải giữa khung ngắm (GUIDE_BAND), không xử lý cả frame.
 *  - Chạy pipeline nặng theo nhịp throttle (~200ms), không phải mỗi frame video.
 *  - Gộp toàn bộ ký tự phát hiện được trong 1 khung thành 1 lần gọi model
 *    (batch inference) thay vì gọi từng ký tự.
 * -----------------------------------------------------------------------
 */

const OcrEngine = (() => {
    // Giống CameraX STRATEGY_KEEP_ONLY_LATEST: không dùng tick cố định chờ hết
    // 200ms mới xử lý tiếp (làm chậm giả tạo khi frame xử lý nhanh) — chỉ nghỉ
    // 1 khoảng ngắn để nhường event loop (UI, camera decode) rồi lấy NGAY frame
    // mới nhất hiện có xử lý tiếp. Tốc độ thực tế tự dao động theo độ phức tạp
    // của từng frame, không bị ép cứng theo 1 nhịp cố định.
    const TICK_IDLE_MS = 30;
    // An toàn: nếu 1 frame nhiễu (loá/moiré) khiến tách ra quá nhiều "ký tự" giả,
    // bỏ qua luôn thay vì tốn thời gian classify hàng trăm box rác — đây là
    // nguyên nhân chính gây "đôi lúc rất chậm" (đã quan sát thực tế).
    const MAX_CHARS_PER_FRAME = 120;
    // Camera điện thoại độ phân giải cao (>10MP) chụp cận màn hình LCD sẽ lộ
    // rõ từng điểm ảnh của màn hình (hiệu ứng moiré/lưới chấm dày đặc) — đã
    // xác nhận thực nghiệm điều này phá hỏng hoàn toàn threshold+segment nếu
    // xử lý ở độ phân giải gốc. Luôn resize vùng crop về độ rộng chuẩn này
    // trước khi threshold (downscale đóng vai trò lọc thông thấp, xoá nhiễu
    // lưới chấm) — không upscale nếu crop đã nhỏ hơn.
    // Kích thước chuẩn tối ưu: 420px đảm bảo ký tự cao ~35-45px (rất sắc nét cho model 32x32),
    // đồng thời giảm 65% số lượng pixel cần xử lý, tăng tốc toàn bộ pipeline gấp 2.5 lần.
    const PROCESSING_TARGET_WIDTH = 420;

    let running = false;
    let paused = false;
    let loopHandle = null;

    const workCanvas = document.createElement('canvas');

    // Cache toạ độ khung ngắm để loại bỏ hoàn toàn forced layout reflow (getBoundingClientRect)
    // ở mỗi frame. Chỉ tính lại khi xoay màn hình hoặc đổi kích cỡ cửa sổ.
    let cachedCoords = null;
    function invalidateGuideCache() {
        cachedCoords = null;
    }
    window.addEventListener('resize', invalidateGuideCache);
    window.addEventListener('orientationchange', invalidateGuideCache);

    async function init(onProgress = null) {
        await Promise.all([
            ImageProcessing.waitForOpenCv(),
            DigitClassifier.init('models/digit_model.onnx', 'models/classes.json', onProgress)
        ]);
    }

    function getGuideCropCoords(vw, vh) {
        const videoEl = document.getElementById('video');
        if (!videoEl) return null;

        const containerW = videoEl.clientWidth;
        const containerH = videoEl.clientHeight;
        if (containerW <= 0 || containerH <= 0) return null;

        if (cachedCoords && 
            cachedCoords.vw === vw && 
            cachedCoords.vh === vh && 
            cachedCoords.cw === containerW && 
            cachedCoords.ch === containerH) {
            return cachedCoords;
        }

        const guideEl = document.getElementById('guideRect');
        // Đọc toạ độ phần trăm trực tiếp từ SVG rect (chuẩn xác 100% không phụ thuộc scroll hay layout reflow)
        let gxPct = 30, gyPct = 15, gwPct = 65, ghPct = 70;
        if (guideEl) {
            gxPct = parseFloat(guideEl.getAttribute('x')) || 30;
            gyPct = parseFloat(guideEl.getAttribute('y')) || 15;
            gwPct = parseFloat(guideEl.getAttribute('width')) || 65;
            ghPct = parseFloat(guideEl.getAttribute('height')) || 70;
        }

        // Tỷ lệ scale khi CSS object-fit: cover lấp đầy cameraContainer
        const scale = Math.max(containerW / vw, containerH / vh);
        const renderedW = vw * scale;
        const renderedH = vh * scale;

        // Vị trí offset của video bên trong container (video căn giữa theo CSS object-position: 50% 50%)
        const offX = (renderedW - containerW) / 2;
        const offY = (renderedH - containerH) / 2;

        // Toạ độ khung xanh trên container (pixel thực trên màn hình)
        const boxLeft = (gxPct / 100) * containerW;
        const boxTop = (gyPct / 100) * containerH;
        const boxWidth = (gwPct / 100) * containerW;
        const boxHeight = (ghPct / 100) * containerH;

        // Quy đổi chính xác 1:1 sang toạ độ pixel của video gốc trong camera
        const sx = Math.max(0, Math.round((boxLeft + offX) / scale));
        const sy = Math.max(0, Math.round((boxTop + offY) / scale));
        const sw = Math.min(vw - sx, Math.round(boxWidth / scale));
        const sh = Math.min(vh - sy, Math.round(boxHeight / scale));

        let outW = sw, outH = sh;
        if (sw > PROCESSING_TARGET_WIDTH) {
            const ratio = PROCESSING_TARGET_WIDTH / sw;
            outW = PROCESSING_TARGET_WIDTH;
            outH = Math.round(sh * ratio);
        }

        cachedCoords = { vw, vh, cw: containerW, ch: containerH, sx, sy, sw, sh, outW, outH };
        return cachedCoords;
    }

    /**
     * Cắt frame về đúng vùng khung ngắm NGƯỜI DÙNG NHÌN THẤY trên màn hình.
     * Hỗ trợ cắt TRỰC TIẾP từ HTMLVideoElement (không cần vẽ canvas trung gian)
     * hoặc từ HTMLCanvasElement.
     */
    function cropToGuideBand(frameSource) {
        if (!frameSource) return null;
        const vw = frameSource.videoWidth || frameSource.width;
        const vh = frameSource.videoHeight || frameSource.height;
        if (!vw || !vh) return null;

        const coords = getGuideCropCoords(vw, vh);
        if (!coords) return null;

        workCanvas.width = coords.outW;
        workCanvas.height = coords.outH;
        const ctx = workCanvas.getContext('2d');
        ctx.drawImage(frameSource, coords.sx, coords.sy, coords.sw, coords.sh, 0, 0, coords.outW, coords.outH);
        return workCanvas;
    }

    /**
     * Xử lý 1 khung hình, trả về danh sách "dòng" (mỗi dòng có thể chứa
     * nhiều token nếu tokenizeRows=true, dùng cho màn ngày).
     */
    async function processFrame(frameCanvas, { tokenizeRows } = { tokenizeRows: false }) {
        const band = cropToGuideBand(frameCanvas);
        const { binMat, grayMat } = ImageProcessing.thresholdAndDedither(band);
        try {
            const allRowBands = ImageProcessing.segmentRows(binMat);
            if (allRowBands.length === 0) return [];

            // TỐI ƯU TỐC ĐỘ ĐỘT PHÁ THEO CĂN CHỈNH CỦA NGƯỜI DÙNG:
            // Do người dùng căn cạnh đáy khung ngắm sát dòng MGMD, toàn bộ thông số
            // cần nhận diện (MGMD, Denom, Machine No, RTP2, RTP1) chỉ nằm ở tối đa 5-6 dòng cuối cùng.
            // Bỏ qua toàn bộ các dòng rác phía trên (N/A, 0.000%, tên game...) TRƯỚC KHI tokenize và gọi Model WebGL!
            const rowBands = (!tokenizeRows && allRowBands.length > 6)
                ? allRowBands.slice(-6)
                : allRowBands;

            // Tách token trước (rẻ, chỉ đếm pixel) để biết tổng số "ký tự" phát
            // hiện được trước khi tốn công cắt/resize/classify từng cái. Frame
            // nhiễu nặng (loá/moiré) có thể sinh ra hàng trăm box rác — đây là
            // nguyên nhân chính gây chậm bất thường ở một số frame.
            const rowTokens = rowBands.map((rowBand) => {
                const gapForBreak = tokenizeRows ? 10 : 8; // step1: tách từ trong dòng (như MGMD và x1¢)
                return { rowBand, tokens: ImageProcessing.segmentCharsIntoTokens(binMat, rowBand, gapForBreak) };
            });
            const totalBoxes = rowTokens.reduce((s, r) => s + r.tokens.reduce((s2, t) => s2 + t.length, 0), 0);
            if (totalBoxes > MAX_CHARS_PER_FRAME) return [];

            // Gom toàn bộ ký tự và cluster của mọi dòng lại để classify 1 lần GPU WebGL (batch).
            const allCharImages = [];
            const rowMeta = [];

            for (const { rowBand, tokens } of rowTokens) {
                const tokenSlots = [];
                let mgmdClusterBatchIndex = null;

                // Nếu dòng có token đầu tiên với chiều rộng 30-180px và chứa <= 10 box:
                // Thêm 1 slot crop cluster để Model 4.0 kiểm tra xem có phải chữ MGMD không
                if (tokens.length > 0) {
                    const t0 = tokens[0];
                    const x0 = t0[0].x0;
                    const x1 = t0[t0.length - 1].x1;
                    const tw = x1 - x0;
                    if (tw >= 30 && tw <= 180 && t0.length <= 10) {
                        mgmdClusterBatchIndex = allCharImages.length;
                        allCharImages.push(ImageProcessing.cropClusterForClassifier(grayMat, binMat, rowBand, x0, x1));
                    }
                }

                for (const token of tokens) {
                    const heights = token.map((box) => {
                        const b = ImageProcessing.tightVerticalBounds(binMat, rowBand, box);
                        return b.y1 - b.y0;
                    });
                    const sortedHeights = [...heights].sort((a, b) => a - b);
                    const medianHeight = sortedHeights[Math.floor(sortedHeights.length / 2)] || 1;

                    const slots = token.map((box, i) => {
                        if (token.length > 1 && heights[i] < medianHeight * 0.45) {
                            return { kind: 'dot' };
                        }
                        const batchIndex = allCharImages.length;
                        allCharImages.push(ImageProcessing.cropCharForClassifier(grayMat, binMat, rowBand, box));
                        return { kind: 'char', batchIndex };
                    });
                    tokenSlots.push(slots);
                }
                rowMeta.push({ tokenSlots, mgmdClusterBatchIndex, rowBand });
            }

            const classified = allCharImages.length ? await DigitClassifier.classifyBatch(allCharImages) : [];

            const rows = rowMeta.map(({ tokenSlots, mgmdClusterBatchIndex, rowBand }) => {
                let isMgmd = false;
                let mgmdConfidence = 0;
                if (mgmdClusterBatchIndex !== null && classified[mgmdClusterBatchIndex]) {
                    const res = classified[mgmdClusterBatchIndex];
                    if (res.rawClass === 'mgmd' && res.confidence >= 0.80) {
                        isMgmd = true;
                        mgmdConfidence = res.confidence;
                    }
                }

                const tokens = tokenSlots.map((slots) => {
                    const chars = slots.map((slot) => (slot.kind === 'dot' ? { char: '.', rawClass: 'dot', confidence: 1 } : classified[slot.batchIndex]));
                    const text = chars.map((c) => c.char).join('');
                    const meanConfidence = chars.length
                        ? chars.reduce((s, c) => s + c.confidence, 0) / chars.length
                        : 0;
                    return { text, meanConfidence, chars };
                });
                let text = tokens.map((t) => t.text).join(' ');
                const meanConfidence = tokens.length
                    ? tokens.reduce((s, t) => s + t.meanConfidence, 0) / tokens.length
                    : 0;

                const hasDollar = text.includes('$');
                const hasPercent = text.includes('%');

                // Dòng Denom ($0.01) hoặc dòng RTP hợp lệ (> 80%) thì không phải là MGMD
                const isDenom = typeof OcrParser !== 'undefined' ? OcrParser.isDenomRow(text) : false;
                const isRtp = typeof OcrParser !== 'undefined' ? (OcrParser.parseRtpValue(text) !== null) : false;
                if (isDenom || isRtp) {
                    isMgmd = false;
                }

                if (isMgmd && !text.includes('MGMD')) {
                    text = 'MGMD ' + text;
                }

                return { text, meanConfidence, tokens, isMgmd, mgmdConfidence, hasDollar, hasPercent, rowBand };
            });

            return rows;
        } finally {
            binMat.delete();
            grayMat.delete();
        }
    }

    /**
     * @param {() => HTMLCanvasElement|null} getFrame
     * @param {() => 'step1'|'step2'} getStep
     * @param {(rows: any[], step: string) => void} onResult
     */
    function startLoop(getFrame, getStep, onResult) {
        running = true;
        paused = false;

        const scheduleNext = () => {
            if (!running) return;
            const videoEl = document.getElementById('video');
            if (videoEl && typeof videoEl.requestVideoFrameCallback === 'function') {
                loopHandle = videoEl.requestVideoFrameCallback(() => tick());
            } else {
                loopHandle = setTimeout(tick, TICK_IDLE_MS);
            }
        };

        const tick = async () => {
            if (!running) return;
            if (paused) { loopHandle = setTimeout(tick, 150); return; }

            try {
                const source = getFrame();
                if (source) {
                    const step = getStep();
                    const rows = await processFrame(source, { tokenizeRows: step === 'step2' });
                    if (!paused && rows && rows.length > 0) onResult(rows, step);
                }
            } catch (e) {
                console.error('Lỗi xử lý khung hình', e);
            } finally {
                if (running) scheduleNext();
            }
        };

        scheduleNext();
    }

    function setPaused(value) { paused = value; }
    function isPaused() { return paused; }
    function stopLoop() {
        running = false;
        if (loopHandle) {
            const videoEl = document.getElementById('video');
            if (videoEl && typeof videoEl.cancelVideoFrameCallback === 'function' && typeof loopHandle === 'number') {
                try { videoEl.cancelVideoFrameCallback(loopHandle); } catch (e) {}
            }
            clearTimeout(loopHandle);
            loopHandle = null;
        }
    }

    function getLastCroppedBandCanvas() {
        return (workCanvas.width > 0 && workCanvas.height > 0) ? workCanvas : null;
    }

    return {
        init, startLoop, stopLoop, setPaused, isPaused,
        processFrame,
        getGuideCropCoords,
        getLastCroppedBandCanvas
    };
})();
