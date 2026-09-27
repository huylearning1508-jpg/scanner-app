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

    /** Thử play() và chờ cho đến khi video thực sự render frame (videoWidth > 0 và !paused). */
    async function playWithRetry(maxAttempts = 12) {
        for (let i = 0; i < maxAttempts; i++) {
            try {
                await videoEl.play();
            } catch (e) {
                logDiag(`play() thử ${i + 1}/${maxAttempts} chờ: ${e.message}`);
            }

            if (!videoEl.paused && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
                logDiag(`Video đã phát ổn định: ${videoEl.videoWidth}x${videoEl.videoHeight}`);
                return;
            }
            if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, 150));
        }

        if (!videoEl.paused) {
            logDiag(`Video đã play nhưng chưa có dimensions (${videoEl.videoWidth}x${videoEl.videoHeight})`);
            return;
        }
        throw new Error('Không thể tự động phát video camera (trình duyệt có thể cần tương tác màn hình)');
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

        // Mở trực tiếp camera sau với cấu hình tối giản để phần cứng và trình duyệt mở ngay lập tức (< 200ms)
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' } },
                audio: false
            });
            logDiag('getUserMedia camera sau thành công');
        } catch (e1) {
            logDiag('Không mở được camera sau, fallback sang camera mặc định: ' + e1.message);
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: false
                });
                logDiag('getUserMedia fallback thành công');
            } catch (e2) {
                logDiag('getUserMedia hoàn toàn thất bại: ' + e2.message);
                throw e2;
            }
        }
        logDiag('getUserMedia thành công, stream.active=' + stream.active);

        videoEl.muted = true;
        videoEl.defaultMuted = true;
        videoEl.playsInline = true;
        videoEl.setAttribute('playsinline', '');
        videoEl.setAttribute('webkit-playsinline', '');
        videoEl.setAttribute('autoplay', '');
        videoEl.setAttribute('muted', '');

        videoEl.addEventListener('loadedmetadata', () => {
            logDiag(`loadedmetadata (${videoEl.videoWidth}x${videoEl.videoHeight})`);
            if (videoEl.paused) videoEl.play().catch(() => {});
        });
        videoEl.addEventListener('playing', () => logDiag('playing event'));
        videoEl.addEventListener('error', (e) => logDiag('video error: ' + (videoEl.error ? videoEl.error.message : e)));
        videoEl.addEventListener('stalled', () => logDiag('stalled event'));
        videoEl.addEventListener('suspend', () => logDiag('suspend event'));

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && videoEl.srcObject && videoEl.paused) {
                logDiag('tab quay lại foreground, thử play() lại');
                videoEl.play().catch(() => {});
            }
        });
        window.addEventListener('pageshow', () => {
            if (videoEl.srcObject && videoEl.paused) {
                logDiag('pageshow, thử play() lại');
                videoEl.play().catch(() => {});
            }
        });

        // Bổ sung listener chạm vào bất cứ đâu trên màn hình để mở khóa autoplay nếu trình duyệt chặn
        const unlockOnUserGesture = () => {
            if (videoEl && videoEl.srcObject && videoEl.paused) {
                logDiag('Chạm màn hình -> mở khoá play()');
                videoEl.play().catch((e) => logDiag('User gesture play error: ' + e.message));
            }
        };
        window.addEventListener('touchstart', unlockOnUserGesture, { passive: true });
        window.addEventListener('click', unlockOnUserGesture, { passive: true });

        videoEl.srcObject = stream;
        try {
            await playWithRetry();
            logDiag('play() resolved thành công');
        } catch (e) {
            logDiag('playWithRetry thông báo: ' + e.message);
        }

        track = stream.getVideoTracks()[0];
        if (track) {
            logDiag(`track: readyState=${track.readyState} label=${track.label}`);
            try {
                const capabilities = track.getCapabilities ? track.getCapabilities() : {};
                torchSupported = !!capabilities.torch;
            } catch (e) {
                torchSupported = false;
            }
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
        return (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0) ? videoEl : null;
    }

    function showDiagModal() {
        const diag = getDiagnostics();
        alert('--- THÔNG TIN CHẨN ĐOÁN CAMERA ---\n\n' + diag);
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
        showDiagModal,
        release
    };
})();
