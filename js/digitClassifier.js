/**
 * digitClassifier.js
 * -----------------------------------------------------------------------
 * Bọc onnxruntime-web để chạy Model 4.0 — classifier 32x128, 13 lớp:
 * 0-9, dollar ($), percent (%), và cụm chữ mgmd (MGMD).
 *
 * Input model: tensor "input" float32 [N, 1, 32, 128].
 * Chuẩn hoá: (pixel / 127.5) - 1.0 (tương đương (pixel/255 - 0.5) / 0.5).
 * Output model: tensor "output" float32 [N, 13] — logits, qua softmax ra xác suất.
 * -----------------------------------------------------------------------
 */

const DigitClassifier = (() => {
    const INPUT_HEIGHT = 32;
    const INPUT_WIDTH = 128;
    let session = null;
    let classes = null;     // Mảng nhãn hiển thị: ['0','1','2','3','4','5','6','7','8','9','$','%','MGMD']
    let rawClasses = null;  // Mảng nhãn gốc: ['0','1','2','3','4','5','6','7','8','9','dollar','percent','mgmd']

    async function fetchBufferWithCache(url, onProgress) {
        if ('caches' in window) {
            try {
                const cache = await caches.open('onnx-model-cache-v4');
                const match = await cache.match(url);
                if (match) {
                    if (onProgress) onProgress(100, 'Tải tức thì từ bộ nhớ đệm');
                    return await match.arrayBuffer();
                }
            } catch (e) {
                console.warn('[DigitClassifier] Cache warning:', e);
            }
        }
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} khi tải ${url}`);

        const contentLength = Number(resp.headers.get('content-length')) || 18481224;
        if (!resp.body || typeof resp.body.getReader !== 'function') {
            const buf = await resp.arrayBuffer();
            if ('caches' in window) {
                try {
                    const cache = await caches.open('onnx-model-cache-v4');
                    cache.put(url, new Response(buf.slice(0))).catch(() => {});
                } catch (e) {}
            }
            return buf;
        }

        const reader = resp.body.getReader();
        let received = 0;
        const chunks = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            if (onProgress) {
                const pct = Math.min(99, Math.round((received / contentLength) * 100));
                const mb = (received / (1024 * 1024)).toFixed(1);
                const totalMb = (contentLength / (1024 * 1024)).toFixed(1);
                onProgress(pct, `${pct}% (${mb}/${totalMb} MB)`);
            }
        }
        const totalBuffer = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            totalBuffer.set(chunk, offset);
            offset += chunk.length;
        }

        if ('caches' in window) {
            try {
                const cache = await caches.open('onnx-model-cache-v4');
                cache.put(url, new Response(totalBuffer.buffer)).catch(() => {});
            } catch (e) {}
        }
        if (onProgress) onProgress(100, '100%');
        return totalBuffer.buffer;
    }

    async function init(modelUrl = 'models/digit_model.onnx', classesUrl = 'models/classes.json', onProgress = null) {
        if (ort.env && ort.env.wasm) {
            ort.env.wasm.simd = true;
            ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
        }

        try {
            const buffer = await fetchBufferWithCache(modelUrl, onProgress);
            try {
                session = await ort.InferenceSession.create(buffer, {
                    executionProviders: ['webgl'],
                });
                console.log('[DigitClassifier] Khởi tạo Model 4.0 với WebGL (GPU Accelerated)');
            } catch (e) {
                console.warn('[DigitClassifier] WebGL không khả dụng, fallback sang WASM CPU:', e.message);
                session = await ort.InferenceSession.create(buffer, {
                    executionProviders: ['wasm'],
                });
                console.log('[DigitClassifier] Khởi tạo Model 4.0 với WASM SIMD (CPU)');
            }
        } catch (loadErr) {
            console.error('[DigitClassifier] Lỗi tải Model 4.0:', loadErr);
        }

        const res = await fetch(classesUrl);
        const meta = await res.json();
        const displayMap = meta.label_display_map || {};
        rawClasses = meta.classes;
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
     * @param {Float32Array[]} charImages mảng ảnh ký tự/cluster đã chuẩn hoá 32x128 (1 kênh, [-1,1])
     * @returns {{char: string, rawClass: string, confidence: number}[]} kết quả theo thứ tự
     */
    async function classifyBatch(charImages) {
        if (!isReady()) throw new Error('DigitClassifier chưa init');
        if (charImages.length === 0) return [];

        const n = charImages.length;
        const area = INPUT_HEIGHT * INPUT_WIDTH;
        const batchData = new Float32Array(n * area);
        for (let i = 0; i < n; i++) {
            batchData.set(charImages[i], i * area);
        }
        const tensor = new ort.Tensor('float32', batchData, [n, 1, INPUT_HEIGHT, INPUT_WIDTH]);
        const results = await session.run({ input: tensor });
        const output = results.output; // [n, 13]
        const numClasses = output.dims[1];

        const out = [];
        for (let i = 0; i < n; i++) {
            const logits = Array.from(output.data.slice(i * numClasses, (i + 1) * numClasses));
            const probs = softmax(logits);
            let bestIdx = 0;
            for (let c = 1; c < probs.length; c++) if (probs[c] > probs[bestIdx]) bestIdx = c;
            out.push({
                char: classes[bestIdx],
                rawClass: rawClasses[bestIdx],
                confidence: probs[bestIdx],
            });
        }
        return out;
    }

    return { init, isReady, classifyBatch };
})();
