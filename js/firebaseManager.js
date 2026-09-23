/**
 * firebaseManager.js
 * -----------------------------------------------------------------------
 * Đồng bộ dữ liệu lên Firebase Realtime Database của dự án scanner-app-67176
 * Kế thừa 100% logic cốt lõi của scanner-app-67176:
 *  - Cấu trúc /field_readings/{pushId} và /machines/{machine_no}
 *  - Quản lý số tuần (week_number) và năm (year) theo chuẩn ISO 8601
 *  - Offline-first: lưu đồng thời vào localStorage (key: vclub_audit_readings)
 *  - Không bị nghẽn nếu Anonymous Auth chưa bật (sử dụng direct Realtime DB)
 * -----------------------------------------------------------------------
 */

const FirebaseManager = (() => {
    const STORAGE_KEY_READINGS = 'vclub_audit_readings';
    let app = null;
    let db = null;
    let auth = null;
    let ready = false;

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

    /**
     * Lấy danh sách bản ghi offline từ localStorage
     */
    function getLocalReadings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_READINGS);
            if (!raw) return [];
            return JSON.parse(raw);
        } catch (e) {
            console.warn('[FirebaseManager] Lỗi đọc localStorage:', e);
            return [];
        }
    }

    /**
     * Lưu danh sách bản ghi offline vào localStorage
     */
    function saveLocalReadings(list) {
        try {
            localStorage.setItem(STORAGE_KEY_READINGS, JSON.stringify(list));
        } catch (e) {
            console.warn('[FirebaseManager] Lỗi ghi localStorage:', e);
        }
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
     * Lưu bản ghi kiểm toán máy:
     * 1. Lưu offline vào localStorage tức thì
     * 2. Ghi lên /field_readings
     * 3. Cập nhật metadata /machines/{machine_no}
     */
    async function pushFieldReading(record) {
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
            notes: record.notes || ''
        };

        let assignedId = 'loc_' + Date.now();

        // 1. Lưu offline vào localStorage
        const localList = getLocalReadings();
        const localRecord = { id: assignedId, ...payload };
        saveLocalReadings([localRecord, ...localList.filter((r) => r.id !== assignedId)]);

        // 2. Ghi lên Firebase Realtime Database
        if (ready && db) {
            try {
                const readingsRef = db.ref('field_readings');
                const newRef = readingsRef.push();
                assignedId = newRef.key || assignedId;
                payload.captureId = assignedId;

                await newRef.set(payload);

                // Cập nhật node máy /machines/{machine_no}
                if (payload.machine_no !== null && !Number.isNaN(payload.machine_no)) {
                    await db.ref(`machines/${payload.machine_no}`).set({
                        last_audit: payload,
                        updated_at: timestamp
                    });
                }

                console.log('[FirebaseManager] Đã lưu bản ghi lên Firebase:', assignedId);
                return true;
            } catch (err) {
                console.warn('[FirebaseManager] Lỗi ghi Firebase, dữ liệu đã được bảo toàn ở LocalStorage:', err);
                return false;
            }
        }

        return true;
    }

    /**
     * Lắng nghe realtime từ node field_readings
     */
    function listenFieldReadings(onData) {
        // Trả về dữ liệu local trước để hiển thị tức thời
        const local = getLocalReadings();
        if (local.length > 0) {
            onData(local);
        }

        if (!ready || !db) {
            const handleStorageChange = () => onData(getLocalReadings());
            window.addEventListener('storage', handleStorageChange);
            return () => window.removeEventListener('storage', handleStorageChange);
        }

        const readingsRef = db.ref('field_readings');
        const listener = readingsRef.on('value', (snapshot) => {
            const val = snapshot.val();
            if (!val) {
                onData(getLocalReadings());
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
                notes: r.notes || ''
            }));

            // Sắp xếp bản ghi mới nhất lên đầu
            list.sort((a, b) => b.confirmed_at - a.confirmed_at);
            onData(list);

            // Cập nhật lại cache offline
            saveLocalReadings(list);
        }, (err) => {
            console.warn('[FirebaseManager] Lỗi đọc realtime Firebase:', err);
            onData(getLocalReadings());
        });

        return () => readingsRef.off('value', listener);
    }

    return {
        isConfigured,
        init,
        isReady,
        getWeekNumber,
        getLocalReadings,
        pushFieldReading,
        listenFieldReadings
    };
})();
