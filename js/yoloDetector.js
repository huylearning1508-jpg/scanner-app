/**
 * yoloDetector.js
 * -----------------------------------------------------------------------
 * Trình phát hiện vùng (ROI Detection) bằng YOLO11n (roi_detect.onnx)
 * 7 Lớp đối tượng:
 *   0: roi_block    - Bảng thông số kiểm toán tổng thể
 *   1: mgmd         - Dòng chữ MGMD x1¢
 *   2: anchor_denom - Dòng mệnh giá tiền ($0.01)
 *   3: machine_no   - Ô số máy (Machine No)
 *   4: rtp2         - Ô RTP2 (%)
 *   5: rtp1         - Ô RTP1 (%)
 *   6: datetime     - Ô ngày giờ Clear RAM
 * -----------------------------------------------------------------------
 */

const YoloDetector = (() => {
    const MODEL_SIZE = 640;
    const NUM_CLASSES = 7;
    const NUM_ANCHORS = 8400;
    const CONF_THRESHOLD = 0.35;
    const IOU_THRESHOLD = 0.45;

    const CLASSES = [
        'roi_block',
        'mgmd',
        'anchor_denom',
        'machine_no',
        'rtp2',
        'rtp1',
        'datetime'
    ];

    const CLASS_LABELS = {
        'roi_block': 'Vùng Bảng Audit',
        'mgmd': 'MGMD x1¢',
        'anchor_denom': 'Mệnh giá ($)',
        'machine_no': 'Số máy (Machine #)',
        'rtp2': 'RTP2 (%)',
        'rtp1': 'RTP1 (%)',
        'datetime': 'Ngày Clear RAM'
    };

    const CLASS_COLORS = {
        'rtp1': '#00e5ff',        // Cyan
        'rtp2': '#10b981',        // Emerald
        'machine_no': '#f59e0b',  // Amber / Vàng
        'anchor_denom': '#a855f7',// Tím
        'mgmd': '#ec4899',        // Hồng
        'datetime': '#f97316',    // Cam
        'roi_block': '#3b82f6'    // Xanh dương
    };

    let session = null;
    let isInitializing = false;
    let letterboxCanvas = null;
    let letterboxCtx = null;
    let floatInputBuffer = null;

    async function fetchModelBufferWithCache(url, onProgress) {
        const CACHE_NAME = 'onnx-model-cache-v2';
        let cache = null;
        if ('caches' in window) {
            try {
                cache = await caches.open(CACHE_NAME);
                const match = await cache.match(url);
                if (match) {
                    console.log(`[YoloDetector] Nạp ${url} siêu tốc từ CacheStorage`);
                    if (onProgress) onProgress(100);
                    return await match.arrayBuffer();
                }
            } catch (e) {
                console.warn('[YoloDetector] Cache read error:', e);
            }
        }

        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} tải ${url}`);

        const totalBytes = Number(resp.headers.get('content-length')) || 10569954;
        const reader = resp.body ? resp.body.getReader() : null;

        let buffer;
        if (!reader) {
            buffer = await resp.arrayBuffer();
            if (onProgress) onProgress(100);
        } else {
            const chunks = [];
            let receivedBytes = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                receivedBytes += value.length;
                if (onProgress) {
                    const pct = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
                    onProgress(pct);
                }
            }
            const fullArray = new Uint8Array(receivedBytes);
            let pos = 0;
            for (const chunk of chunks) {
                fullArray.set(chunk, pos);
                pos += chunk.length;
            }
            buffer = fullArray.buffer;
            if (onProgress) onProgress(100);
        }

        if (cache) {
            try {
                const cacheResp = new Response(buffer.slice(0), {
                    headers: { 'Content-Type': 'application/octet-stream' }
                });
                await cache.put(url, cacheResp);
                console.log(`[YoloDetector] Đã lưu ${url} vào CacheStorage`);
            } catch (e) {
                console.warn('[YoloDetector] Cache save error:', e);
            }
        }
        return buffer;
    }

    async function init(modelUrl = 'models/roi_detect.onnx', onProgress = null) {
        if (session) return true;
        if (isInitializing) return false;
        isInitializing = true;

        letterboxCanvas = document.createElement('canvas');
        letterboxCanvas.width = MODEL_SIZE;
        letterboxCanvas.height = MODEL_SIZE;
        letterboxCtx = letterboxCanvas.getContext('2d', { willReadFrequently: true });
        floatInputBuffer = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);

        if (typeof ort === 'undefined') {
            console.error('[YoloDetector] onnxruntime-web chưa được nạp!');
            isInitializing = false;
            return false;
        }

        try {
            const modelBuffer = await fetchModelBufferWithCache(modelUrl, onProgress);
            // Thử khởi tạo với WebGL GPU trước để đạt tốc độ cao nhất (25-45ms)
            try {
                session = await ort.InferenceSession.create(modelBuffer, {
                    executionProviders: ['webgl'],
                    graphOptimizationLevel: 'all',
                });
                console.log('[YoloDetector] Khởi tạo YOLO11n thành công qua WebGL GPU');
                isInitializing = false;
                return true;
            } catch (gpuErr) {
                console.warn('[YoloDetector] WebGL không khả dụng, chuyển sang CPU WASM:', gpuErr.message);
                session = await ort.InferenceSession.create(modelBuffer, {
                    executionProviders: ['wasm'],
                    graphOptimizationLevel: 'all',
                });
                console.log('[YoloDetector] Khởi tạo YOLO11n thành công qua CPU WASM');
                isInitializing = false;
                return true;
            }
        } catch (err) {
            console.error('[YoloDetector] Lỗi nạp mô hình YOLO:', err);
            isInitializing = false;
            return false;
        }
    }

    function isReady() {
        return session !== null;
    }

    /**
     * Tính toán chỉ số IoU giữa 2 bounding box [x1, y1, x2, y2]
     */
    function computeIoU(boxA, boxB) {
        const xA = Math.max(boxA[0], boxB[0]);
        const yA = Math.max(boxA[1], boxB[1]);
        const xB = Math.min(boxA[2], boxB[2]);
        const yB = Math.min(boxA[3], boxB[3]);

        const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
        if (interArea <= 0) return 0;

        const areaA = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1]);
        const areaB = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1]);
        return interArea / (areaA + areaB - interArea);
    }

    /**
     * Non-Maximum Suppression (NMS)
     */
    function applyNMS(boxes, iouThreshold = IOU_THRESHOLD) {
        boxes.sort((a, b) => b.score - a.score);
        const selected = [];
        const active = new Array(boxes.length).fill(true);

        for (let i = 0; i < boxes.length; i++) {
            if (!active[i]) continue;
            selected.push(boxes[i]);

            for (let j = i + 1; j < boxes.length; j++) {
                if (!active[j]) continue;
                // Chỉ triệt tiêu các box cùng lớp hoặc overlap quá lớn
                if (boxes[i].class === boxes[j].class || computeIoU(boxes[i].bbox, boxes[j].bbox) > 0.85) {
                    const iou = computeIoU(boxes[i].bbox, boxes[j].bbox);
                    if (iou > iouThreshold) {
                        active[j] = false;
                    }
                }
            }
        }
        return selected;
    }

    /**
     * Nhận diện các vùng trong khung hình
     * @param {HTMLVideoElement|HTMLCanvasElement} frameSource
     * @param {number} confThreshold
     * @returns {Promise<{boxes: Array, durationMs: number}>}
     */
    async function detect(frameSource, confThreshold = CONF_THRESHOLD) {
        if (!session) return { boxes: [], durationMs: 0 };

        const vw = frameSource.videoWidth || frameSource.width;
        const vh = frameSource.videoHeight || frameSource.height;
        if (!vw || !vh) return { boxes: [], durationMs: 0 };

        const startT = performance.now();

        // 1. Tiền xử lý: Resize bảo toàn tỉ lệ (Letterbox) về 640x640
        const scale = Math.min(MODEL_SIZE / vw, MODEL_SIZE / vh);
        const nw = Math.round(vw * scale);
        const nh = Math.round(vh * scale);
        const dx = Math.floor((MODEL_SIZE - nw) / 2);
        const dy = Math.floor((MODEL_SIZE - nh) / 2);

        letterboxCtx.fillStyle = '#000000';
        letterboxCtx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
        letterboxCtx.drawImage(frameSource, 0, 0, vw, vh, dx, dy, nw, nh);

        // 2. Chuyển đổi thành Tensor float32 [1, 3, 640, 640] chuẩn hoá [0, 1]
        const imgData = letterboxCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
        const planeSize = MODEL_SIZE * MODEL_SIZE;

        for (let i = 0, p = 0; i < planeSize; i++, p += 4) {
            floatInputBuffer[i] = imgData[p] / 255.0;                   // R
            floatInputBuffer[planeSize + i] = imgData[p + 1] / 255.0;   // G
            floatInputBuffer[2 * planeSize + i] = imgData[p + 2] / 255.0; // B
        }

        const inputTensor = new ort.Tensor('float32', floatInputBuffer, [1, 3, MODEL_SIZE, MODEL_SIZE]);

        // 3. Chạy suy luận ONNX
        const feeds = {};
        feeds[session.inputNames[0] || 'images'] = inputTensor;
        const results = await session.run(feeds);
        const output = results[session.outputNames[0] || 'output0'];
        const data = output.data; // Float32Array [1, 11, 8400]

        // 4. Giải mã toạ độ và điểm tin cậy
        const candidates = [];
        for (let i = 0; i < NUM_ANCHORS; i++) {
            // Tìm class có score cao nhất trong 7 class
            let bestClass = 0;
            let maxScore = data[(4 + 0) * NUM_ANCHORS + i];

            for (let c = 1; c < NUM_CLASSES; c++) {
                const sc = data[(4 + c) * NUM_ANCHORS + i];
                if (sc > maxScore) {
                    maxScore = sc;
                    bestClass = c;
                }
            }

            if (maxScore >= confThreshold) {
                const cx = data[0 * NUM_ANCHORS + i];
                const cy = data[1 * NUM_ANCHORS + i];
                const bw = data[2 * NUM_ANCHORS + i];
                const bh = data[3 * NUM_ANCHORS + i];

                // Chuyển ngược toạ độ từ letterbox 640x640 về toạ độ pixel của video gốc
                const origCx = (cx - dx) / scale;
                const origCy = (cy - dy) / scale;
                const origW = bw / scale;
                const origH = bh / scale;

                const x1 = Math.max(0, Math.round(origCx - origW / 2));
                const y1 = Math.max(0, Math.round(origCy - origH / 2));
                const x2 = Math.min(vw, Math.round(origCx + origW / 2));
                const y2 = Math.min(vh, Math.round(origCy + origH / 2));

                candidates.push({
                    class: CLASSES[bestClass],
                    classIndex: bestClass,
                    label: CLASS_LABELS[CLASSES[bestClass]] || CLASSES[bestClass],
                    color: CLASS_COLORS[CLASSES[bestClass]] || '#10b981',
                    score: maxScore,
                    bbox: [x1, y1, x2, y2],
                    width: x2 - x1,
                    height: y2 - y1
                });
            }
        }

        // 5. Áp dụng NMS
        const finalBoxes = applyNMS(candidates, IOU_THRESHOLD);
        const durationMs = Math.round(performance.now() - startT);

        return {
            boxes: finalBoxes,
            durationMs,
            frameWidth: vw,
            frameHeight: vh
        };
    }

    return {
        init,
        isReady,
        detect,
        CLASSES,
        CLASS_LABELS,
        CLASS_COLORS
    };
})();
