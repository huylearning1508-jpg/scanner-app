/**
 * Firebase Realtime Database & Auth Service
 * Hỗ trợ lưu trữ `/field_readings/{captureId}` và `/machines/{machineId}`
 * Có cơ chế Offline LocalStorage Fallback tự động khi chưa có Firebase Config
 */

import { initializeApp, getApps } from 'firebase/app';
import type { FirebaseApp } from 'firebase/app';
import {
  getDatabase,
  ref,
  push,
  set,
  onValue,
  Database,
} from 'firebase/database';
import type { FirebaseConfig, MachineRecord } from '../types';

const STORAGE_KEY_CONFIG = 'vclub_firebase_config';
const STORAGE_KEY_READINGS = 'vclub_audit_readings';

let firebaseApp: FirebaseApp | null = null;
let firebaseDb: Database | null = null;

// Lấy số tuần trong năm (ISO-8601)
export function getWeekNumber(d: Date = new Date()): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

// Danh sách dữ liệu mẫu ban đầu để giao diện có sẵn số liệu kiểm thử
export const SEED_MOCK_READINGS: MachineRecord[] = [
  {
    id: 'mock-01',
    machine_no: 12,
    rtp1: 92.734,
    rtp2: 93.63,
    total_meters: 58249012,
    periodic_meters: 1420395,
    ram_clear_date: '23/03/2026',
    confidence: { machineNo: 0.99, rtp1: 0.98, rtp2: 0.97, anchorFound: true },
    auto_corrected: false,
    confirmed_at: Date.now() - 3600000 * 24 * 2,
    confirmed_by: 'Staff A (Shift 1)',
    week_number: getWeekNumber(),
    year: 2026,
    notes: 'Audit định kỳ tuần',
  },
  {
    id: 'mock-02',
    machine_no: 88,
    rtp1: 94.125,
    rtp2: 95.0,
    total_meters: 109348210,
    periodic_meters: 3948210,
    ram_clear_date: '15/02/2026',
    confidence: { machineNo: 0.97, rtp1: 0.94, rtp2: 0.96, anchorFound: true },
    auto_corrected: false,
    confirmed_at: Date.now() - 3600000 * 24 * 3,
    confirmed_by: 'Staff B (Shift 2)',
    week_number: getWeekNumber(),
    year: 2026,
  },
  {
    id: 'mock-03',
    machine_no: 105,
    rtp1: 91.85,
    rtp2: 92.5,
    total_meters: 84729104,
    periodic_meters: 2194820,
    ram_clear_date: '08/01/2026',
    confidence: { machineNo: 0.95, rtp1: 0.88, rtp2: 0.89, anchorFound: true },
    auto_corrected: true, // Tự động sửa dấu chấm
    confirmed_at: Date.now() - 3600000 * 24 * 4,
    confirmed_by: 'Staff A (Shift 1)',
    week_number: getWeekNumber(),
    year: 2026,
    notes: 'Tự động chèn dấu chấm RTP',
  },
  {
    id: 'mock-04',
    machine_no: 777,
    rtp1: 96.42,
    rtp2: 97.1,
    total_meters: 214981043,
    periodic_meters: 9841029,
    ram_clear_date: '01/03/2026',
    confidence: { machineNo: 0.99, rtp1: 0.97, rtp2: 0.98, anchorFound: true },
    auto_corrected: false,
    confirmed_at: Date.now() - 3600000 * 12,
    confirmed_by: 'Staff C (VIP room)',
    week_number: getWeekNumber(),
    year: 2026,
  },
];

/**
 * Đọc cấu hình Firebase từ localStorage
 */
export function getSavedFirebaseConfig(): FirebaseConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CONFIG);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Lưu cấu hình Firebase vào localStorage
 */
export function saveFirebaseConfig(config: FirebaseConfig) {
  localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(config));
  initFirebase();
}

/**
 * Khởi tạo kết nối Firebase
 */
export function initFirebase(): boolean {
  const config = getSavedFirebaseConfig();
  if (!config || !config.apiKey || !config.databaseURL) {
    console.log('Chưa có cấu hình Firebase, sử dụng Local Database Offline.');
    return false;
  }

  try {
    if (getApps().length > 0) {
      firebaseApp = getApps()[0];
    } else {
      firebaseApp = initializeApp(config);
    }
    firebaseDb = getDatabase(firebaseApp);
    console.log('Khởi tạo Firebase thành công:', config.projectId);
    return true;
  } catch (err) {
    console.error('Lỗi khởi tạo Firebase:', err);
    return false;
  }
}

