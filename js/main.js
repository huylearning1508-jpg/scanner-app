/**
 * main.js
 * -----------------------------------------------------------------------
 * Điều phối máy trạng thái quét 2 bước/máy với Model 4.0 và logic Anchor MGMD:
 *   - Mốc chính = dòng chữ MGMD
 *   - Trên đó 1 dòng = Denom ($0.01)
 *   - Trên đó 2 dòng = Machine Number (ví dụ: 3)
 *   - Trên đó 3 dòng = RTP 2 (ví dụ: 93.56%)
 *   - Trên đó 4 dòng = RTP 1 (ví dụ: 93.966%)
 *
 * Tab: Quét (Camera Liveview + Guide Band) & Dữ liệu (Bảng kiểm toán Realtime).
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
    const tabBtnScan = $('tabBtnScan');
    const tabBtnData = $('tabBtnData');
    const dataTabView = $('dataTabView');
    const scanTabView = $('scanTabView');

    // ---- Camera / scan ----
    const videoEl = $('video');
    const guideOverlay = $('guideOverlay');

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
    const btnSwitchCamera = $('btnSwitchCamera');
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

    function pad2(n) { return String(n).padStart(2, '0'); }
    function nowScanTime() {
        const d = new Date();
        return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }

    // ============================== TABS ==============================

    function showScanTab() {
        tabBtnScan.classList.add('active');
        tabBtnData.classList.remove('active');
        scanTabView.hidden = false;
        dataTabView.hidden = true;
        DataView.stop();

        if (guideOverlay) guideOverlay.hidden = false;

        OcrEngine.setPaused(currentStep === ScanStep.STEP1_FROZEN || currentStep === ScanStep.STEP2_FROZEN || currentStep === ScanStep.SESSION_ENDED);
        updateStatusUi();
    }

    function showDataTab() {
        tabBtnData.classList.add('active');
        tabBtnScan.classList.remove('active');
        dataTabView.hidden = false;
        scanTabView.hidden = true;

        OcrEngine.setPaused(true);
        DataView.start(dataTabView);
    }

    tabBtnScan.addEventListener('click', showScanTab);
    tabBtnData.addEventListener('click', showDataTab);

    // ============================== KHỞI TẠO ==============================

    let listenersAttached = false;

    async function bootstrap() {
        CameraController.init(videoEl, captureCanvas);
        if (!listenersAttached) {
            setupClickListeners();
            listenersAttached = true;
        }

        showScanTab();
        initFirebaseSync();

        // 1. Mở Camera trước để hiển thị liveview ngay lập tức (< 300ms)
        try {
            tvScanStatus.textContent = 'Đang mở camera…';
            await CameraController.startCamera();
            permissionOverlay.hidden = true;
            btnFlash.style.display = CameraController.isTorchSupported() ? '' : 'none';
            tvScanStatus.textContent = 'Camera đã sẵn sàng. Đang nạp Model 5.0…';
        } catch (e) {
            console.error('Không thể mở camera', e);
            permissionOverlay.hidden = false;
            tvScanStatus.textContent = 'Lỗi camera: ' + e.message;
            return;
        }

        beginNewSession();

        // 2. Nạp Model AI và bắt đầu quét
        const ok = await initOcrEngineWithRetry();
        if (ok) {
            await startScanningAfterEngineReady();
            updateStatusUi();
        }
    }

    async function startScanningAfterEngineReady() {
        engineStarted = true;

        // Bắt đầu vòng lặp quét nhận diện
        OcrEngine.startLoop(
            () => CameraController.getVideoElement() || CameraController.captureFrame(),
            () => (currentStep === ScanStep.STEP1_SCANNING ? 'step1' : 'step2'),
            (rows, step) => handleOcrResult(rows, step)
        );
    }

    async function initOcrEngineWithRetry() {
        loadingOverlay.hidden = false;
        btnRetryLoad.hidden = true;
        loadingText.className = '';
        loadingText.textContent = 'Đang nạp Model 5.0…';
        try {
            await OcrEngine.init((pct, info) => {
                loadingText.textContent = `Đang nạp Model 5.0: ${info}`;
            });
            loadingOverlay.hidden = true;
            return true;
        } catch (e) {
            console.error('Không thể khởi tạo bộ máy nhận diện', e);
            loadingText.className = 'error';
            loadingText.textContent = 'Lỗi nạp Model 5.0: ' + e.message;
            btnRetryLoad.hidden = false;
            return false;
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

    // ============================== XỬ LÝ KẾT QUẢ NHẬN DIỆN ==============================

    const DEBUG_LOG_ROWS = true;

    function logRecognizedRows(label, rows) {
        if (!DEBUG_LOG_ROWS) return;
        const summary = rows.map((r, i) => `#${i}${r.isMgmd ? ' [MGMD]' : ''}: "${r.text}" (${Math.round(r.meanConfidence * 100)}%)`).join(' | ');
        console.log(`[OCR ${label}] ${summary}`);
    }

    function handleOcrResult(payload, step) {
        if (step === 'step1' && currentStep === ScanStep.STEP1_SCANNING) {
            if (payload && payload.type === 'mgmd_locked') {
                triggerAutoSnapStep1();
            } else if (Array.isArray(payload)) {
                logRecognizedRows(step, payload);
                const result = OcrParser.parseStep1(payload);
                if (result && result.allValid) onStep1Captured(result);
            }
        } else if (step === 'step2' && currentStep === ScanStep.STEP2_SCANNING) {
            const rows = payload && payload.rows ? payload.rows : (Array.isArray(payload) ? payload : []);
            logRecognizedRows(step, rows);
            for (const row of rows) {
                const result = OcrParser.parseStep2(row.tokens);
                if (result) { onStep2Captured(result); break; }
            }
        }
    }

    async function triggerAutoSnapStep1() {
        if (currentStep !== ScanStep.STEP1_SCANNING) return;
        OcrEngine.setPaused(true);

        // Hiệu ứng bắt dính thị giác: đường mép dưới chuyển xanh lá và sáng lên
        const guideBottomLine = $('guideBottomLine');
        if (guideBottomLine) {
            guideBottomLine.style.stroke = '#00e676';
            guideBottomLine.style.strokeWidth = '3.5';
            guideBottomLine.style.strokeDasharray = 'none';
        }
        HapticUtil.vibrateTick();
        BeepUtil.playBeep();

        // 1. Chụp đóng băng khung hình ngay lập tức (loại bỏ rung tay)
        const frame = CameraController.captureFrame();
        freezePreview();
        currentStep = ScanStep.STEP1_FROZEN;
        tvScanStatus.textContent = '🎯 Đã khóa mốc MGMD! Đang đọc thông số…';

        // 2. Chạy bóc tách đầy đủ trên ảnh tĩnh vừa chụp
        let result = null;
        try {
            const rows = await OcrEngine.processFrame(frame || CameraController.getVideoElement(), { tokenizeRows: false });
            logRecognizedRows('step1-auto-snap', rows);
            result = OcrParser.parseStep1(rows);
        } catch (e) {
            console.error('Lỗi đọc thông số sau khi khóa mốc MGMD', e);
        }

        if (result && result.allValid) {
            onStep1Captured(result);
        } else {
            if (result) {
                if (result.machineNo !== null && !isNaN(result.machineNo)) etMachineId.value = result.machineNo;
                if (result.rtp1 !== null && !isNaN(result.rtp1)) etParamX.value = result.rtp1;
                if (result.rtp2 !== null && !isNaN(result.rtp2)) etParamY.value = result.rtp2;
            }
            tvScanStatus.textContent = result && (result.machineNo || result.rtp1 || result.rtp2)
                ? 'Đã đọc một số thông số. Kiểm tra lại hoặc bấm [Quét lại].'
                : 'Chưa nhận diện trọn vẹn thông số. Vui lòng bấm [Quét lại] và căn chuẩn.';
            setActionButtonsEnabled(true);
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
                if (result) {
                    if (result.machineNo !== null && !isNaN(result.machineNo)) etMachineId.value = result.machineNo;
                    if (result.rtp1 !== null && !isNaN(result.rtp1)) etParamX.value = result.rtp1;
                    if (result.rtp2 !== null && !isNaN(result.rtp2)) etParamY.value = result.rtp2;
                }
                freezePreview();
                currentStep = ScanStep.STEP1_FROZEN;
                tvScanStatus.textContent = result && (result.machineNo || result.rtp1 || result.rtp2)
                    ? 'Chưa đủ tất cả thông số. Vui lòng kiểm tra, điền nốt hoặc Quét lại.'
                    : 'Chưa nhận diện được thông số. Vui lòng căn chỉnh khung ngắm và bấm [Quét lại].';
                setActionButtonsEnabled(true);
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
                tvScanStatus.textContent = 'Chưa nhận diện được ngày. Vui lòng chọn tay hoặc bấm [Quét lại].';
                setActionButtonsEnabled(true);
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

    function unfreezePreview() {
        const guideBottomLine = $('guideBottomLine');
        if (guideBottomLine) {
            guideBottomLine.style.stroke = '';
            guideBottomLine.style.strokeWidth = '';
            guideBottomLine.style.strokeDasharray = '';
        }
        frozenImg.hidden = true;
        frozenImg.src = '';
        frozenBorder.hidden = true;
        btnSavePhoto.hidden = true;
        OcrEngine.setPaused(false);
    }

    // ============================== THIẾT LẬP CÁC NÚT BẤM ==============================

    function setupClickListeners() {
        btnConfirm.addEventListener('click', onConfirmClicked);
        btnRescan.addEventListener('click', onRescanClicked);
        btnManualCapture.addEventListener('click', onManualCaptureClicked);
        btnSavePhoto.addEventListener('click', onSavePhotoClicked);
        btnEndSession.addEventListener('click', confirmEndSession);
        btnShareCsv.addEventListener('click', onShareCsvClicked);
        btnNewSession.addEventListener('click', beginNewSession);
        btnFlash.addEventListener('click', () => CameraController.toggleTorch());
        btnCameraDiag.addEventListener('click', () => CameraController.showDiagModal());
        if (btnSwitchCamera) {
            btnSwitchCamera.addEventListener('click', async () => {
                tvScanStatus.textContent = 'Đang chuyển đổi camera…';
                try {
                    await CameraController.switchCamera();
                    tvScanStatus.textContent = 'Đã đổi camera. Đang quét…';
                } catch (e) {
                    tvScanStatus.textContent = 'Lỗi đổi camera: ' + e.message;
                }
            });
        }
        btnGrantPermission.addEventListener('click', bootstrap);
        btnRetryLoad.addEventListener('click', async () => {
            const ok = await initOcrEngineWithRetry();
            if (ok && !engineStarted) await startScanningAfterEngineReady();
        });
    }

    function onRescanClicked() {
        if (currentStep === ScanStep.STEP1_FROZEN) {
            clearAllFields();
            hideBadge();
            unfreezePreview();
            currentStep = ScanStep.STEP1_SCANNING;
            updateStatusUi();
        } else if (currentStep === ScanStep.STEP2_FROZEN) {
            etDay.value = '';
            etYear.value = '';
            unfreezePreview();
            currentStep = ScanStep.STEP2_SCANNING;
            updateStatusUi();
        }
    }

    function onSavePhotoClicked() {
        // Ưu tiên lưu ảnh vùng crop khung ngắm thực tế mà OCR Engine nhận diện (để kiểm tra trực quan)
        const cropCanvas = OcrEngine.getLastCroppedBandCanvas();
        const url = cropCanvas ? cropCanvas.toDataURL('image/jpeg', 0.95) : frozenImg.src;
        if (!url) return;
        const a = document.createElement('a');
        a.href = url;
        const stepName = currentStep === ScanStep.STEP1_FROZEN ? 'step1' : 'step2';
        a.download = `debug_${stepName}_crop_mach${activeMachineNo || 'unknown'}_${Date.now()}.jpg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    // ============================== XÁC NHẬN BƯỚC 1 / BƯỚC 2 ==============================

    async function onConfirmClicked() {
        if (currentStep === ScanStep.STEP1_FROZEN) {
            handleConfirmStep1();
        } else if (currentStep === ScanStep.STEP2_FROZEN) {
            await handleConfirmStep2();
        }
    }

    function handleConfirmStep1() {
        const machStr = etMachineId.value.trim();
        const r1Str = etParamX.value.trim();
        const r2Str = etParamY.value.trim();

        if (!machStr || !r1Str || !r2Str) {
            alert('Vui lòng kiểm tra và điền đầy đủ Machine No, RTP1, RTP2!');
            return;
        }

        const mach = Number(machStr);
        const r1 = Number(r1Str);
        const r2 = Number(r2Str);

        if (Number.isNaN(mach) || mach < OcrParser.MACHINE_NO_MIN || mach > OcrParser.MACHINE_NO_MAX) {
            alert(`Machine No phải là số nguyên hợp lệ trong khoảng [${OcrParser.MACHINE_NO_MIN} - ${OcrParser.MACHINE_NO_MAX}]!`);
            return;
        }

        if (Number.isNaN(r1) || r1 < OcrParser.RTP_MIN || r1 > OcrParser.RTP_MAX) {
            alert(`RTP1 (${r1}) nằm ngoài khoảng hợp lệ [${OcrParser.RTP_MIN} - ${OcrParser.RTP_MAX}]%!`);
            return;
        }

        if (Number.isNaN(r2) || r2 < OcrParser.RTP_MIN || r2 > OcrParser.RTP_MAX) {
            alert(`RTP2 (${r2}) nằm ngoài khoảng hợp lệ [${OcrParser.RTP_MIN} - ${OcrParser.RTP_MAX}]%!`);
            return;
        }

        showBadge(mach);
        btnConfirm.textContent = 'Xác nhận & Lưu máy ➔';
        currentStep = ScanStep.STEP2_SCANNING;
        unfreezePreview();
        updateStatusUi();
    }

    async function handleConfirmStep2() {
        const dayStr = etDay.value.trim();
        const monthStr = selMonth.value;
        const yearStr = etYear.value.trim();

        if (!dayStr || !monthStr || !yearStr) {
            alert('Vui lòng chọn hoặc điền đầy đủ ngày, tháng, năm Clear RAM!');
            return;
        }

        const day = Number(dayStr);
        const month = Number(monthStr);
        const year = Number(yearStr);

        if (Number.isNaN(day) || day < 1 || day > 31) {
            alert('Ngày phải từ 1 đến 31!');
            return;
        }

        const currentYear = new Date().getFullYear();
        if (Number.isNaN(year) || year < 2000 || year > currentYear + 1) {
            alert(`Năm phải từ 2000 đến ${currentYear + 1}!`);
            return;
        }

        const ramClearDateStr = `${pad2(day)}/${pad2(month)}/${year}`;
        const scanTimestamp = nowScanTime();
        const machineNo = Number(etMachineId.value.trim());
        const rtp1 = Number(etParamX.value.trim());
        const rtp2 = Number(etParamY.value.trim());

        const csvRecord = [
            scanTimestamp,
            machineNo,
            rtp1,
            rtp2,
            0,
            0,
            ramClearDateStr,
        ];

        const fieldReading = {
            scan_time: scanTimestamp,
            scanTime: scanTimestamp,
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
        OcrEngine.stopLoop();
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

        const guideBottomLine = $('guideBottomLine');
        const guideBottomLabel = $('guideBottomLabel');
        const isStep1 = (currentStep === ScanStep.STEP1_SCANNING);
        if (guideBottomLine) guideBottomLine.style.display = isStep1 ? '' : 'none';
        if (guideBottomLabel) guideBottomLabel.style.display = isStep1 ? '' : 'none';

        switch (currentStep) {
            case ScanStep.STEP1_SCANNING:
                tvScanStatus.textContent = 'Bước 1/2 — Căn mép dưới vào chữ MGMD (máy sẽ tự chụp)…';
                setActionButtonsEnabled(false);
                break;
            case ScanStep.STEP1_FROZEN:
                tvScanStatus.textContent = 'Đã bắt được thông số. Kiểm tra và bấm Tiếp tục.';
                setActionButtonsEnabled(true);
                break;
            case ScanStep.STEP2_SCANNING:
                tvScanStatus.textContent = `Bước 2/2 — Đang quét ngày Clear RAM máy #${activeMachineNo}…`;
                setActionButtonsEnabled(false);
                break;
            case ScanStep.STEP2_FROZEN:
                tvScanStatus.textContent = 'Đã bắt được ngày. Chọn tháng và bấm Xác nhận.';
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
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
