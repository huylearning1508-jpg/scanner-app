/**
 * dataView.js
 * -----------------------------------------------------------------------
 * Tab "Dữ liệu" — bảng kiểu Excel đọc realtime từ Firebase Realtime
 * Database (field_readings), hiển thị Machine No | RTP1 | RTP2 | Clear
 * RAM Date | Total | Periodic.
 * -----------------------------------------------------------------------
 */

const DataView = (() => {
    let unsubscribe = null;
    const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function pad2(n) { return String(n).padStart(2, '0'); }

    function formatDate(d) {
        if (!d) return '-';
        return `${pad2(d.day)}/${pad2(d.month)}/${d.year}`;
    }

    function render(container, rows) {
        if (!rows || rows.length === 0) {
            container.innerHTML = '<p class="status-text">Chưa có dữ liệu audit nào.</p>';
            return;
        }
        const rowsHtml = rows.map((r) => `
            <tr>
                <td>${r.machineNo ?? '-'}</td>
                <td class="${r.autoCorrected?.rtp1 ? 'auto-corrected' : ''}">${r.rtp1 ?? '-'}%</td>
                <td class="${r.autoCorrected?.rtp2 ? 'auto-corrected' : ''}">${r.rtp2 ?? '-'}%</td>
                <td>${r.totalMeters ?? '-'}</td>
                <td>${r.periodicMeters ?? '-'}</td>
                <td>${formatDate(r.ramClearDate)}</td>
                <td>${r.confirmedAt ? new Date(r.confirmedAt).toLocaleString('vi-VN') : '-'}</td>
            </tr>
        `).join('');

        container.innerHTML = `
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Machine No</th><th>RTP1</th><th>RTP2</th>
                            <th>Total</th><th>Periodic</th>
                            <th>Clear RAM Date</th><th>Xác nhận lúc</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        `;
    }

    function start(container) {
        container.innerHTML = '<p class="status-text">Đang tải dữ liệu...</p>';
        if (!FirebaseManager.isReady()) {
            container.innerHTML = '<p class="status-text error">Chưa kết nối Firebase.</p>';
            return;
        }
        stop();
        unsubscribe = FirebaseManager.listenFieldReadings((rows) => render(container, rows));
    }

    function stop() {
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    }

    return { start, stop, MONTH_NAMES };
})();
