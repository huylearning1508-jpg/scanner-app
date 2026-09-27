/**
 * firebaseManager.js
 * -----------------------------------------------------------------------
 * Đồng bộ dữ liệu trực tiếp lên Firebase Realtime Database (/field_readings và /machines)
 * Hoàn toàn trực tuyến, không lưu trữ đệm trong localStorage của trình duyệt.
 * -----------------------------------------------------------------------
 */

const FirebaseManager = (() => {
    let app = null;
    let db = null;
    let auth = null;
    let ready = false;

    // Dọn sạch rác cache localStorage cũ nếu còn tồn đọng từ các phiên bản trước
    try {
        localStorage.removeItem('vclub_audit_readings');
        localStorage.removeItem('rtp_ocr_current_session');
    } catch (e) { /* ignore */ }

    function isConfigured() {
        return Boolean(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.databaseURL);
    }

    /**
     * Tính số tuần trong năm (ISO 8601) - chuẩn nghiệp vụ kiểm toán máy
     */
    function getWeekNumber(d = new Date()) {
        const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
        return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    }

    async function init() {
        if (!isConfigured()) {
            console.warn('[FirebaseManager] Chưa cấu hình firebaseConfig.js');
            return false;
        }

        try {
            if (typeof firebase !== 'undefined') {
                if (firebase.apps && firebase.apps.length > 0) {
                    app = firebase.apps[0];
                } else {
                    app = firebase.initializeApp(FIREBASE_CONFIG);
                }
                db = firebase.database();

                // Thử xác thực vô danh nếu được bật, nếu không bật thì bỏ qua (dùng public rules)
                try {
                    auth = firebase.auth();
                    await auth.signInAnonymously();
                } catch (authErr) {
                    console.info('[FirebaseManager] Không dùng Anonymous Auth, kết nối trực tiếp DB:', authErr.message);
                }

                ready = true;
                console.log('[FirebaseManager] Đã kết nối Firebase:', FIREBASE_CONFIG.projectId);
                return true;
            } else {
                console.warn('[FirebaseManager] Firebase SDK chưa được tải');
                return false;
            }
        } catch (e) {
            console.error('[FirebaseManager] Khởi tạo Firebase thất bại:', e);
            ready = false;
            return false;
        }
    }

    function isReady() {
        return ready;
    }

    /**
     * Gửi bản ghi kiểm toán máy trực tiếp lên Firebase Realtime Database
     */
    async function pushFieldReading(record) {
        if (!ready || !db) {
            console.warn('[FirebaseManager] Firebase chưa sẵn sàng để ghi dữ liệu');
            return false;
        }

        const timestamp = record.confirmed_at || record.confirmedAt || Date.now();
        const dateObj = new Date(timestamp);
        const weekNum = record.week_number || getWeekNumber(dateObj);
        const year = record.year || dateObj.getFullYear();

        const machineNo = record.machine_no !== undefined ? record.machine_no : record.machineNo;

        let ramClearDateStr = '';
        if (typeof record.ram_clear_date === 'string') {
            ramClearDateStr = record.ram_clear_date;
        } else if (typeof record.ramClearDateStr === 'string') {
            ramClearDateStr = record.ramClearDateStr;
        } else if (record.ramClearDate) {
            const pad2 = (n) => String(n).padStart(2, '0');
            ramClearDateStr = `${pad2(record.ramClearDate.day)}/${pad2(record.ramClearDate.month)}/${record.ramClearDate.year}`;
        }

        const payload = {
            machine_no: machineNo !== undefined ? Number(machineNo) : null,
            machineNo: machineNo !== undefined ? Number(machineNo) : null,
            rtp1: record.rtp1 !== undefined ? Number(record.rtp1) : null,
            rtp2: record.rtp2 !== undefined ? Number(record.rtp2) : null,
            total_meters: record.total_meters !== undefined ? Number(record.total_meters) : (record.totalMeters ? Number(record.totalMeters) : 0),
            periodic_meters: record.periodic_meters !== undefined ? Number(record.periodic_meters) : (record.periodicMeters ? Number(record.periodicMeters) : 0),
            ram_clear_date: ramClearDateStr,
            confidence: record.confidence || { machineNo: 1, rtp1: 1, rtp2: 1, anchorFound: true },
            auto_corrected: Boolean(record.auto_corrected || record.autoCorrected?.rtp1 || record.autoCorrected?.rtp2),
            confirmed_at: timestamp,
            confirmedAt: timestamp,
            confirmed_by: record.confirmed_by || 'Staff',
            week_number: weekNum,
            year: year,
            notes: record.notes || '',
            image_base64: record.image_base64 || record.imageBase64 || ''
        };

        try {
            const readingsRef = db.ref('field_readings');
            const newRef = readingsRef.push();
            payload.captureId = newRef.key;

            await newRef.set(payload);

            // Cập nhật node máy /machines/{machine_no}
            if (payload.machine_no !== null && !Number.isNaN(payload.machine_no)) {
                await db.ref(`machines/${payload.machine_no}`).set({
                    last_audit: payload,
                    updated_at: timestamp
                });
            }

            console.log('[FirebaseManager] Đã lưu bản ghi lên Firebase:', newRef.key);
            return true;
        } catch (err) {
            console.error('[FirebaseManager] Lỗi ghi Firebase:', err);
            return false;
        }
    }

    /**
     * Lắng nghe trực tiếp từ Firebase Realtime Database node field_readings
     */
    function listenFieldReadings(onData) {
        if (!ready || !db) {
            onData([]);
            return () => {};
        }

        const readingsRef = db.ref('field_readings');
        const listener = readingsRef.on('value', (snapshot) => {
            const val = snapshot.val();
            if (!val) {
                onData([]);
                return;
            }

            const list = Object.entries(val).map(([id, r]) => ({
                id,
                machine_no: r.machine_no ?? r.machineNo,
                machineNo: r.machineNo ?? r.machine_no,
                rtp1: r.rtp1,
                rtp2: r.rtp2,
                total_meters: r.total_meters ?? r.totalMeters ?? 0,
                periodic_meters: r.periodic_meters ?? r.periodicMeters ?? 0,
                ram_clear_date: r.ram_clear_date ?? (r.ramClearDate ? `${String(r.ramClearDate.day).padStart(2,'0')}/${String(r.ramClearDate.month).padStart(2,'0')}/${r.ramClearDate.year}` : '-'),
                confidence: r.confidence || { machineNo: 1, rtp1: 1, rtp2: 1, anchorFound: true },
                auto_corrected: Boolean(r.auto_corrected || r.autoCorrected?.rtp1 || r.autoCorrected?.rtp2),
                confirmed_at: r.confirmed_at || r.confirmedAt || Date.now(),
                confirmedAt: r.confirmedAt || r.confirmed_at || Date.now(),
                confirmed_by: r.confirmed_by || 'Staff',
                week_number: r.week_number || getWeekNumber(new Date(r.confirmed_at || Date.now())),
                year: r.year || new Date(r.confirmed_at || Date.now()).getFullYear(),
                notes: r.notes || '',
                image_base64: r.image_base64 || r.imageBase64 || ''
            }));

            // Sắp xếp bản ghi mới nhất lên đầu
            list.sort((a, b) => b.confirmed_at - a.confirmed_at);
            onData(list);
        }, (err) => {
            console.warn('[FirebaseManager] Lỗi đọc realtime Firebase:', err);
            onData([]);
        });

        return () => readingsRef.off('value', listener);
    }

    /**
     * Cập nhật bản ghi khi người dùng kiểm tra lại và sửa thông số trên web
     */
    async function updateFieldReading(id, updatedFields) {
        if (!ready || !db || !id) return false;

        const timestamp = Date.now();
        const fields = {
            ...updatedFields,
            updated_at: timestamp
        };
        if (fields.machine_no !== undefined) {
            fields.machine_no = Number(fields.machine_no);
            fields.machineNo = Number(fields.machine_no);
        }
        if (fields.rtp1 !== undefined) fields.rtp1 = Number(fields.rtp1);
        if (fields.rtp2 !== undefined) fields.rtp2 = Number(fields.rtp2);

        try {
            await db.ref(`field_readings/${id}`).update(fields);
            if (fields.machine_no !== undefined && !Number.isNaN(fields.machine_no)) {
                await db.ref(`machines/${fields.machine_no}`).update({
                    'last_audit/machine_no': fields.machine_no,
                    'last_audit/rtp1': fields.rtp1,
                    'last_audit/rtp2': fields.rtp2,
                    updated_at: timestamp
                });
            }
            return true;
        } catch (err) {
            console.error('[FirebaseManager] Lỗi updateFieldReading:', err);
            return false;
        }
    }

    /**
     * Xóa 1 bản ghi khỏi Firebase
     */
    async function deleteFieldReading(id) {
        if (!ready || !db || !id) return false;

        try {
            await db.ref(`field_readings/${id}`).remove();
            return true;
        } catch (err) {
            console.error('[FirebaseManager] Lỗi deleteFieldReading:', err);
            return false;
        }
    }

    return {
        isConfigured,
        init,
        isReady,
        getWeekNumber,
        pushFieldReading,
        updateFieldReading,
        deleteFieldReading,
        listenFieldReadings
    };
})();
