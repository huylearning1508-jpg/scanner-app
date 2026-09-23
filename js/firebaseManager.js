/**
 * firebaseManager.js
 * -----------------------------------------------------------------------
 * Đồng bộ dữ liệu lên Firebase Realtime Database (thay Firestore của bản
 * cũ, theo đúng config Realtime DB bạn cung cấp).
 *
 * Auth: dùng Anonymous Auth (giữ nguyên cơ chế bản cũ) — chưa làm màn
 * đăng nhập 1-tài-khoản-chung-cho-club vì cần bạn tạo sẵn tài khoản đó
 * trong Firebase Console trước (Console -> Authentication -> Email/Password
 * -> Add user). Khi có tài khoản đó, chỉ cần đổi initAuth() bên dưới sang
 * signInWithEmailAndPassword thay vì signInAnonymously — phần Rules cũng
 * cần sửa lại để chỉ chấp nhận đúng UID/email đó.
 *
 * Cấu trúc dữ liệu Realtime Database:
 *   field_readings/{pushId}: {
 *     machineNo, rtp1, rtp2, totalMeters, periodicMeters,
 *     ramClearDate: {day, month, year},
 *     confidence: {machineNo, rtp1, rtp2},
 *     autoCorrected: {rtp1, rtp2},
 *     confirmedAt (server timestamp)
 *   }
 * -----------------------------------------------------------------------
 */

const FirebaseManager = (() => {
    let app = null;
    let db = null;
    let auth = null;
    let ready = false;

    function isConfigured() {
        return FIREBASE_CONFIG && !String(FIREBASE_CONFIG.apiKey).startsWith('REPLACE_WITH');
    }

    async function init() {
        if (!isConfigured()) {
            console.warn('[FirebaseManager] Chưa cấu hình firebaseConfig.js');
            return false;
        }
        try {
            app = firebase.initializeApp(FIREBASE_CONFIG);
            db = firebase.database();
            auth = firebase.auth();
            await auth.signInAnonymously();
            ready = true;
            return true;
        } catch (e) {
            console.error('[FirebaseManager] Khởi tạo Firebase thất bại', e);
            ready = false;
            return false;
        }
    }

    function isReady() { return ready; }

    /** Ghi 1 bản audit đã xác nhận lên Realtime Database. Trả về true/false. */
    async function pushFieldReading(record) {
        if (!ready) return false;
        try {
            await db.ref('field_readings').push({
                ...record,
                confirmedAt: firebase.database.ServerValue.TIMESTAMP,
            });
            return true;
        } catch (e) {
            console.error('[FirebaseManager] Lỗi ghi field_readings', e);
            return false;
        }
    }

    /** Lắng nghe realtime toàn bộ field_readings — dùng cho Tab Dữ liệu. */
    function listenFieldReadings(onData) {
        if (!ready) return () => {};
        const refPath = db.ref('field_readings');
        const listener = refPath.on('value', (snapshot) => {
            const val = snapshot.val() || {};
            const list = Object.entries(val).map(([id, r]) => ({ id, ...r }));
            list.sort((a, b) => (b.confirmedAt || 0) - (a.confirmedAt || 0));
            onData(list);
        });
        return () => refPath.off('value', listener);
    }

    return { isConfigured, init, isReady, pushFieldReading, listenFieldReadings };
})();
