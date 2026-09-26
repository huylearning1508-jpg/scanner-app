/**
 * main.js
 * -----------------------------------------------------------------------
 * Điều phối máy trạng thái quét 2 bước/máy:
 * Hỗ trợ 2 chế độ quét độc lập để so sánh & debug:
 *   1. Chế độ YOLO AI (Tab 1): Sử dụng YOLO11n (roi_detect.onnx) để tự động
 *      phát hiện vị trí các ô (machine_no, rtp1, rtp2, anchor_denom, datetime),
 *      vẽ bounding box trực quan và cắt riêng từng ô đưa vào DigitClassifier.
 *   2. Chế độ Cổ điển (Tab 2): Giữ nguyên thuật toán lọc hình thái học C++,
 *      tách dòng VPP và neo ký tự "$" theo khung ngắm cố định.
 *   3. Tab Dữ liệu (Tab 3): Bảng kiểm toán realtime từ Firebase Realtime DB.
 * -----------------------------------------------------------------------
 */

const ScanStep = Object.freeze({
    STEP1_SCANNING: 'STEP1_SCANNING',
    STEP1_FROZEN: 'STEP1_FROZEN',
    STEP2_SCANNING: 'STEP2_SCANNING',
    STEP2_FROZEN: 'STEP2_FROZEN',
    SESSION_ENDED: 'SESSION_ENDED'
});

