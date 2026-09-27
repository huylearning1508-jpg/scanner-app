/**
 * cameraController.js
 * -----------------------------------------------------------------------
 * Bọc toàn bộ logic camera: mở stream (getUserMedia), hiển thị lên <video>,
 * chụp frame vào <canvas> ẩn để đưa cho OCR, bật/tắt đèn flash (torch),
 * chuyển đổi giữa các camera (trên thiết bị Android nhiều camera/ống kính),
 * và cơ chế "đóng băng" preview bằng cách chụp snapshot rồi che video lại.
 */

const CameraController = (() => {
    let videoEl = null;
    let captureCanvas = null; // canvas ẩn, dùng để lấy ImageData cho OCR
    let stream = null;
    let track = null;
    let torchOn = false;
    let torchSupported = false;
    let currentCameraIndex = 0;
    let cachedVideoDevices = [];

    function init(videoElement, hiddenCanvasElement) {
        videoEl = videoElement;
        captureCanvas = hiddenCanvasElement;
    }

    const diagLog = [];
    function logDiag(msg) {
        const line = `${((performance.now()) / 1000).toFixed(2)}s: ${msg}`;
        diagLog.push(line);
        console.log('[CameraDiag]', line);
    }

    /** Giải phóng stream hiện tại nếu có */
    function releaseCurrentStream() {
        if (stream) {
            try {
                stream.getTracks().forEach((t) => t.stop());
            } catch (e) {}
            stream = null;
            track = null;
        }
    }

    /** Thử play() và chờ cho đến khi video thực sự render frame (videoWidth > 0 và !paused). */
    async function waitForVideoDimensions(maxWaitMs = 1500) {
        const start = performance.now();
        while (performance.now() - start < maxWaitMs) {
            try {
                if (videoEl.paused) await videoEl.play();
            } catch (e) {
                logDiag(`play() chờ: ${e.message}`);
            }

            if (!videoEl.paused && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
                logDiag(`Video đã phát ổn định: ${videoEl.videoWidth}x${videoEl.videoHeight}`);
                return true;
            }
            await new Promise((r) => setTimeout(r, 120));
        }
        return false;
    }

    /**
     * Mở camera sau (environment) với cơ chế fallback tự động cho Android & iOS:
     * Thử lần lượt các cấu hình từ 720p chuẩn đến tự do cho tới khi tìm thấy camera
     * phát hình ảnh thực tế (videoWidth > 0).
     */
    async function startCamera(preferredDeviceId = null) {
        diagLog.length = 0;
        logDiag('bắt đầu khởi tạo camera');

        // Luôn giải phóng stream cũ để tránh Android phần cứng bị kẹt HAL dẫn đến màn hình đen
        releaseCurrentStream();

        const candidateConstraints = [];

        if (preferredDeviceId) {
            candidateConstraints.push({
                video: { deviceId: { exact: preferredDeviceId } },
                audio: false
            });
        } else {
            // 1. Chuẩn camera sau 720p (tốt nhất cho Android Chrome & iOS Safari)
            candidateConstraints.push({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            });
            // 2. Camera sau không ràng buộc độ phân giải
            candidateConstraints.push({
                video: { facingMode: { ideal: 'environment' } },
                audio: false
            });
            // 3. Camera sau dạng chuỗi đơn giản
            candidateConstraints.push({
                video: { facingMode: 'environment' },
                audio: false
            });
            // 4. Camera mặc định
            candidateConstraints.push({
                video: true,
                audio: false
            });
        }

        let opened = false;
        let lastError = null;

        for (let i = 0; i < candidateConstraints.length; i++) {
            const constraints = candidateConstraints[i];
            logDiag(`Thử cấu hình camera #${i + 1}: ${JSON.stringify(constraints.video)}`);

            try {
                stream = await navigator.mediaDevices.getUserMedia(constraints);
                logDiag(`getUserMedia #${i + 1} thành công, stream.active=${stream.active}`);

                videoEl.muted = true;
                videoEl.defaultMuted = true;
                videoEl.playsInline = true;
                videoEl.setAttribute('playsinline', '');
                videoEl.setAttribute('webkit-playsinline', '');
                videoEl.setAttribute('autoplay', '');
                videoEl.setAttribute('muted', '');

                videoEl.srcObject = stream;

                // Kiểm tra xem camera có thực sự phát khung hình không
                const ok = await waitForVideoDimensions(1800);
                if (ok) {
                    opened = true;
                    logDiag(`Camera cấu hình #${i + 1} đang hiển thị hình ảnh chuẩn (${videoEl.videoWidth}x${videoEl.videoHeight})`);
                    break;
                } else {
                    logDiag(`Cấu hình #${i + 1} không xuất hình (videoWidth=0), giải phóng và thử cấu hình kế tiếp`);
                    releaseCurrentStream();
                }
            } catch (err) {
                lastError = err;
                logDiag(`Cấu hình #${i + 1} lỗi: ${err.message}`);
                releaseCurrentStream();
            }
        }

        if (!opened) {
            const msg = lastError ? lastError.message : 'Không nhận được khung hình từ camera';
            logDiag('Hoàn toàn thất bại khi mở camera: ' + msg);
            throw new Error(msg);
        }

        // Thiết lập sự kiện video
        videoEl.onloadedmetadata = () => {
            logDiag(`loadedmetadata (${videoEl.videoWidth}x${videoEl.videoHeight})`);
            if (videoEl.paused) videoEl.play().catch(() => {});
        };
        videoEl.onplaying = () => logDiag('playing event');
        videoEl.onerror = (e) => logDiag('video error: ' + (videoEl.error ? videoEl.error.message : e));

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && videoEl.srcObject && videoEl.paused) {
                logDiag('tab quay lại foreground, play() lại');
                videoEl.play().catch(() => {});
            }
        });
        window.addEventListener('pageshow', () => {
            if (videoEl.srcObject && videoEl.paused) {
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

        // Cập nhật danh sách camera phục vụ chuyển đổi
        refreshVideoDevices();
    }

    /** Lấy danh sách camera thực tế trên thiết bị */
    async function refreshVideoDevices() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            cachedVideoDevices = devices.filter((d) => d.kind === 'videoinput');
            logDiag(`Tìm thấy ${cachedVideoDevices.length} camera: ` + cachedVideoDevices.map((d, i) => `#${i}: ${d.label || d.deviceId}`).join('; '));
            return cachedVideoDevices;
        } catch (e) {
            return [];
        }
    }

    /** Chuyển sang camera kế tiếp trên điện thoại (đặc biệt hữu dụng khi Android có nhiều camera sau) */
    async function switchCamera() {
        await refreshVideoDevices();
        if (cachedVideoDevices.length <= 1) {
            logDiag('Chỉ có 1 camera hoặc không tìm thấy camera khác, thử khởi động lại');
            await startCamera();
            return;
        }

        currentCameraIndex = (currentCameraIndex + 1) % cachedVideoDevices.length;
        const targetDevice = cachedVideoDevices[currentCameraIndex];
        logDiag(`Chuyển sang camera #${currentCameraIndex}: ${targetDevice.label || targetDevice.deviceId}`);
        await startCamera(targetDevice.deviceId);
    }

    /** Chẩn đoán trạng thái camera hiện tại — dùng khi video không hiện hình dù stream đã "chạy". */
    function getDiagnostics() {
        if (!videoEl) return 'videoEl chưa init';
        const lines = [
            `videoWidth=${videoEl.videoWidth} videoHeight=${videoEl.videoHeight}`,
            `readyState=${videoEl.readyState} paused=${videoEl.paused} muted=${videoEl.muted}`,
            `currentTime=${videoEl.currentTime.toFixed(2)}`,
            track ? `track: readyState=${track.readyState} muted=${track.muted} enabled=${track.enabled} label=${track.label}` : 'track=null',
            stream ? `stream.active=${stream.active}` : 'stream=null',
            `Danh sách camera (${cachedVideoDevices.length}): ` + cachedVideoDevices.map((d, i) => `[#${i} ${d.label || d.deviceId}]`).join(' '),
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
        if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth || !videoEl.videoHeight) return null;
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
            releaseCurrentStream();
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
        switchCamera,
        refreshVideoDevices,
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
