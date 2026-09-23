/**
 * cameraController.js
 * -----------------------------------------------------------------------
 * Bọc toàn bộ logic camera: mở stream (getUserMedia), hiển thị lên <video>,
 * chụp frame vào <canvas> ẩn để đưa cho OCR, bật/tắt đèn flash (torch),
 * và cơ chế "đóng băng" preview bằng cách chụp snapshot rồi che video lại.
 */

const CameraController = (() => {
    let videoEl = null;
    let captureCanvas = null; // canvas ẩn, dùng để lấy ImageData cho OCR
    let stream = null;
    let track = null;
    let torchOn = false;
    let torchSupported = false;

    function init(videoElement, hiddenCanvasElement) {
        videoEl = videoElement;
        captureCanvas = hiddenCanvasElement;
    }

    /** Thử play() vài lần liên tiếp (cách nhau ngắn) trước khi bỏ cuộc — chống lỗi thoáng qua. */
    async function playWithRetry(maxAttempts = 3) {
        for (let i = 0; i < maxAttempts; i++) {
            try {
                await videoEl.play();
                return;
            } catch (e) {
                logDiag(`play() thử ${i + 1}/${maxAttempts} lỗi: ${e.message}`);
                if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, 300));
            }
        }
        throw new Error('play() thất bại sau ' + maxAttempts + ' lần thử');
    }

    const diagLog = [];
    function logDiag(msg) {
        const line = `${((performance.now()) / 1000).toFixed(2)}s: ${msg}`;
        diagLog.push(line);
        console.log('[CameraDiag]', line);
    }

    /**
     * Mở camera sau (environment) — phù hợp để soi vào màn hình máy.
     *
     * QUAN TRỌNG (iOS Safari): kết hợp `width`/`height` ideal cùng lúc với
     * `facingMode` từng bị báo là gây màn hình đen dù stream vẫn "chạy"
     * (WebKit bug 176843 — getUserMedia results in black screen on iPhone).
     * Chỉ xin `facingMode`, để trình duyệt tự chọn độ phân giải, tránh
     * thương lượng constraint phức tạp. Cũng set `muted`/`playsInline` qua
     * property JS (không chỉ attribute HTML) vì Safari đôi khi chỉ tôn
     * trọng property lúc runtime, thiếu nó autoplay có thể bị chặn im lặng.
     */
    async function startCamera() {
        diagLog.length = 0;
        logDiag('bắt đầu getUserMedia');
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' } },
            audio: false
        });
        logDiag('getUserMedia thành công, stream.active=' + stream.active);

        videoEl.muted = true;
        videoEl.playsInline = true;

        videoEl.addEventListener('loadedmetadata', () => logDiag(`loadedmetadata (${videoEl.videoWidth}x${videoEl.videoHeight})`));
        videoEl.addEventListener('playing', () => logDiag('playing event'));
        videoEl.addEventListener('error', (e) => logDiag('video error: ' + (videoEl.error ? videoEl.error.message : e)));
        videoEl.addEventListener('stalled', () => logDiag('stalled event'));
        videoEl.addEventListener('suspend', () => logDiag('suspend event'));

        // iOS Safari huỷ play() đang chờ (AbortError) nếu tab bị chuyển nền/
        // khoá màn hình đúng lúc đó — quan sát thực tế: play() treo gần 1
        // phút rồi bị "The operation was aborted", video đen vĩnh viễn vì
        // trước đây chỉ gọi play() đúng 1 lần, không có cơ chế thử lại. Giờ
        // tự động phát lại mỗi khi tab quay lại foreground.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && videoEl.srcObject && videoEl.paused) {
                logDiag('tab quay lại foreground, thử play() lại');
                videoEl.play().then(() => logDiag('play() lại thành công')).catch((e) => logDiag('play() lại vẫn lỗi: ' + e.message));
            }
        });
        window.addEventListener('pageshow', () => {
            if (videoEl.srcObject && videoEl.paused) {
                logDiag('pageshow, thử play() lại');
                videoEl.play().catch(() => {});
            }
        });

        videoEl.srcObject = stream;
        try {
            await playWithRetry();
            logDiag('play() resolved');
        } catch (e) {
            logDiag('play() bị từ chối: ' + e.message);
        }

        track = stream.getVideoTracks()[0];
        logDiag(`track: readyState=${track.readyState} muted=${track.muted} enabled=${track.enabled} label=${track.label}`);
        try {
            const capabilities = track.getCapabilities ? track.getCapabilities() : {};
            torchSupported = !!capabilities.torch;
        } catch (e) {
            torchSupported = false;
        }
    }

    /** Chẩn đoán trạng thái camera hiện tại — dùng khi video không hiện hình dù stream đã "chạy". */
    function getDiagnostics() {
        if (!videoEl) return 'videoEl chưa init';
        const lines = [
            `videoWidth=${videoEl.videoWidth} videoHeight=${videoEl.videoHeight}`,
            `readyState=${videoEl.readyState} paused=${videoEl.paused} muted=${videoEl.muted}`,
            `currentTime=${videoEl.currentTime.toFixed(2)}`,
            track ? `track: readyState=${track.readyState} muted=${track.muted} enabled=${track.enabled}` : 'track=null',
            stream ? `stream.active=${stream.active}` : 'stream=null',
            '--- log ---',
            ...diagLog,
        ];
        return lines.join('\n');
    }

    function isTorchSupported() { return torchSupported; }

    /** Bật/tắt đèn flash. Trả về trạng thái mới (hoặc false nếu thiết bị không hỗ trợ). */
    async function toggleTorch() {
        if (!track || !torchSupported) return false;
        try {
            torchOn = !torchOn;
            await track.applyConstraints({ advanced: [{ torch: torchOn }] });
            return torchOn;
        } catch (e) {
            console.error('Lỗi bật/tắt flash', e);
            torchOn = false;
            return false;
        }
    }

    /**
     * Chụp frame hiện tại của video vào canvas ẩn, trả về ImageData/canvas
     * để đưa cho OCR engine, đồng thời trả về dataURL để hiển thị khi freeze.
     */
    function captureFrame() {
        if (!videoEl || videoEl.readyState < 2) return null;
        const w = videoEl.videoWidth;
        const h = videoEl.videoHeight;
        if (!w || !h) return null;

        captureCanvas.width = w;
        captureCanvas.height = h;
        const ctx = captureCanvas.getContext('2d');
        ctx.drawImage(videoEl, 0, 0, w, h);
        return captureCanvas;
    }

    /** Lấy ảnh tĩnh (dataURL) từ canvas hiện tại — dùng để hiển thị overlay khi "đóng băng". */
    function captureFreezeFrameDataUrl() {
        const canvas = captureFrame();
        return canvas ? canvas.toDataURL('image/jpeg', 0.85) : null;
    }

    function release() {
        try {
            if (torchOn && track) {
                track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
            }
            if (stream) {
                stream.getTracks().forEach(t => t.stop());
            }
        } catch (e) {
            console.error('Lỗi giải phóng camera', e);
        }
    }

    function getVideoElement() {
        return (videoEl && videoEl.readyState >= 2) ? videoEl : null;
    }

    return {
        init,
        startCamera,
        getVideoElement,
        isTorchSupported,
        toggleTorch,
        captureFrame,
        captureFreezeFrameDataUrl,
        getDiagnostics,
        release
    };
})();
