/**
 * digitClassifier.js
 * -----------------------------------------------------------------------
 * Bọc onnxruntime-web để chạy `digit_model.onnx` — classifier 32x32,
 * 12 lớp: 0-9, dollar($), percent(%). KHÔNG có lớp dấu "." — RTP thiếu dấu
 * chấm được OcrParser tự chèn lại qua fixMissingDecimalForRtp (đã có sẵn).
 *
 * Input model: tensor "input" float32 [N,1,32,32] (đã xác nhận qua kiểm
 * tra trực tiếp model). Chuẩn hoá: (pixel/255 - 0.5) / 0.5, KHÔNG đảo
 * ngược — ảnh xám gốc (không threshold), nền trắng/chữ đen tự nhiên. Đã
 * xác nhận thực nghiệm bằng cách đối chiếu ảnh training thật: 100% đúng
 * trên 180 mẫu (15 ảnh/lớp) với đúng công thức này.
 *
 * Output model: tensor "output" float32 [N,12] — logits thô, cần softmax
 * để ra xác suất/độ tin cậy.
 *
 * Dùng batch inference (gộp toàn bộ ký tự phát hiện được trong 1 khung
 * thành 1 lần gọi model) để tối ưu tốc độ thay vì gọi từng ký tự.
 * -----------------------------------------------------------------------
 */

const DigitClassifier = (() => {
    const INPUT_SIZE = 32;
    let session = null;
    let classes = null; // mảng ký tự hiển thị, đã map "dollar"->"$", "percent"->"%"

    async function fetchBufferWithCache(url) {
        if ('caches' in window) {
            try {
                const cache = await caches.open('onnx-model-cache-v2');
                const match = await cache.match(url);
                if (match) return await match.arrayBuffer();
                const resp = await fetch(url);
                if (resp.ok) {
                    const cloned = resp.clone();
                    cache.put(url, cloned).catch(() => {});
                    return await resp.arrayBuffer();
                }
            } catch (e) {
                console.warn('[DigitClassifier] Cache warning:', e);
            }
        }
        const resp = await fetch(url);
        return await resp.arrayBuffer();
    }

    async function init(modelUrl = 'models/digit_model.onnx', classesUrl = 'models/classes.json') {
        if (ort.env && ort.env.wasm) {
            ort.env.wasm.simd = true;
            ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
        }

        try {
            const buffer = await fetchBufferWithCache(modelUrl);
            try {
                session = await ort.InferenceSession.create(buffer, {
                    executionProviders: ['webgl'],
                });
                console.log('[DigitClassifier] Khởi tạo thành công với WebGL (GPU Accelerated)');
            } catch (e) {
                console.warn('[DigitClassifier] WebGL không khả dụng, tự động fallback sang WASM CPU:', e.message);
                session = await ort.InferenceSession.create(buffer, {
                    executionProviders: ['wasm'],
                });
                console.log('[DigitClassifier] Khởi tạo thành công với WASM SIMD (CPU)');
            }
        } catch (loadErr) {
            console.error('[DigitClassifier] Lỗi tải model số:', loadErr);
        }

        const res = await fetch(classesUrl);
        const meta = await res.json();
        const displayMap = meta.label_display_map || {};
        classes = meta.classes.map((c) => displayMap[c] || c);
    }

    function isReady() { return !!session && !!classes; }

    function softmax(logits) {
        const max = Math.max(...logits);
        const exps = logits.map((v) => Math.exp(v - max));
        const sum = exps.reduce((a, b) => a + b, 0);
        return exps.map((v) => v / sum);
    }

    /**
     * @param {Float32Array[]} charImages mảng ảnh ký tự đã chuẩn hoá 32x32 (1 kênh, [-1,1])
     * @returns {{char: string, confidence: number}[]} kết quả theo đúng thứ tự đầu vào
     */
    async function classifyBatch(charImages) {
        if (!isReady()) throw new Error('DigitClassifier chưa init');
        if (charImages.length === 0) return [];

        const n = charImages.length;
        const area = INPUT_SIZE * INPUT_SIZE;
        const batchData = new Float32Array(n * area);
        for (let i = 0; i < n; i++) {
            batchData.set(charImages[i], i * area);
        }
        const tensor = new ort.Tensor('float32', batchData, [n, 1, INPUT_SIZE, INPUT_SIZE]);
        const results = await session.run({ input: tensor });
        const output = results.output; // [n, 12]
        const numClasses = output.dims[1];

        const out = [];
        for (let i = 0; i < n; i++) {
            const logits = Array.from(output.data.slice(i * numClasses, (i + 1) * numClasses));
            const probs = softmax(logits);
            let bestIdx = 0;
            for (let c = 1; c < probs.length; c++) if (probs[c] > probs[bestIdx]) bestIdx = c;
            out.push({ char: classes[bestIdx], confidence: probs[bestIdx] });
        }
        return out;
    }

    return { init, isReady, classifyBatch };
})();
