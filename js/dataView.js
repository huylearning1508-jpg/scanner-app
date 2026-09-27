/**
 * dataView.js
 * -----------------------------------------------------------------------
 * Tab "Dữ liệu" — bảng kiểm toán đọc realtime từ Firebase Realtime Database
 * (/field_readings):
 *  - Hiển thị: Máy | RTP1 | RTP2 | Ảnh ROI | Thời gian | Thao tác
 *  - Xem phóng to ảnh chụp ROI để đối chiếu thực tế (Lightbox)
 *  - Chỉnh sửa thông số (Machine No, RTP1, RTP2) nếu phát hiện sai sót
 *  - Xuất file CSV: Không kèm ảnh, sắp xếp theo số máy tăng dần (ASC)
 * -----------------------------------------------------------------------
 */

const DataView = (() => {
    let unsubscribe = null;
    let currentRows = [];
    let currentContainer = null;
    let sortBy = 'machine_asc'; // 'machine_asc' hoặc 'time_desc'
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

    function formatTime(timestamp) {
        if (!timestamp) return '-';
        const d = new Date(timestamp);
        if (isNaN(d.getTime())) return String(timestamp);
        return d.toLocaleDateString('vi-VN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            day: '2-digit',
            month: '2-digit'
        });
    }

    /**
     * Xuất CSV:
     * - Không chứa dữ liệu ảnh
     * - Sắp xếp theo thứ tự số máy tăng dần (thứ tự số học 1, 2, 3...)
     */
    function exportCsvFromRows() {
        if (!currentRows || currentRows.length === 0) {
            alert('Không có dữ liệu để xuất.');
            return;
        }

        // Luôn sắp xếp theo số máy tăng dần khi tải file CSV
        const sorted = [...currentRows].sort((a, b) => {
            const ma = Number(a.machine_no ?? a.machineNo ?? 0);
            const mb = Number(b.machine_no ?? b.machineNo ?? 0);
            return ma - mb;
        });

        const header = 'Machine_No,RTP1,RTP2,Clear_RAM_Date,Scan_Time\r\n';
        const lines = sorted.map((r) => {
            const mNo = r.machine_no ?? r.machineNo ?? '';
            const r1 = r.rtp1 ?? '';
            const r2 = r.rtp2 ?? '';
            const dt = formatDate(r.ram_clear_date || r.ramClearDate);
            const dtStr = dt === '-' ? '' : dt;
            const timeStr = (r.confirmed_at || r.confirmedAt)
                ? new Date(r.confirmed_at || r.confirmedAt).toLocaleDateString('vi-VN', {
                    day: '2-digit', month: '2-digit', year: 'numeric',
                    hour: '2-digit', minute: '2-digit', second: '2-digit'
                })
                : (r.scan_time || '');
            return `${mNo},${r1},${r2},"${dtStr}","${timeStr}"`;
        }).join('\r\n');

        const blob = new Blob([header + lines], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `audit_rtp_sorted_${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    /**
     * Hiển thị Modal xem ảnh ROI kích thước lớn (Lightbox)
     * Hỗ trợ vuốt trái/phải (swipe) và phím bấm điều hướng theo thứ tự số máy tăng dần (nhỏ trái, lớn phải)
     */
    function showImageModal(initialRecord) {
        closeModals();

        // Danh sách các máy có ảnh, sắp xếp từ nhỏ đến lớn (nhỏ trái, lớn phải)
        const imageRecords = currentRows
            .filter((r) => Boolean(r.image_base64 && r.image_base64.length > 50))
            .sort((a, b) => {
                const ma = Number(a.machine_no ?? a.machineNo ?? 0);
                const mb = Number(b.machine_no ?? b.machineNo ?? 0);
                return ma - mb;
            });

        if (imageRecords.length === 0) {
            alert('Không tìm thấy ảnh ROI nào.');
            return;
        }

        let currentIndex = imageRecords.findIndex((r) => r.id === initialRecord.id);
        if (currentIndex === -1) currentIndex = 0;

        const overlay = document.createElement('div');
        overlay.id = 'dvModalOverlay';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-card" style="max-width: 500px; padding: 16px 18px;">
                <div class="modal-header">
                    <div style="display: flex; align-items: baseline; gap: 8px;">
                        <h3 id="dvLightboxTitle">📷 Ảnh ROI - Máy #${imageRecords[currentIndex].machine_no ?? '-'}</h3>
                        <span id="dvLightboxIndex" style="font-size: 12px; color: #a1a1aa; font-weight: 500;">(${currentIndex + 1}/${imageRecords.length})</span>
                    </div>
                    <button class="modal-close-btn" id="btnDvCloseImgModal">✕</button>
                </div>

                <div class="modal-body" style="align-items: center; position: relative;">
                    <!-- Khung chứa ảnh và 2 nút mũi tên -->
                    <div id="dvImageCarouselContainer" class="roi-image-container">
                        <button id="btnDvPrevImg" class="roi-nav-btn roi-nav-prev" title="Máy nhỏ hơn (trái)">‹</button>
                        <img id="dvLightboxImg" src="${imageRecords[currentIndex].image_base64}" alt="Ảnh ROI" class="roi-lightbox-image" />
                        <button id="btnDvNextImg" class="roi-nav-btn roi-nav-next" title="Máy lớn hơn (phải)">›</button>
                    </div>

                    <!-- Thanh thông số bóc tách -->
                    <div id="dvLightboxInfoBar" style="width: 100%; display: flex; justify-content: space-around; background: rgba(255,255,255,0.06); padding: 8px 12px; border-radius: 8px; font-size: 13px;">
                        <span>Máy: <strong id="dvLbMachine">#${imageRecords[currentIndex].machine_no}</strong></span>
                        <span>RTP1: <strong id="dvLbRtp1" style="color: #4ade80;">${imageRecords[currentIndex].rtp1}%</strong></span>
                        <span>RTP2: <strong id="dvLbRtp2" style="color: #4ade80;">${imageRecords[currentIndex].rtp2}%</strong></span>
                    </div>

                    <!-- Gợi ý vuốt -->
                    <div style="font-size: 11px; color: #71717a; text-align: center; margin-top: 2px;">
                        👈 Vuốt trái / phải để chuyển máy (nhỏ ➔ lớn) 👉
                    </div>
                </div>

                <div class="modal-footer" style="margin-top: 12px;">
                    <button id="btnDvEditFromImg" class="btn btn-primary" style="height: 40px; font-size: 13px; padding: 0 16px;">✏️ Chỉnh sửa thông số này</button>
                    <button id="btnDvCloseImgModal2" class="btn btn-secondary" style="height: 40px; font-size: 13px; padding: 0 16px;">Đóng</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const imgEl = document.getElementById('dvLightboxImg');
        const titleEl = document.getElementById('dvLightboxTitle');
        const indexEl = document.getElementById('dvLightboxIndex');
        const machEl = document.getElementById('dvLbMachine');
        const r1El = document.getElementById('dvLbRtp1');
        const r2El = document.getElementById('dvLbRtp2');
        const prevBtn = document.getElementById('btnDvPrevImg');
        const nextBtn = document.getElementById('btnDvNextImg');
        const carouselBox = document.getElementById('dvImageCarouselContainer');

        function updateView(direction = null) {
            const rec = imageRecords[currentIndex];
            titleEl.textContent = `📷 Ảnh ROI - Máy #${rec.machine_no ?? '-'}`;
            indexEl.textContent = `(${currentIndex + 1}/${imageRecords.length})`;
            machEl.textContent = `#${rec.machine_no}`;
            r1El.textContent = `${rec.rtp1}%`;
            r2El.textContent = `${rec.rtp2}%`;

            prevBtn.disabled = (currentIndex === 0);
            nextBtn.disabled = (currentIndex === imageRecords.length - 1);

            // Hiệu ứng animation trượt:
            // direction === 'left': sang máy lớn hơn (phải) -> hiệu ứng trượt từ phải vào
            // direction === 'right': sang máy nhỏ hơn (trái) -> hiệu ứng trượt từ trái vào
            imgEl.className = 'roi-lightbox-image';
            if (direction === 'left') {
                void imgEl.offsetWidth;
                imgEl.classList.add('slide-in-right');
            } else if (direction === 'right') {
                void imgEl.offsetWidth;
                imgEl.classList.add('slide-in-left');
            }
            imgEl.src = rec.image_base64;
        }

        function goToPrev() {
            if (currentIndex > 0) {
                currentIndex--;
                updateView('right'); // chuyển về máy nhỏ hơn bên trái
            }
        }

        function goToNext() {
            if (currentIndex < imageRecords.length - 1) {
                currentIndex++;
                updateView('left'); // chuyển sang máy lớn hơn bên phải
            }
        }

        // Nút mũi tên
        prevBtn.onclick = (e) => { e.stopPropagation(); goToPrev(); };
        nextBtn.onclick = (e) => { e.stopPropagation(); goToNext(); };

        // Xử lý cử chỉ vuốt (Touch Swipe)
        let touchStartX = 0;
        let touchStartY = 0;
        let touchStartTime = 0;

        carouselBox.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
                touchStartTime = Date.now();
            }
        }, { passive: true });

        carouselBox.addEventListener('touchend', (e) => {
            if (e.changedTouches.length === 1) {
                const diffX = e.changedTouches[0].clientX - touchStartX;
                const diffY = e.changedTouches[0].clientY - touchStartY;
                const elapsed = Date.now() - touchStartTime;

                // Vuốt ngang hợp lệ: khoảng cách > 35px, góc ngang lớn hơn góc dọc và thời gian < 700ms
                if (Math.abs(diffX) > 35 && Math.abs(diffX) > Math.abs(diffY) * 1.15 && elapsed < 700) {
                    if (diffX < 0) {
                        // Kéo ngón tay sang trái -> Xem máy lớn hơn ở bên phải
                        goToNext();
                    } else {
                        // Kéo ngón tay sang phải -> Xem máy nhỏ hơn ở bên trái
                        goToPrev();
                    }
                }
            }
        }, { passive: true });

        // Hỗ trợ kéo chuột trên máy tính (Mouse Drag)
        let isMouseDown = false;
        let mouseStartX = 0;
        carouselBox.addEventListener('mousedown', (e) => {
            isMouseDown = true;
            mouseStartX = e.clientX;
        });
        const onMouseUp = (e) => {
            if (!isMouseDown) return;
            isMouseDown = false;
            const diffX = e.clientX - mouseStartX;
            if (Math.abs(diffX) > 40) {
                if (diffX < 0) goToNext();
                else goToPrev();
            }
        };
        window.addEventListener('mouseup', onMouseUp);

        // Hỗ trợ phím mũi tên bàn phím
        const onKeyDown = (e) => {
            if (e.key === 'ArrowLeft') goToPrev();
            else if (e.key === 'ArrowRight') goToNext();
            else if (e.key === 'Escape') close();
        };
        window.addEventListener('keydown', onKeyDown);

        const close = () => {
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('keydown', onKeyDown);
            closeModals();
        };

        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.getElementById('btnDvCloseImgModal').onclick = close;
        document.getElementById('btnDvCloseImgModal2').onclick = close;
        document.getElementById('btnDvEditFromImg').onclick = () => {
            const currentRec = imageRecords[currentIndex];
            close();
            showEditModal(currentRec);
        };

        // Khởi tạo trạng thái ban đầu
        updateView();
    }

    /**
     * Hiển thị Modal chỉnh sửa thông số máy
     */
    function showEditModal(record) {
        closeModals();

        const overlay = document.createElement('div');
        overlay.id = 'dvModalOverlay';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-card" style="max-width: 440px;">
                <div class="modal-header">
                    <h3>✏️ Sửa thông số Máy #${record.machine_no ?? ''}</h3>
                    <button class="modal-close-btn" id="btnDvCloseEditModal">✕</button>
                </div>
                <div class="modal-body">
                    ${record.image_base64 ? `
                        <div style="text-align: center; margin-bottom: 6px;">
                            <img src="${record.image_base64}" style="max-height: 160px; max-width: 100%; border-radius: 6px; border: 1px solid rgba(255,255,255,0.2);" alt="ROI preview" />
                            <div style="font-size: 11px; color: #a1a1aa; margin-top: 4px;">Đối chiếu ảnh chụp thực tế màn hình máy</div>
                        </div>
                    ` : ''}

                    <label class="field-label" for="dvEditMachineNo">Machine No</label>
                    <input id="dvEditMachineNo" type="number" value="${record.machine_no ?? ''}" style="width: 100%; background: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #fff; padding: 8px 12px; font-size: 15px; margin-bottom: 10px;" />

                    <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                        <div style="flex: 1;">
                            <label class="field-label" for="dvEditRtp1">RTP1 (%)</label>
                            <input id="dvEditRtp1" type="number" step="0.001" value="${record.rtp1 ?? ''}" style="width: 100%; background: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #fff; padding: 8px 12px; font-size: 15px;" />
                        </div>
                        <div style="flex: 1;">
                            <label class="field-label" for="dvEditRtp2">RTP2 (%)</label>
                            <input id="dvEditRtp2" type="number" step="0.001" value="${record.rtp2 ?? ''}" style="width: 100%; background: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #fff; padding: 8px 12px; font-size: 15px;" />
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="btnDvCancelEdit" class="btn btn-secondary" style="height: 40px; font-size: 13px; padding: 0 16px;">Hủy</button>
                    <button id="btnDvSaveEdit" class="btn btn-primary" style="height: 40px; font-size: 13px; padding: 0 16px;">💾 Lưu thay đổi</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = () => closeModals();
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.getElementById('btnDvCloseEditModal').onclick = close;
        document.getElementById('btnDvCancelEdit').onclick = close;

        document.getElementById('btnDvSaveEdit').onclick = async () => {
            const newMach = Number(document.getElementById('dvEditMachineNo').value.trim());
            const newR1 = Number(document.getElementById('dvEditRtp1').value.trim());
            const newR2 = Number(document.getElementById('dvEditRtp2').value.trim());

            if (isNaN(newMach) || newMach <= 0) {
                alert('Vui lòng nhập Machine No hợp lệ!');
                return;
            }
            if (isNaN(newR1) || newR1 < 50 || newR1 > 110) {
                alert('RTP1 không hợp lệ (thường trong khoảng 50 - 110%)!');
                return;
            }
            if (isNaN(newR2) || newR2 < 50 || newR2 > 110) {
                alert('RTP2 không hợp lệ (thường trong khoảng 50 - 110%)!');
                return;
            }

            const updatedFields = {
                machine_no: newMach,
                machineNo: newMach,
                rtp1: newR1,
                rtp2: newR2,
                auto_corrected: false
            };

            const btnSave = document.getElementById('btnDvSaveEdit');
            btnSave.disabled = true;
            btnSave.textContent = 'Đang lưu…';

            // 1. Cập nhật Firebase / LocalStorage
            await FirebaseManager.updateFieldReading(record.id, updatedFields);

            // 2. Cập nhật CsvManager
            CsvManager.updateRecord(record.machine_no, updatedFields);

            // 3. Cập nhật bộ nhớ cục bộ currentRows
            const target = currentRows.find((r) => r.id === record.id);
            if (target) {
                Object.assign(target, updatedFields);
            }

            closeModals();
            if (currentContainer) render(currentContainer, currentRows);
        };
    }

    function closeModals() {
        const old = document.getElementById('dvModalOverlay');
        if (old) old.remove();
    }

    function render(container, rows) {
        currentContainer = container;
        currentRows = rows || [];
        if (!rows || rows.length === 0) {
            container.innerHTML = `
                <div style="padding: 24px; text-align: center;">
                    <p class="status-text">Chưa có dữ liệu audit nào.</p>
                </div>
            `;
            return;
        }

        // Sắp xếp dữ liệu theo lựa chọn
        const sortedRows = [...rows].sort((a, b) => {
            if (sortBy === 'machine_asc') {
                const ma = Number(a.machine_no ?? a.machineNo ?? 0);
                const mb = Number(b.machine_no ?? b.machineNo ?? 0);
                return ma - mb;
            } else {
                return (b.confirmed_at || 0) - (a.confirmed_at || 0);
            }
        });

        const rowsHtml = sortedRows.map((r) => {
            const hasImg = Boolean(r.image_base64 && r.image_base64.length > 50);
            return `
            <tr data-id="${r.id}">
                <td><strong style="font-size: 14px; color: #fff;">#${r.machine_no ?? r.machineNo ?? '-'}</strong></td>
                <td class="${(r.auto_corrected || r.autoCorrected?.rtp1) ? 'auto-corrected' : ''}">${r.rtp1 ?? '-'}%</td>
                <td class="${(r.auto_corrected || r.autoCorrected?.rtp2) ? 'auto-corrected' : ''}">${r.rtp2 ?? '-'}%</td>
                <td style="text-align: center;">
                    ${hasImg ? `
                        <img src="${r.image_base64}" class="roi-thumb" data-id="${r.id}" alt="ROI #${r.machine_no}" title="Bấm để xem ảnh phóng to" />
                    ` : `<span style="color:#71717a;">-</span>`}
                </td>
                <td style="font-size: 11px; color: #a1a1aa;">${formatTime(r.confirmed_at || r.confirmedAt)}</td>
                <td>
                    <button class="btn-edit-row" data-id="${r.id}">✏️ Sửa</button>
                </td>
            </tr>
        `;
        }).join('');

        container.innerHTML = `
            <div style="padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1);">
                <div>
                    <span style="font-size: 14px; font-weight: 600; color: #a1a1aa;">Tổng cộng: </span>
                    <strong style="color: #10b981; font-size: 15px;">${rows.length} máy</strong>
                </div>

                <div style="display: flex; gap: 8px; align-items: center;">
                    <select id="selDvSort" style="background: #27272a; border: 1px solid #3f3f46; color: #e4e4e7; border-radius: 8px; padding: 6px 8px; font-size: 12px; cursor: pointer;">
                        <option value="machine_asc" ${sortBy === 'machine_asc' ? 'selected' : ''}>Số máy tăng dần (1, 2, 3…)</option>
                        <option value="time_desc" ${sortBy === 'time_desc' ? 'selected' : ''}>Mới quét nhất lên đầu</option>
                    </select>
                    <button id="btnExportDataCsv" class="btn btn-secondary" style="height: 34px; padding: 0 12px; font-size: 12px; display: flex; align-items: center; gap: 4px;">📥 Tải CSV (Không ảnh)</button>
                </div>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Máy</th>
                            <th>RTP1</th>
                            <th>RTP2</th>
                            <th style="text-align: center;">Ảnh ROI</th>
                            <th>Thời gian</th>
                            <th>Thao tác</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        `;

        // Gán sự kiện nút tải CSV
        const btnExport = document.getElementById('btnExportDataCsv');
        if (btnExport) btnExport.onclick = exportCsvFromRows;

        // Gán sự kiện chọn cách sắp xếp
        const selSort = document.getElementById('selDvSort');
        if (selSort) {
            selSort.onchange = (e) => {
                sortBy = e.target.value;
                render(container, currentRows);
            };
        }

        // Gán sự kiện click vào ảnh thumbnail để phóng to
        container.querySelectorAll('.roi-thumb').forEach((img) => {
            img.onclick = () => {
                const id = img.dataset.id;
                const rec = currentRows.find((r) => r.id === id);
                if (rec) showImageModal(rec);
            };
        });

        // Gán sự kiện click nút Sửa
        container.querySelectorAll('.btn-edit-row').forEach((btn) => {
            btn.onclick = () => {
                const id = btn.dataset.id;
                const rec = currentRows.find((r) => r.id === id);
                if (rec) showEditModal(rec);
            };
        });
    }

    function start(container) {
        currentContainer = container;
        container.innerHTML = '<p class="status-text" style="padding: 24px; text-align: center;">Đang tải dữ liệu kiểm toán…</p>';
        stop();
        unsubscribe = FirebaseManager.listenFieldReadings((rows) => render(container, rows));
    }

    function stop() {
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        closeModals();
    }

    return { start, stop, MONTH_NAMES };
})();