(function () {
    const $ = (id) => document.getElementById(id);

    // ---- Tabs ----
    const tabBtnYolo = $('tabBtnYolo');
    const tabBtnClassic = $('tabBtnClassic');
    const tabBtnData = $('tabBtnData');
    const dataTabView = $('dataTabView');
    const scanTabView = $('scanTabView');

    // ---- Camera / scan ----
    const videoEl = $('video');
    const liveFilterCanvas = $('liveFilterCanvas');
    const chkLiveFilter = $('chkLiveFilter');
    const liveFilterToggle = $('liveFilterToggle');
    const guideOverlay = $('guideOverlay');
    const yoloCanvasOverlay = $('yoloCanvasOverlay');
    const yoloStatsBadge = $('yoloStatsBadge');

    const captureCanvas = $('captureCanvas');
    const frozenImg = $('frozenFrameImage');
    const frozenBorder = $('frozenBorder');
    const btnSavePhoto = $('btnSavePhoto');
    const badge = $('badgeMachineNumber');
    const tvCsvFileName = $('tvCsvFileName');
    const tvScannedCount = $('tvScannedCount');
    const tvCloudStatus = $('tvCloudStatus');
    const tvScanStatus = $('tvScanStatus');
    const btnFlash = $('btnFlash');
    const btnManualCapture = $('btnManualCapture');
    const btnCameraDiag = $('btnCameraDiag');
    const btnEndSession = $('btnEndSession');
    const btnRescan = $('btnRescan');
    const btnConfirm = $('btnConfirm');
    const etMachineId = $('etMachineId');
    const etParamX = $('etParamX');
    const etParamY = $('etParamY');
    const etDay = $('etDay');
    const selMonth = $('selMonth');
    const etYear = $('etYear');
    const postSessionPanel = $('postSessionPanel');
    const btnShareCsv = $('btnShareCsv');
    const btnNewSession = $('btnNewSession');
    const permissionOverlay = $('permissionOverlay');
    const btnGrantPermission = $('btnGrantPermission');
    const loadingOverlay = $('loadingOverlay');
    const loadingText = $('loadingText');
    const btnRetryLoad = $('btnRetryLoad');

    let currentStep = ScanStep.STEP1_SCANNING;
    let scannedCount = 0;
    let activeMachineNo = '';
    let engineStarted = false;
    let activeMode = 'yolo'; // 'yolo' | 'classic' | 'data'

    let yoloLoopRunning = false;
    let yoloLoopHandle = null;
    let isProcessingYoloFrame = false;

    function pad2(n) { return String(n).padStart(2, '0'); }
    function nowScanTime() {
        const d = new Date();
        return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }

    // ============================== TABS ==============================

    function showYoloTab() {
        activeMode = 'yolo';
        tabBtnYolo.classList.add('active');
        tabBtnClassic.classList.remove('active');
        tabBtnData.classList.remove('active');
        scanTabView.hidden = false;
        dataTabView.hidden = true;
        DataView.stop();

        if (guideOverlay) guideOverlay.hidden = true;
        if (yoloCanvasOverlay) yoloCanvasOverlay.hidden = false;
        if (yoloStatsBadge) yoloStatsBadge.hidden = false;
        if (liveFilterToggle) liveFilterToggle.hidden = true;
        if (liveFilterCanvas) liveFilterCanvas.hidden = true;

        OcrEngine.setPaused(true);
        startYoloLoop();
        updateStatusUi();
    }

    function showClassicTab() {
        activeMode = 'classic';
        tabBtnClassic.classList.add('active');
        tabBtnYolo.classList.remove('active');
        tabBtnData.classList.remove('active');
        scanTabView.hidden = false;
        dataTabView.hidden = true;
        DataView.stop();

        if (guideOverlay) guideOverlay.hidden = false;
        if (yoloCanvasOverlay) yoloCanvasOverlay.hidden = true;
        if (yoloStatsBadge) yoloStatsBadge.hidden = true;
        if (liveFilterToggle) liveFilterToggle.hidden = false;
        if (liveFilterCanvas) liveFilterCanvas.hidden = !chkLiveFilter.checked;

        stopYoloLoop();
        OcrEngine.setPaused(currentStep === ScanStep.STEP1_FROZEN || currentStep === ScanStep.STEP2_FROZEN || currentStep === ScanStep.SESSION_ENDED);
        updateStatusUi();
    }

    function showDataTab() {
        activeMode = 'data';
        tabBtnData.classList.add('active');
        tabBtnYolo.classList.remove('active');
        tabBtnClassic.classList.remove('active');
        dataTabView.hidden = false;
        scanTabView.hidden = true;

        stopYoloLoop();
        OcrEngine.setPaused(true);
        DataView.start(dataTabView);
    }

    tabBtnYolo.addEventListener('click', showYoloTab);
    tabBtnClassic.addEventListener('click', showClassicTab);
    tabBtnData.addEventListener('click', showDataTab);

    // ============================== KHỞI TẠO ==============================

    let listenersAttached = false;

    async function bootstrap() {
        CameraController.init(videoEl, captureCanvas);
        if (!listenersAttached) {
            setupClickListeners();
            listenersAttached = true;
        }

        try {
            await CameraController.startCamera();
            permissionOverlay.hidden = true;
        } catch (e) {
            console.error('Không thể mở camera', e);
            permissionOverlay.hidden = false;
            return;
        }

        btnFlash.style.display = CameraController.isTorchSupported() ? '' : 'none';

        // Hiển thị camera ngay lập tức cho người dùng thấy hình ảnh live
        showYoloTab();
        initFirebaseSync();
        beginNewSession();

        const ok = await initOcrEngineWithRetry();
        if (ok) await startScanningAfterEngineReady();
    }

    async function startScanningAfterEngineReady() {
        engineStarted = true;

        // Vòng lặp quét chế độ Cổ điển
        OcrEngine.startLoop(
            () => CameraController.getVideoElement() || CameraController.captureFrame(),
            () => (currentStep === ScanStep.STEP1_SCANNING ? 'step1' : 'step2'),
            (rows, step) => {
                if (activeMode === 'classic') handleOcrResult(rows, step);
            },
            (previewCanvas) => {
                if (activeMode === 'classic') drawLiveFilter(previewCanvas);
            }
        );

        if (activeMode === 'yolo') {
            startYoloLoop();
        }
    }

    /**
     * Khởi tạo OcrEngine (OpenCV.js + model số 32x32) và YOLO detector song song với tiến trình %
     */
    async function initOcrEngineWithRetry() {
        loadingOverlay.hidden = false;
        btnRetryLoad.hidden = true;
        loadingText.className = '';
        loadingText.textContent = 'Đang tải model AI (lần đầu có thể mất vài giây)…';
        try {
            const pOcr = OcrEngine.init();
            const pYolo = YoloDetector.init('models/roi_detect.onnx', (pct) => {
                loadingText.textContent = `Đang nạp YOLO AI: ${pct}%...`;
            });
            await Promise.all([pOcr, pYolo]);
            loadingOverlay.hidden = true;
            return true;
        } catch (e) {
            console.error('Không thể khởi tạo bộ máy nhận diện', e);
            loadingText.className = 'error';
            loadingText.textContent = 'Không thể khởi tạo bộ máy nhận diện: ' + e.message;
            btnRetryLoad.hidden = false;
            return false;
        }
    }

    function drawLiveFilter(previewCanvas) {
        liveFilterCanvas.width = previewCanvas.width;
        liveFilterCanvas.height = previewCanvas.height;
        liveFilterCanvas.getContext('2d').drawImage(previewCanvas, 0, 0);
    }

    chkLiveFilter.addEventListener('change', () => {
        const on = chkLiveFilter.checked;
        OcrEngine.setLiveFilterEnabled(on);
        liveFilterCanvas.hidden = !on;
    });

    // ============================== VÒNG LẶP YOLO AI ==============================

    function startYoloLoop() {
        if (yoloLoopRunning) return;
        yoloLoopRunning = true;
        scheduleNextYoloTick();
    }

    function stopYoloLoop() {
        yoloLoopRunning = false;
        if (yoloLoopHandle) {
            clearTimeout(yoloLoopHandle);
            yoloLoopHandle = null;
        }
        clearYoloCanvas();
    }

    function clearYoloCanvas() {
        if (!yoloCanvasOverlay) return;
        const ctx = yoloCanvasOverlay.getContext('2d');
        ctx.clearRect(0, 0, yoloCanvasOverlay.width, yoloCanvasOverlay.height);
    }

    function scheduleNextYoloTick() {
        if (!yoloLoopRunning || activeMode !== 'yolo') return;
        yoloLoopHandle = setTimeout(runYoloTick, 40);
    }

    async function runYoloTick() {
        if (!yoloLoopRunning || activeMode !== 'yolo') return;

        if (currentStep === ScanStep.STEP1_FROZEN || currentStep === ScanStep.STEP2_FROZEN || currentStep === ScanStep.SESSION_ENDED) {
            scheduleNextYoloTick();
            return;
        }

        const video = CameraController.getVideoElement();
        if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
            scheduleNextYoloTick();
            return;
        }

        if (isProcessingYoloFrame) {
            scheduleNextYoloTick();
            return;
        }

        isProcessingYoloFrame = true;
        try {
            const { boxes, durationMs, frameWidth, frameHeight } = await YoloDetector.detect(video, 0.40);

            // 1. Vẽ Bounding Boxes trực quan lên overlay canvas
            drawYoloBoxes(boxes, video, frameWidth, frameHeight);

            // 2. Cập nhật nhãn HUD thông số
            if (yoloStatsBadge) {
                yoloStatsBadge.textContent = `⚡ YOLO: ${durationMs}ms | ${boxes.length} vùng`;
            }

            // 3. Xử lý nhận diện dựa theo bước hiện tại
            if (currentStep === ScanStep.STEP1_SCANNING) {
                await processYoloStep1(boxes, video);
            } else if (currentStep === ScanStep.STEP2_SCANNING) {
                await processYoloStep2(boxes, video);
            }
        } catch (err) {
            console.warn('[YOLO Tick] Lỗi xử lý khung hình:', err);
        } finally {
            isProcessingYoloFrame = false;
            scheduleNextYoloTick();
        }
    }

    /**
     * Vẽ bounding boxes trực quan với màu sắc riêng cho từng loại vùng
     */
    function drawYoloBoxes(boxes, video, frameWidth, frameHeight) {
        if (!yoloCanvasOverlay) return;
        const rect = video.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        if (yoloCanvasOverlay.width !== rect.width || yoloCanvasOverlay.height !== rect.height) {
            yoloCanvasOverlay.width = rect.width;
            yoloCanvasOverlay.height = rect.height;
        }

        const ctx = yoloCanvasOverlay.getContext('2d');
        ctx.clearRect(0, 0, rect.width, rect.height);

        if (!boxes || boxes.length === 0) return;

        const scale = Math.max(rect.width / frameWidth, rect.height / frameHeight);
        const originX = (rect.width - frameWidth * scale) / 2;
        const originY = (rect.height - frameHeight * scale) / 2;

        for (const b of boxes) {
            const [x1, y1, x2, y2] = b.bbox;
            const dispX = originX + x1 * scale;
            const dispY = originY + y1 * scale;
            const dispW = (x2 - x1) * scale;
            const dispH = (y2 - y1) * scale;

            ctx.strokeStyle = b.color;
            ctx.lineWidth = 2.5;

            if (b.class === 'roi_block') {
                ctx.setLineDash([6, 4]);
            } else {
                ctx.setLineDash([]);
            }

            // Vẽ viền hộp
            ctx.strokeRect(dispX, dispY, dispW, dispH);

            // Vẽ nhãn pill
            const labelText = `${b.label} ${(b.score * 100).toFixed(0)}%`;
            ctx.font = 'bold 11px sans-serif';
            const textWidth = ctx.measureText(labelText).width;
            ctx.fillStyle = b.color;
            ctx.fillRect(dispX, Math.max(0, dispY - 18), textWidth + 8, 18);

            ctx.fillStyle = '#000000';
            ctx.fillText(labelText, dispX + 4, Math.max(13, dispY - 4));
        }
        ctx.setLineDash([]);
    }

    /**
     * Cắt ảnh từ vùng bounding box trên video gốc
     */
    function cropBoxFromVideo(video, bbox) {
        const [x1, y1, x2, y2] = bbox;
        const w = Math.max(1, x2 - x1);
        const h = Math.max(1, y2 - y1);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(video, x1, y1, w, h, 0, 0, w, h);
        return c;
    }

    /**
     * Bước 1 (YOLO): Đọc Machine No, RTP1, RTP2 từ các ô đã phát hiện
     */
    async function processYoloStep1(boxes, video) {
        const boxMach = boxes.find((b) => b.class === 'machine_no' && b.score >= 0.45);
        const boxRtp1 = boxes.find((b) => b.class === 'rtp1' && b.score >= 0.45);
        const boxRtp2 = boxes.find((b) => b.class === 'rtp2' && b.score >= 0.45);

        if (!boxMach || (!boxRtp1 && !boxRtp2)) return;

        const ocrStart = performance.now();
        const [resMach, resRtp1, resRtp2] = await Promise.all([
            boxMach ? OcrEngine.readCropText(cropBoxFromVideo(video, boxMach.bbox), { isNumericOnly: true }) : { text: '', confidence: 0 },
            boxRtp1 ? OcrEngine.readCropText(cropBoxFromVideo(video, boxRtp1.bbox)) : { text: '', confidence: 0 },
            boxRtp2 ? OcrEngine.readCropText(cropBoxFromVideo(video, boxRtp2.bbox)) : { text: '', confidence: 0 }
        ]);
        const ocrMs = Math.round(performance.now() - ocrStart);

        if (yoloStatsBadge) {
            yoloStatsBadge.textContent = `⚡ YOLO: ~30ms | OCR: ${ocrMs}ms`;
        }

        // Bóc tách Machine Number
        const machDigits = resMach.text.replace(/[^0-9]/g, '');
        if (!machDigits) return;
        const machNo = Number(machDigits);
        if (Number.isNaN(machNo) || machNo < OcrParser.MACHINE_NO_MIN || machNo > OcrParser.MACHINE_NO_MAX) return;

        // Bóc tách RTP1
        let rtp1Val = null;
        let rtp1Auto = false;
        if (boxRtp1 && resRtp1.text) {
            const r1Digits = resRtp1.text.replace(/[^0-9]/g, '');
            if (resRtp1.text.includes('.')) {
                const m = resRtp1.text.match(/[0-9]+\.[0-9]+/);
                if (m) rtp1Val = Number(m[0]);
            } else if (r1Digits.length > 2) {
                const fixed = OcrParser.fixMissingDecimalForRtp(r1Digits);
                rtp1Val = fixed.value;
                rtp1Auto = fixed.corrected;
            }
        }

        // Bóc tách RTP2
        let rtp2Val = null;
        let rtp2Auto = false;
        if (boxRtp2 && resRtp2.text) {
            const r2Digits = resRtp2.text.replace(/[^0-9]/g, '');
            if (resRtp2.text.includes('.')) {
                const m = resRtp2.text.match(/[0-9]+\.[0-9]+/);
                if (m) rtp2Val = Number(m[0]);
            } else if (r2Digits.length > 2) {
                const fixed = OcrParser.fixMissingDecimalForRtp(r2Digits);
                rtp2Val = fixed.value;
                rtp2Auto = fixed.corrected;
            }
        }

        const validRtp1 = rtp1Val !== null && rtp1Val >= OcrParser.RTP_MIN && rtp1Val <= OcrParser.RTP_MAX;
        const validRtp2 = rtp2Val !== null && rtp2Val >= OcrParser.RTP_MIN && rtp2Val <= OcrParser.RTP_MAX;

        if (validRtp1 && validRtp2) {
            onStep1Captured({
                machineNo: machNo,
                rtp1: rtp1Val,
                rtp2: rtp2Val,
                autoCorrected: { rtp1: rtp1Auto, rtp2: rtp2Auto },
                allValid: true
            });
        }
    }

    /**
     * Bước 2 (YOLO): Đọc ngày Clear RAM từ ô datetime nếu có
     */
    async function processYoloStep2(boxes, video) {
        const boxDate = boxes.find((b) => b.class === 'datetime' && b.score >= 0.40);
        if (!boxDate) return;

        const cropCanvas = cropBoxFromVideo(video, boxDate.bbox);
        const rows = await OcrEngine.processFrame(cropCanvas, { tokenizeRows: true });
        if (rows && rows.length > 0) {
            for (const row of rows) {
                const result = OcrParser.parseStep2(row.tokens);
                if (result) {
                    onStep2Captured(result);
                    break;
                }
            }
        }
    }

    // ============================== ĐỒNG BỘ FIREBASE ==============================

    async function initFirebaseSync() {
        if (!FirebaseManager.isConfigured()) {
            tvCloudStatus.textContent = '☁ Firebase: chưa cấu hình';
            tvCloudStatus.className = '';
            return;
        }
        tvCloudStatus.textContent = '☁ Đang kết nối Firebase…';
        const ok = await FirebaseManager.init();
        tvCloudStatus.textContent = ok ? '☁ Firebase: đã kết nối' : '⚠ Firebase lỗi kết nối (vẫn lưu CSV cục bộ bình thường)';
        tvCloudStatus.className = ok ? 'cloud-ok' : 'cloud-error';
    }

    // ============================== QUẢN LÝ PHIÊN ==============================

    async function beginNewSession() {
        const resumed = tryResumePendingSession();
        if (!resumed) {
            const fileName = await CsvManager.startNewSession();
            tvCsvFileName.textContent = fileName;
            scannedCount = 0;
        }
        updateScannedCountUi();
        currentStep = ScanStep.STEP1_SCANNING;
        clearAllFields();
        hideBadge();
        unfreezePreview();
        postSessionPanel.hidden = true;
        btnConfirm.textContent = 'Tiếp tục quét ngày Clear RAM ➔';
        updateStatusUi();
    }

    function tryResumePendingSession() {
        const pending = CsvManager.loadPendingSession();
        if (!pending || pending.rows.length === 0) return false;
        const ok = confirm(
            `Phát hiện phiên làm việc dở dang (${pending.rows.length} máy) từ file "${pending.fileName}".\n` +
            `Bạn có muốn khôi phục và tiếp tục phiên này không?`
        );
        if (!ok) return false;
        CsvManager.resumeSession(pending);
        tvCsvFileName.textContent = pending.fileName;
        scannedCount = pending.rows.length;
        return true;
    }

    // ============================== XỬ LÝ KẾT QUẢ NHẬN DIỆN (CHẾ ĐỘ CỔ ĐIỂN) ==============================

    const DEBUG_LOG_ROWS = true;

    function logRecognizedRows(label, rows) {
        if (!DEBUG_LOG_ROWS) return;
        if (!rows || rows.length === 0) { console.log(`[OCR ${label}] (không tách được dòng nào)`); return; }
        console.log(`[OCR ${label}]`, rows.map((r) => `"${r.text}" (${(r.meanConfidence * 100).toFixed(0)}%)`));
    }

    function handleOcrResult(rows, step) {
        logRecognizedRows(step, rows);
        if (step === 'step1' && currentStep === ScanStep.STEP1_SCANNING) {
            const result = OcrParser.parseStep1(rows);
            if (result && result.allValid) onStep1Captured(result);
        } else if (step === 'step2' && currentStep === ScanStep.STEP2_SCANNING) {
            for (const row of rows) {
                const result = OcrParser.parseStep2(row.tokens);
                if (result) { onStep2Captured(result); break; }
            }
        }
    }

    function onStep1Captured(result) {
        freezePreview();
        etMachineId.value = result.machineNo;
        etParamX.value = result.rtp1;
        etParamY.value = result.rtp2;
        etMachineId.dataset.autoCorrected = 'false';
        etParamX.dataset.autoCorrected = String(result.autoCorrected.rtp1);
        etParamY.dataset.autoCorrected = String(result.autoCorrected.rtp2);
        HapticUtil.vibrateTick();
        BeepUtil.playBeep();
        currentStep = ScanStep.STEP1_FROZEN;
        updateStatusUi();
    }

    function onStep2Captured(result) {
        freezePreview();
        etDay.value = result.day;
        etYear.value = result.year;
        HapticUtil.vibrateTick();
        BeepUtil.playBeep();
        currentStep = ScanStep.STEP2_FROZEN;
        updateStatusUi();
    }

    async function onManualCaptureClicked() {
        const frame = CameraController.captureFrame();
        if (!frame) return;

        if (activeMode === 'yolo') {
            try {
                const { boxes } = await YoloDetector.detect(frame, 0.35);
                if (currentStep === ScanStep.STEP1_SCANNING) {
                    await processYoloStep1(boxes, frame);
                } else if (currentStep === ScanStep.STEP2_SCANNING) {
                    await processYoloStep2(boxes, frame);
                }
            } catch (e) {
                console.error('Lỗi nhận diện YOLO khi chụp tay:', e);
            }
            if (currentStep === ScanStep.STEP1_SCANNING) {
                freezePreview();
                currentStep = ScanStep.STEP1_FROZEN;
                updateStatusUi();
            } else if (currentStep === ScanStep.STEP2_SCANNING) {
                freezePreview();
                currentStep = ScanStep.STEP2_FROZEN;
                updateStatusUi();
            }
            return;
        }

        // Chế độ Cổ điển
        if (currentStep === ScanStep.STEP1_SCANNING) {
            let result = null;
            try {
                const rows = await OcrEngine.processFrame(frame, { tokenizeRows: false });
                logRecognizedRows('step1-manual', rows);
                result = OcrParser.parseStep1(rows);
            } catch (e) { console.error('Lỗi nhận diện khi chụp tay', e); }
            if (result && result.allValid) {
                onStep1Captured(result);
            } else {
                freezePreview();
                currentStep = ScanStep.STEP1_FROZEN;
                updateStatusUi();
            }
        } else if (currentStep === ScanStep.STEP2_SCANNING) {
            let result = null;
            try {
                const rows = await OcrEngine.processFrame(frame, { tokenizeRows: true });
                logRecognizedRows('step2-manual', rows);
                for (const row of rows) {
                    result = OcrParser.parseStep2(row.tokens);
                    if (result) break;
                }
            } catch (e) { console.error('Lỗi nhận diện khi chụp tay', e); }
            if (result) {
                onStep2Captured(result);
            } else {
                freezePreview();
                currentStep = ScanStep.STEP2_FROZEN;
                updateStatusUi();
            }
        }
    }

    // ============================== ĐÓNG BĂNG / MỞ LẠI PREVIEW ==============================

    function freezePreview() {
        OcrEngine.setPaused(true);
        const dataUrl = CameraController.captureFreezeFrameDataUrl();
        if (dataUrl) {
            frozenImg.src = dataUrl;
            frozenImg.hidden = false;
        }
        frozenBorder.hidden = false;
        btnSavePhoto.hidden = false;
    }

    function onSavePhotoClicked() {
        if (!frozenImg.src) return;
        const a = document.createElement('a');
        a.href = frozenImg.src;
        const stepLabel = currentStep === ScanStep.STEP2_FROZEN ? 'step2' : 'step1';
        a.download = `debug_${stepLabel}_${Date.now()}.jpg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function unfreezePreview() {
        frozenImg.hidden = true;
        frozenImg.removeAttribute('src');
        frozenBorder.hidden = true;
        btnSavePhoto.hidden = true;
        if (activeMode === 'classic') {
            OcrEngine.setPaused(false);
        }
    }

    // ============================== SỰ KIỆN CLICK ==============================

    function setupClickListeners() {
        btnGrantPermission.addEventListener('click', bootstrap);

        btnFlash.addEventListener('click', async () => {
            const on = await CameraController.toggleTorch();
            btnFlash.style.opacity = on ? '1' : '0.55';
        });

        btnManualCapture.addEventListener('click', onManualCaptureClicked);
        btnCameraDiag.addEventListener('click', () => {
            alert(CameraController.getDiagnostics());
        });
        btnSavePhoto.addEventListener('click', onSavePhotoClicked);
        btnRetryLoad.addEventListener('click', async () => {
            const ok = await initOcrEngineWithRetry();
            if (ok && !engineStarted) await startScanningAfterEngineReady();
        });
        btnEndSession.addEventListener('click', confirmEndSession);
        btnRescan.addEventListener('click', onRescanClicked);
        btnConfirm.addEventListener('click', onConfirmClicked);
        btnShareCsv.addEventListener('click', onShareCsvClicked);
        btnNewSession.addEventListener('click', beginNewSession);
    }

    function onRescanClicked() {
        if (currentStep === ScanStep.STEP1_FROZEN) {
            etMachineId.value = '';
            etParamX.value = '';
            etParamY.value = '';
            currentStep = ScanStep.STEP1_SCANNING;
            unfreezePreview();
            updateStatusUi();
        } else if (currentStep === ScanStep.STEP2_FROZEN) {
            etDay.value = '';
            etYear.value = '';
            currentStep = ScanStep.STEP2_SCANNING;
            unfreezePreview();
            updateStatusUi();
        }
    }

    function onConfirmClicked() {
        if (currentStep === ScanStep.STEP1_FROZEN) confirmStep1();
        else if (currentStep === ScanStep.STEP2_FROZEN) confirmStep2AndSave();
    }

    function confirmStep1() {
        const machineNo = Number(etMachineId.value.trim());
        const rtp1 = Number(etParamX.value.trim());
        const rtp2 = Number(etParamY.value.trim());

        if (!etMachineId.value.trim() || Number.isNaN(machineNo) || machineNo < OcrParser.MACHINE_NO_MIN || machineNo > OcrParser.MACHINE_NO_MAX) {
            alert(`Machine No phải là số nguyên trong khoảng ${OcrParser.MACHINE_NO_MIN}-${OcrParser.MACHINE_NO_MAX}`);
            return;
        }
        if (Number.isNaN(rtp1) || rtp1 < OcrParser.RTP_MIN || rtp1 > OcrParser.RTP_MAX) {
            alert(`RTP1 phải trong khoảng ${OcrParser.RTP_MIN}-${OcrParser.RTP_MAX}`);
            return;
        }
        if (Number.isNaN(rtp2) || rtp2 < OcrParser.RTP_MIN || rtp2 > OcrParser.RTP_MAX) {
            alert(`RTP2 phải trong khoảng ${OcrParser.RTP_MIN}-${OcrParser.RTP_MAX}`);
            return;
        }

        activeMachineNo = machineNo;
        showBadge(machineNo);
        etDay.value = '';
        etYear.value = '';
        selMonth.selectedIndex = new Date().getMonth();
        btnConfirm.textContent = `Xác nhận & Lưu máy #${machineNo}`;
        currentStep = ScanStep.STEP2_SCANNING;
        unfreezePreview();
        updateStatusUi();
    }

    async function confirmStep2AndSave() {
        const day = Number(etDay.value.trim());
        const month = Number(selMonth.value);
        const year = Number(etYear.value.trim());

        if (!day || day < 1 || day > 31 || !year || year < 2000) {
            alert('Vui lòng nhập đầy đủ và đúng định dạng ngày Clear RAM');
            return;
        }

        const machineNo = Number(etMachineId.value.trim());
        const rtp1 = Number(etParamX.value.trim());
        const rtp2 = Number(etParamY.value.trim());
        const ramClearDateStr = `${pad2(day)}/${pad2(month)}/${year}`;

        const csvRecord = { machineNo, rtp1, rtp2, ramClearDateStr, scanTime: nowScanTime() };
        const fieldReading = {
            machine_no: machineNo,
            machineNo: machineNo,
            rtp1: rtp1,
            rtp2: rtp2,
            total_meters: 0,
            periodic_meters: 0,
            ram_clear_date: ramClearDateStr,
            ramClearDateStr: ramClearDateStr,
            ramClearDate: { day, month, year },
            confidence: {
                machineNo: 1, rtp1: 1, rtp2: 1, anchorFound: true
            },
            auto_corrected: etParamX.dataset.autoCorrected === 'true' || etParamY.dataset.autoCorrected === 'true',
            autoCorrected: {
                rtp1: etParamX.dataset.autoCorrected === 'true',
                rtp2: etParamY.dataset.autoCorrected === 'true',
            },
            confirmed_at: Date.now(),
            confirmedAt: Date.now(),
        };

        const saved = await CsvManager.appendRecord(csvRecord);
        if (saved) {
            scannedCount++;
            updateScannedCountUi();
        } else {
            alert('Lỗi ghi file CSV — dữ liệu vẫn được giữ tạm, hãy thử [Chia sẻ file CSV] để tải về!');
        }

        FirebaseManager.pushFieldReading(fieldReading).then((ok) => {
            tvCloudStatus.textContent = ok ? '☁ Firebase: đã đồng bộ' : '💾 Đã lưu bộ nhớ máy (offline)';
            tvCloudStatus.className = ok ? 'cloud-ok' : 'cloud-warn';
        });

        hideBadge();
        clearAllFields();
        btnConfirm.textContent = 'Tiếp tục quét ngày Clear RAM ➔';
        currentStep = ScanStep.STEP1_SCANNING;
        unfreezePreview();
        updateStatusUi();
    }

    // ============================== KẾT THÚC PHIÊN / CHIA SẺ ==============================

    function confirmEndSession() {
        const ok = confirm(
            `Bạn đã quét tổng cộng ${scannedCount} máy trong phiên này.\n` +
            `File: ${CsvManager.getCurrentFileName()}\n\nKết thúc phiên làm việc?`
        );
        if (ok) endSession();
    }

    function endSession() {
        CsvManager.endSession();
        currentStep = ScanStep.SESSION_ENDED;
        OcrEngine.setPaused(true);
        stopYoloLoop();
        hideBadge();
        postSessionPanel.hidden = false;
        updateStatusUi();
    }

    async function onShareCsvClicked() {
        try {
            const result = await CsvManager.shareCsv();
            if (result === 'downloaded') {
                tvScanStatus.textContent = 'Đã tải file CSV xuống thư mục Downloads của trình duyệt.';
            }
        } catch (e) {
            if (e.name !== 'AbortError') {
                alert('Không thể chia sẻ file: ' + e.message);
            }
        }
    }

    // ============================== CẬP NHẬT GIAO DIỆN ==============================

    function updateScannedCountUi() {
        tvScannedCount.textContent = `Đã quét: ${scannedCount} máy`;
    }

    function showBadge(machineNo) {
        activeMachineNo = machineNo;
        badge.textContent = `Machine number: #${machineNo}`;
        badge.hidden = false;
    }

    function hideBadge() {
        activeMachineNo = '';
        badge.hidden = true;
    }

    function clearAllFields() {
        etMachineId.value = '';
        etParamX.value = '';
        etParamY.value = '';
        etDay.value = '';
        etYear.value = '';
    }

    function setActionButtonsEnabled(enabled) {
        btnRescan.disabled = !enabled;
        btnConfirm.disabled = !enabled;
        btnRescan.style.opacity = enabled ? '1' : '0.5';
        btnConfirm.style.opacity = enabled ? '1' : '0.5';
    }

    function updateStatusUi() {
        const scanning = currentStep === ScanStep.STEP1_SCANNING || currentStep === ScanStep.STEP2_SCANNING;
        btnManualCapture.hidden = !scanning;

        const modeLabel = activeMode === 'yolo' ? '[YOLO AI]' : '[Cổ điển]';

        switch (currentStep) {
            case ScanStep.STEP1_SCANNING:
                tvScanStatus.textContent = `${modeLabel} Bước 1/2 — Đang quét thông số máy… (hoặc bấm Chụp tay)`;
                setActionButtonsEnabled(false);
                break;
            case ScanStep.STEP1_FROZEN:
                tvScanStatus.textContent = `${modeLabel} Đã bắt được thông số. Kiểm tra và bấm Tiếp tục.`;
                setActionButtonsEnabled(true);
                break;
            case ScanStep.STEP2_SCANNING:
                tvScanStatus.textContent = `${modeLabel} Bước 2/2 — Đang quét ngày Clear RAM máy #${activeMachineNo}…`;
                setActionButtonsEnabled(false);
                break;
            case ScanStep.STEP2_FROZEN:
                tvScanStatus.textContent = `${modeLabel} Đã bắt được ngày. Chọn tháng và bấm Xác nhận.`;
                setActionButtonsEnabled(true);
                break;
            case ScanStep.SESSION_ENDED:
                tvScanStatus.textContent = 'Phiên làm việc đã kết thúc.';
                setActionButtonsEnabled(false);
                break;
        }
    }

    // ============================== VÒNG ĐỜI ==============================

    window.addEventListener('beforeunload', () => {
        CameraController.release();
        OcrEngine.stopLoop();
        stopYoloLoop();
    });

    document.addEventListener('DOMContentLoaded', bootstrap);
})();
