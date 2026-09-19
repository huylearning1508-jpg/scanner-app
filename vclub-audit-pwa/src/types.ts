export interface ConfidenceScores {
  machineNo: number;
  rtp1: number;
  rtp2: number;
  totalMeters?: number;
  periodicMeters?: number;
  anchorFound: boolean;
}

export interface AuditFieldResult {
  machineNo: number | null;
  rtp1: number | null;
  rtp2: number | null;
  totalMeters: number | null;
  periodicMeters: number | null;
  denom?: string | null;
  confidence: ConfidenceScores;
  autoCorrected: boolean;
  warnings: string[];
  rawStrings: {
    machineNo?: string;
    rtp1?: string;
    rtp2?: string;
    denom?: string;
    totalMeters?: string;
    periodicMeters?: string;
  };
}

export interface DateScanResult {
  day: number | null;
  month: number; // 1 - 12
  year: number | null;
  rawText?: string;
  confidence: number;
}

export interface MachineRecord {
  id: string;
  machine_no: number;
  rtp1: number;
  rtp2: number;
  total_meters: number;
  periodic_meters: number;
  ram_clear_date: string; // DD/MM/YYYY
  confidence: ConfidenceScores;
  auto_corrected: boolean;
  confirmed_at: number; // timestamp ms
  confirmed_by?: string;
  week_number: number;
  year: number;
  notes?: string;
}

export interface CharBox {
  char: string;
  confidence: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DetectedLine {
  idx: number;
  text: string;
  box: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  chars: CharBox[];
}

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
}

export type ActiveTab = 'scan' | 'data' | 'settings';
export type ScanStep = 'audit' | 'audit_review' | 'date' | 'final_confirm';
