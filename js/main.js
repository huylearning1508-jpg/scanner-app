/**
 * main.js
 * -----------------------------------------------------------------------
 * Điều phối máy trạng thái quét 2 bước/máy (giữ nguyên tinh thần bản cũ),
 * nhưng nối với OcrEngine mới (model số + anchor-"$", không còn Tesseract),
 * thêm: tab Dữ liệu, dropdown chọn tháng tay (chưa có model tháng), toggle
 * bộ lọc live tuỳ chọn.
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
    const tabBtnData = $('tabBtnData');
    const tabBtnScan = $('tabBtnScan');
    const dataTabView = $('dataTabView');
    const scanTabView = $('scanTabView');

    // ---- Camera / scan ----
    const videoEl = $('video');
    const liveFilterCanvas = $('liveFilterCanvas');
    const chkLiveFilter = $('chkLiveFilter');
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
        OcrEngine.setPaused(currentStep === ScanStep.STEP1_FROZEN || currentStep === ScanStep.STEP2_FROZEN || currentStep === ScanStep.SESSION_ENDED);
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

        try {
            await CameraController.startCamera();
            permissionOverlay.hidden = true;
        } catch (e) {
            console.error('Không thể mở camera', e);
            permissionOverlay.hidden = false;
            return;
        }

        btnFlash.style.display = CameraController.isTorchSupported() ? '' : 'none';

        const ok = await initOcrEngineWithRetry();
        if (ok) await startScanningAfterEngineReady();
    }

    async function startScanningAfterEngineReady() {
        await initFirebaseSync();
        await beginNewSession();

        engineStarted = true;
        OcrEngine.startLoop(
            () => CameraController.getVideoElement() || CameraController.captureFrame(),
            () => (currentStep === ScanStep.STEP1_SCANNING ? 'step1' : 'step2'),
            (rows, step) => handleOcrResult(rows, step),
            (previewCanvas) => drawLiveFilter(previewCanvas)
        );
    }

    /**
     * Khởi tạo OcrEngine (OpenCV.js + model số). Không dùng alert() chặn UI
     * khi lỗi (quan sát thực tế trên iOS: alert() làm cảm giác app "đứng
     * hình") — thay bằng thông báo + nút Thử lại ngay trong loadingOverlay.
     */
    async function initOcrEngineWithRetry() {
        loadingOverlay.hidden = false;
        btnRetryLoad.hidden = true;
        loadingText.className = '';
        loadingText.textContent = 'Đang tải model nhận diện (lần đầu có thể mất vài giây)…';
        try {
            await OcrEngine.init();
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

    // Bật để xem log dòng/độ tin cậy pipeline đọc được mỗi lần thử — hữu ích
    // khi cần chẩn đoán tại sao không nhận diện ra số trên 1 ảnh thật cụ thể.
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

    /**
     * Nút "Chụp tay" — dự phòng khi auto-detect gặp khó (mờ/loá dai dẳng).
     * Thử chạy luôn pipeline nhận diện trên khung hiện tại; nếu ra kết quả
     * hợp lệ thì điền sẵn như auto-detect, nếu không vẫn đóng băng để nhân
     * viên tự nhìn ảnh gõ tay — không để nhân viên bị kẹt chờ vô hạn.
     */
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

    /** Bản beta: cho tải ảnh gốc vừa chụp về để debug pipeline offline (xem README/tools/). */
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
        OcrEngine.setPaused(false);
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
            machineNo, rtp1, rtp2,
            ramClearDate: { day, month, year },
            confidence: {
                machineNo: 1, rtp1: 1, rtp2: 1,
            },
            autoCorrected: {
                rtp1: etParamX.dataset.autoCorrected === 'true',
                rtp2: etParamY.dataset.autoCorrected === 'true',
            },
        };

        const saved = await CsvManager.appendRecord(csvRecord);
        if (saved) {
            scannedCount++;
            updateScannedCountUi();
        } else {
            alert('Lỗi ghi file CSV — dữ liệu vẫn được giữ tạm, hãy thử [Chia sẻ file CSV] để tải về!');
        }

        if (FirebaseManager.isReady()) {
            FirebaseManager.pushFieldReading(fieldReading).then((ok) => {
                tvCloudStatus.textContent = ok ? '☁ Firebase: đã đồng bộ' : '⚠ Firebase: lỗi đồng bộ máy vừa lưu';
                tvCloudStatus.className = ok ? 'cloud-ok' : 'cloud-error';
            });
        }

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

        switch (currentStep) {
            case ScanStep.STEP1_SCANNING:
                tvScanStatus.textContent = 'Bước 1/2 — Đang quét thông số máy… (hoặc bấm Chụp tay)';
                setActionButtonsEnabled(false);
                break;
            case ScanStep.STEP1_FROZEN:
                tvScanStatus.textContent = 'Đã bắt được thông số. Kiểm tra (sửa tay nếu cần) và bấm Tiếp tục.';
                setActionButtonsEnabled(true);
                break;
            case ScanStep.STEP2_SCANNING:
                tvScanStatus.textContent = `Bước 2/2 — Đang quét ngày Clear RAM máy #${activeMachineNo}… (hoặc bấm Chụp tay)`;
                setActionButtonsEnabled(false);
                break;
            case ScanStep.STEP2_FROZEN:
                tvScanStatus.textContent = 'Đã bắt được ngày (hoặc trống nếu chưa đọc được — nhìn ảnh gõ tay). Chọn tháng và bấm Xác nhận.';
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

    document.addEventListener('DOMContentLoaded', bootstrap);
})();