// Khởi chạy ngay khi load app
initFirebase();

/**
 * Đọc dữ liệu cục bộ từ LocalStorage
 */
export function getLocalReadings(): MachineRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_READINGS);
    if (!raw) {
      // Khởi tạo dữ liệu mẫu nếu chưa có
      localStorage.setItem(STORAGE_KEY_READINGS, JSON.stringify(SEED_MOCK_READINGS));
      return SEED_MOCK_READINGS;
    }
    return JSON.parse(raw);
  } catch {
    return SEED_MOCK_READINGS;
  }
}

/**
 * Lưu 1 bản ghi đọc audit máy slot lên Firebase Realtime Database
 * Đồng thời đồng bộ xuống LocalStorage để phục vụ offline
 */
export async function saveAuditReading(
  reading: Omit<MachineRecord, 'id' | 'week_number' | 'year'>
): Promise<string> {
  const weekNum = getWeekNumber(new Date(reading.confirmed_at));
  const year = new Date(reading.confirmed_at).getFullYear();

  const recordPayload: Omit<MachineRecord, 'id'> = {
    ...reading,
    week_number: weekNum,
    year: year,
  };

  let assignedId = 'loc_' + Date.now();

  if (firebaseDb) {
    try {
      const readingsRef = ref(firebaseDb, 'field_readings');
      const newRef = push(readingsRef);
      assignedId = newRef.key || assignedId;
      await set(newRef, {
        ...recordPayload,
        captureId: assignedId,
      });

      // Cập nhật bảng metadata của máy /machines/{machineId}
      const machineRef = ref(firebaseDb, `machines/${reading.machine_no}`);
      await set(machineRef, {
        last_audit: recordPayload,
        updated_at: Date.now(),
      });
      console.log('Đã lưu bản ghi lên Firebase:', assignedId);
    } catch (err) {
      console.warn('Lỗi ghi Firebase, lưu tạm vào Local Database:', err);
    }
  }

  // Luôn lưu vào LocalStorage để xem tức thời
  const localList = getLocalReadings();
  const fullRecord: MachineRecord = {
    ...recordPayload,
    id: assignedId,
  };
  const updated = [fullRecord, ...localList.filter((r) => r.id !== assignedId)];
  localStorage.setItem(STORAGE_KEY_READINGS, JSON.stringify(updated));

  return assignedId;
}

/**
 * Lắng nghe thay đổi dữ liệu Realtime Database
 */
export function subscribeToReadings(
  callback: (readings: MachineRecord[]) => void
): () => void {
  // Trả về dữ liệu local trước
  callback(getLocalReadings());

  if (!firebaseDb) {
    const handleStorageChange = () => {
      callback(getLocalReadings());
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }

  const readingsRef = ref(firebaseDb, 'field_readings');
  const unsubscribe = onValue(
    readingsRef,
    (snapshot) => {
      const val = snapshot.val();
      if (!val) {
        callback(getLocalReadings());
        return;
      }
      const list: MachineRecord[] = Object.entries(val).map(
        ([key, data]: [string, any]) => ({
          id: key,
          machine_no: data.machine_no,
          rtp1: data.rtp1,
          rtp2: data.rtp2,
          total_meters: data.total_meters,
          periodic_meters: data.periodic_meters,
          ram_clear_date: data.ram_clear_date,
          confidence: data.confidence || {
            machineNo: 1,
            rtp1: 1,
            rtp2: 1,
            anchorFound: true,
          },
          auto_corrected: !!data.auto_corrected,
          confirmed_at: data.confirmed_at || Date.now(),
          confirmed_by: data.confirmed_by || 'Staff',
          week_number: data.week_number || getWeekNumber(),
          year: data.year || 2026,
          notes: data.notes || '',
        })
      );
      // Sắp xếp theo thời gian mới nhất lên đầu
      list.sort((a, b) => b.confirmed_at - a.confirmed_at);
      callback(list);

      // Cập nhật cache local
      localStorage.setItem(STORAGE_KEY_READINGS, JSON.stringify(list));
    },
    (err) => {
      console.warn('Lỗi đọc realtime Firebase:', err);
      callback(getLocalReadings());
    }
  );

  return () => unsubscribe();
}

/**
 * Xóa 1 bản ghi (chỉ dùng cho quản lý)
 */
export function deleteLocalReading(id: string) {
  const current = getLocalReadings();
  const filtered = current.filter((r) => r.id !== id);
  localStorage.setItem(STORAGE_KEY_READINGS, JSON.stringify(filtered));
}
