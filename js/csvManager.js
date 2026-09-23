/**
 * csvManager.js
 * -----------------------------------------------------------------------
 * Quản lý vòng đời 1 phiên làm việc và dữ liệu CSV tương ứng.
 *
 * Vì trình duyệt không cho phép ghi trực tiếp xuống ổ đĩa như native app,
 * chiến lược "chống mất dữ liệu" được thực hiện bằng 2 lớp:
 *   1) Nếu trình duyệt hỗ trợ File System Access API (Chrome/Edge desktop,
 *      Chrome Android): người dùng chọn 1 lần nơi lưu file khi bắt đầu
 *      phiên, sau đó MỖI LẦN lưu 1 máy sẽ ghi đè lại TOÀN BỘ nội dung CSV
 *      hiện có xuống đúng file đó (tương đương "flush" tức thì).
 *   2) Luôn đồng thời lưu bản sao toàn bộ dữ liệu phiên vào localStorage
 *      sau mỗi lần lưu — nếu tab bị đóng/crash đột ngột mà chưa kịp ghi
 *      file thật, dữ liệu vẫn khôi phục được từ localStorage khi mở lại.
 *
 * Nếu trình duyệt KHÔNG hỗ trợ File System Access API (Safari, Firefox,
 * hầu hết mobile browser khác Chrome Android): dữ liệu vẫn được giữ trong
 * bộ nhớ + localStorage, người dùng bấm [Chia sẻ file CSV] để tải file
 * (Blob + <a download>) hoặc dùng Web Share API để gửi thẳng qua Zalo/Gmail.
 */

const CsvManager = (() => {
    const CSV_HEADER = 'Machine_No,RTP1,RTP2,Clear_RAM_Date,Scan_Time';
    const STORAGE_KEY = 'rtp_ocr_current_session';
    const SUPPORTS_FS_ACCESS = 'showSaveFilePicker' in window;

    let fileName = '';
    let rows = [];          // mảng các dòng CSV (không tính header)
    let fileHandle = null;  // FileSystemFileHandle (nếu hỗ trợ)

    function pad2(n) { return String(n).padStart(2, '0'); }

    function buildFileName(date = new Date()) {
        const dd = pad2(date.getDate());
        const mm = pad2(date.getMonth() + 1);
        const yyyy = date.getFullYear();
        const hh = pad2(date.getHours());
        const mi = pad2(date.getMinutes());
        const ss = pad2(date.getSeconds());
        return `${dd}_${mm}_${yyyy}_${hh}_${mi}_${ss}.csv`;
    }

    function escapeCsv(value) {
        const v = String(value ?? '');
        if (v.includes(',') || v.includes('"') || v.includes('\n')) {
            return '"' + v.replace(/"/g, '""') + '"';
        }
        return v;
    }

    function recordToRow(record) {
        return [record.machineNo, record.rtp1, record.rtp2, record.ramClearDateStr, record.scanTime]
            .map(escapeCsv).join(',');
    }

    function buildFullCsvText() {
        return [CSV_HEADER, ...rows].join('\r\n') + '\r\n';
    }

    function persistToLocalStorage() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ fileName, rows }));
        } catch (e) {
            console.error('Không thể lưu localStorage', e);
        }
    }

    function clearLocalStorage() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (e) { /* ignore */ }
    }

    /** Khôi phục phiên dở dang từ localStorage (nếu có), dùng khi mở lại trang sau khi crash. */
    function loadPendingSession() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (parsed && parsed.fileName && Array.isArray(parsed.rows)) return parsed;
            return null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Bắt đầu phiên mới. Nếu trình duyệt hỗ trợ File System Access API,
     * sẽ mở hộp thoại "Save As" 1 lần duy nhất ngay từ đầu phiên.
     * @returns {Promise<string>} tên file của phiên
     */
    async function startNewSession() {
        fileName = buildFileName();
        rows = [];
        fileHandle = null;

        if (SUPPORTS_FS_ACCESS) {
            try {
                fileHandle = await window.showSaveFilePicker({
                    suggestedName: fileName,
                    types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }]
                });
                // Ghi header ngay để file không rỗng nếu người dùng thoát sớm.
                await flushToFileHandle();
            } catch (e) {
                // Người dùng bấm Hủy hộp thoại chọn nơi lưu -> vẫn tiếp tục phiên,
                // chỉ là không ghi trực tiếp xuống đĩa được (dùng chế độ tải thủ công).
                fileHandle = null;
                console.warn('Người dùng huỷ chọn nơi lưu file, chuyển sang chế độ tải thủ công', e);
            }
        }

        clearLocalStorage();
        persistToLocalStorage();
        return fileName;
    }

    /** Khôi phục 1 phiên đã lưu dở trong localStorage (không mở lại được fileHandle cũ). */
    function resumeSession(pending) {
        fileName = pending.fileName;
        rows = pending.rows;
        fileHandle = null; // fileHandle không thể phục hồi qua reload vì lý do bảo mật của trình duyệt
    }

    async function flushToFileHandle() {
        if (!fileHandle) return false;
        try {
            const writable = await fileHandle.createWritable(); // mặc định ghi đè toàn bộ (truncate)
            await writable.write(buildFullCsvText());
            await writable.close();
            return true;
        } catch (e) {
            console.error('Lỗi ghi file CSV qua File System Access API', e);
            return false;
        }
    }

    /**
     * Ghi 1 bản ghi máy đã quét vào cuối danh sách + flush ngay (nếu có fileHandle)
     * + lưu localStorage. Trả về true nếu không có lỗi nghiêm trọng.
     */
    async function appendRecord(record) {
        rows.push(recordToRow(record));
        persistToLocalStorage();
        if (fileHandle) {
            const ok = await flushToFileHandle();
            if (!ok) return false;
        }
        return true;
    }

    function endSession() {
        // Dữ liệu vẫn giữ nguyên trong bộ nhớ + localStorage để có thể tải/chia sẻ sau khi kết thúc.
    }

    function reset() {
        fileName = '';
        rows = [];
        fileHandle = null;
        clearLocalStorage();
    }

    function getCurrentFileName() { return fileName; }
    function getRowCount() { return rows.length; }
    function isUsingDirectFileWrite() { return !!fileHandle; }
    function supportsFileSystemAccess() { return SUPPORTS_FS_ACCESS; }

    /** Tạo Blob CSV để tải xuống thủ công / chia sẻ qua Web Share API. */
    function buildBlob() {
        return new Blob([buildFullCsvText()], { type: 'text/csv;charset=utf-8;' });
    }

    /** Tải file CSV xuống máy qua thẻ <a download> (luôn hoạt động ở mọi trình duyệt). */
    function downloadCsv() {
        const blob = buildBlob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName || 'export.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    /** Chia sẻ file CSV qua Web Share API (Zalo/Gmail/Drive...) nếu trình duyệt hỗ trợ chia sẻ file. */
    async function shareCsv() {
        const blob = buildBlob();
        const file = new File([blob], fileName || 'export.csv', { type: 'text/csv' });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({
                files: [file],
                title: fileName,
                text: `File CSV phiên quét: ${fileName}`
            });
            return 'shared';
        }
        // Fallback: trình duyệt không hỗ trợ Web Share API dạng file -> tải xuống thủ công.
        downloadCsv();
        return 'downloaded';
    }

    return {
        CSV_HEADER,
        startNewSession,
        resumeSession,
        loadPendingSession,
        appendRecord,
        endSession,
        reset,
        getCurrentFileName,
        getRowCount,
        isUsingDirectFileWrite,
        supportsFileSystemAccess,
        downloadCsv,
        shareCsv
    };
})();
