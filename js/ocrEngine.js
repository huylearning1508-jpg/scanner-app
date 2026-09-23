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
    let liveFilterEnabled = false;

    const workCanvas = document.createElement('canvas');

    // Cache toạ độ khung ngắm để loại bỏ hoàn toàn forced layout reflow (getBoundingClientRect)
    // ở mỗi frame. Chỉ tính lại khi xoay màn hình hoặc đổi kích cỡ cửa sổ.
    let cachedCoords = null;
    function invalidateGuideCache() {
        cachedCoords = null;
    }
    window.addEventListener('resize', invalidateGuideCache);
    window.addEventListener('orientationchange', invalidateGuideCache);

    async function init() {
        await ImageProcessing.waitForOpenCv();
        await DigitClassifier.init();
    }

    function setLiveFilterEnabled(value) { liveFilterEnabled = value; }
    function isLiveFilterEnabled() { return liveFilterEnabled; }

    function getGuideCropCoords(vw, vh) {
        if (cachedCoords && cachedCoords.vw === vw && cachedCoords.vh === vh) {
            return cachedCoords;
        }
        const videoEl = document.getElementById('video');
        const guideEl = document.getElementById('guideRect');
        if (!videoEl || !guideEl) return null;

        const videoRect = videoEl.getBoundingClientRect();
        const guideRect = guideEl.getBoundingClientRect();
        if (videoRect.width <= 0 || videoRect.height <= 0) return null;

        const scale = Math.max(videoRect.width / vw, videoRect.height / vh);
        const originX = videoRect.left + (videoRect.width - vw * scale) / 2;
        const originY = videoRect.top + (videoRect.height - vh * scale) / 2;

        const sx = Math.max(0, Math.round((guideRect.left - originX) / scale));
        const sy = Math.max(0, Math.round((guideRect.top - originY) / scale));
        const sw = Math.min(vw - sx, Math.round(guideRect.width / scale));
        const sh = Math.min(vh - sy, Math.round(guideRect.height / scale));

        let outW = sw, outH = sh;
        if (sw > PROCESSING_TARGET_WIDTH) {
            const ratio = PROCESSING_TARGET_WIDTH / sw;
            outW = PROCESSING_TARGET_WIDTH;
            outH = Math.round(sh * ratio);
        }

        cachedCoords = { vw, vh, sx, sy, sw, sh, outW, outH };
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
            const rowBands = ImageProcessing.segmentRows(binMat);
            if (rowBands.length === 0) return [];

            // Tách token trước (rẻ, chỉ đếm pixel) để biết tổng số "ký tự" phát
            // hiện được trước khi tốn công cắt/resize/classify từng cái. Frame
            // nhiễu nặng (loá/moiré) có thể sinh ra hàng trăm box rác — đây là
            // nguyên nhân chính gây chậm bất thường ở một số frame.
            const rowTokens = rowBands.map((rowBand) => {
                const gapForBreak = tokenizeRows ? 10 : 100000; // step1: không tách token trong dòng
                return { rowBand, tokens: ImageProcessing.segmentCharsIntoTokens(binMat, rowBand, gapForBreak) };
            });
            const totalBoxes = rowTokens.reduce((s, r) => s + r.tokens.reduce((s2, t) => s2 + t.length, 0), 0);
            if (totalBoxes > MAX_CHARS_PER_FRAME) return [];

            // Gom toàn bộ ký tự của mọi dòng lại để classify 1 lần (batch).
            const allCharImages = [];
            // rowMeta[i] = { tokenSlots: [ [{kind:'char',batchIndex}|{kind:'dot'}, ...], ... ] }
            const rowMeta = [];

            for (const { rowBand, tokens } of rowTokens) {
                const tokenSlots = [];

                for (const token of tokens) {
                    // Model không có lớp dấu "." — đưa vào classifier sẽ bị đoán
                    // nhầm thành 1 chữ số bất kỳ (đã xác nhận thực tế trên nhiều
                    // ảnh thật: luôn lệch dấu thập phân). Nhận diện dấu chấm bằng
                    // KÍCH THƯỚC thay vì model: dấu chấm luôn thấp hơn hẳn (~50%)
                    // so với các ký tự số khác trong cùng token.
                    const heights = token.map((box) => {
                        const b = ImageProcessing.tightVerticalBounds(binMat, rowBand, box);
                        return b.y1 - b.y0;
                    });
                    const sortedHeights = [...heights].sort((a, b) => a - b);
                    const medianHeight = sortedHeights[Math.floor(sortedHeights.length / 2)] || 1;

                    const slots = token.map((box, i) => {
                        if (token.length > 1 && heights[i] < medianHeight * 0.5) {
                            return { kind: 'dot' };
                        }
                        const batchIndex = allCharImages.length;
                        allCharImages.push(ImageProcessing.cropCharForClassifier(grayMat, binMat, rowBand, box));
                        return { kind: 'char', batchIndex };
                    });
                    tokenSlots.push(slots);
                }
                rowMeta.push({ tokenSlots });
            }

            const classified = allCharImages.length ? await DigitClassifier.classifyBatch(allCharImages) : [];

            const rows = rowMeta.map(({ tokenSlots }) => {
                const tokens = tokenSlots.map((slots) => {
                    const chars = slots.map((slot) => (slot.kind === 'dot' ? { char: '.', confidence: 1 } : classified[slot.batchIndex]));
                    const text = chars.map((c) => c.char).join('');
                    const meanConfidence = chars.length
                        ? chars.reduce((s, c) => s + c.confidence, 0) / chars.length
                        : 0;
                    return { text, meanConfidence };
                });
                const text = tokens.map((t) => t.text).join('');
                const meanConfidence = tokens.length
                    ? tokens.reduce((s, t) => s + t.meanConfidence, 0) / tokens.length
                    : 0;
                return { text, meanConfidence, tokens };
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
     * @param {(filteredCanvas: HTMLCanvasElement) => void} [onLiveFilterFrame] gọi mỗi lần có bản lọc live (nếu bật)
     */
    function startLoop(getFrame, getStep, onResult, onLiveFilterFrame) {
        running = true;
        paused = false;

        const previewCanvas = document.createElement('canvas');

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
                    if (liveFilterEnabled && onLiveFilterFrame) {
                        const band = cropToGuideBand(source);
                        if (band) {
                            previewCanvas.width = band.width;
                            previewCanvas.height = band.height;
                            ImageProcessing.liveThresholdPreview(band, previewCanvas);
                            onLiveFilterFrame(previewCanvas);
                        }
                    }

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

    return {
        init, startLoop, stopLoop, setPaused, isPaused,
        setLiveFilterEnabled, isLiveFilterEnabled,
        processFrame,
    };
})();
