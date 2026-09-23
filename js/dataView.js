/**
 * dataView.js
 * -----------------------------------------------------------------------
 * Tab "Dữ liệu" — bảng kiểm toán đọc realtime từ Firebase Realtime Database
 * (/field_readings), hiển thị: Machine No | RTP1 | RTP2 | Clear RAM Date |
 * Tuần | Xác nhận lúc.
 * -----------------------------------------------------------------------
 */

const DataView = (() => {
    let unsubscribe = null;
    let currentRows = [];
    const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function pad2(n) { return String(n).padStart(2, '0'); }

    function formatDate(d) {
        if (!d) return '-';
        if (typeof d === 'string') return d;
        if (typeof d === 'object' && d.day && d.month && d.year) {
            return `${pad2(d.day)}/${pad2(d.month)}/${d.year}`;
        }
        return '-';
    }

    function exportCsvFromRows() {
        if (!currentRows || currentRows.length === 0) {
            alert('Không có dữ liệu để xuất.');
            return;
        }
        const header = 'Machine_No,RTP1,RTP2,Total_Meters,Periodic_Meters,Clear_RAM_Date,Week,Year,Confirmed_At\r\n';
        const lines = currentRows.map((r) => {
            const mNo = r.machine_no ?? r.machineNo ?? '';
            const r1 = r.rtp1 ?? '';
            const r2 = r.rtp2 ?? '';
            const tot = r.total_meters ?? r.totalMeters ?? '';
            const per = r.periodic_meters ?? r.periodicMeters ?? '';
            const dt = formatDate(r.ram_clear_date || r.ramClearDate);
            const wk = r.week_number ?? '';
            const yr = r.year ?? '';
            const time = (r.confirmed_at || r.confirmedAt) ? new Date(r.confirmed_at || r.confirmedAt).toISOString() : '';
            return `${mNo},${r1},${r2},${tot},${per},"${dt}",${wk},${yr},"${time}"`;
        }).join('\r\n');

        const blob = new Blob([header + lines], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `audit_data_${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    function render(container, rows) {
        currentRows = rows || [];
        if (!rows || rows.length === 0) {
            container.innerHTML = `
                <div style="padding: 24px; text-align: center;">
                    <p class="status-text">Chưa có dữ liệu audit nào.</p>
                </div>
            `;
            return;
        }

        const rowsHtml = rows.map((r) => `
            <tr>
                <td><strong>#${r.machine_no ?? r.machineNo ?? '-'}</strong></td>
                <td class="${(r.auto_corrected || r.autoCorrected?.rtp1) ? 'auto-corrected' : ''}">${r.rtp1 ?? '-'}%</td>
                <td class="${(r.auto_corrected || r.autoCorrected?.rtp2) ? 'auto-corrected' : ''}">${r.rtp2 ?? '-'}%</td>
                <td>${formatDate(r.ram_clear_date || r.ramClearDate)}</td>
                <td>${r.week_number ? `Tuần ${r.week_number}` : '-'}</td>
                <td>${(r.confirmed_at || r.confirmedAt) ? new Date(r.confirmed_at || r.confirmedAt).toLocaleDateString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '-'}</td>
            </tr>
        `).join('');

        container.innerHTML = `
            <div style="padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1);">
                <div style="font-size: 14px; font-weight: 600; color: #a1a1aa;">Tổng cộng: <span style="color:#10b981;">${rows.length} bản ghi</span></div>
                <button id="btnExportDataCsv" class="btn btn-secondary" style="padding: 6px 14px; font-size: 13px;">📥 Tải CSV</button>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Máy</th><th>RTP1</th><th>RTP2</th>
                            <th>Ngày Clear</th><th>Tuần</th><th>Thời gian</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        `;

        const btnExport = document.getElementById('btnExportDataCsv');
        if (btnExport) {
            btnExport.onclick = exportCsvFromRows;
        }
    }

    function start(container) {
        container.innerHTML = '<p class="status-text" style="padding: 24px; text-align: center;">Đang tải dữ liệu kiểm toán…</p>';
        stop();
        unsubscribe = FirebaseManager.listenFieldReadings((rows) => render(container, rows));
    }

    function stop() {
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    }

    return { start, stop, MONTH_NAMES };
})();
