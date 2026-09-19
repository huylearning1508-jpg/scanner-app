import React, { useState, useEffect } from 'react';
import type { ActiveTab, MachineRecord } from './types';
import { Header } from './components/Header';
import { DataTab } from './components/DataTab';
import { ScannerTab } from './components/ScannerTab';
import { SettingsModal } from './components/SettingsModal';
import {
  getSavedFirebaseConfig,
  saveAuditReading,
  subscribeToReadings,
} from './services/firebase';
import { loadOcrSession } from './services/digitOcr';
import { CheckCircle2 } from 'lucide-react';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('scan');
  const [readings, setReadings] = useState<MachineRecord[]>([]);
  const [modelReady, setModelReady] = useState(false);
  const [isFirebaseOnline, setIsFirebaseOnline] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  // 1. Nạp và khởi động sẵn Model ONNX Runtime Web
  useEffect(() => {
    loadOcrSession()
      .then(() => {
        setModelReady(true);
      })
      .catch((err) => {
        console.warn('Could not warm up model on start:', err);
      });
  }, []);

  // 2. Lắng nghe dữ liệu audit từ Realtime Database / LocalStorage
  const refreshData = () => {
    const config = getSavedFirebaseConfig();
    setIsFirebaseOnline(!!(config && config.apiKey && config.databaseURL));
  };

  useEffect(() => {
    refreshData();
    const unsubscribe = subscribeToReadings((data) => {
      setReadings(data);
    });
    return () => unsubscribe();
  }, []);

  // Khi lưu thành công một bản ghi audit mới
  const handleSaveReading = async (
    reading: Omit<MachineRecord, 'id' | 'week_number' | 'year'>
  ): Promise<string> => {
    const assignedId = await saveAuditReading(reading);
    setSuccessToast(`Đã lưu thành công số liệu Máy #${reading.machine_no}!`);
    setTimeout(() => {
      setSuccessToast(null);
    }, 4000);
    return assignedId;
  };

  const handleAuditFinished = () => {
    // Chuyển về Tab Dữ liệu để xem kết quả trong bảng Excel
    setActiveTab('data');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* App Header & Navigation */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onOpenSettings={() => setIsSettingsOpen(true)}
        isModelReady={modelReady}
        isFirebaseOnline={isFirebaseOnline}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-3 sm:p-4">
        {/* Success Toast */}
        {successToast && (
          <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white font-bold text-xs sm:text-sm px-4 py-2.5 rounded-full shadow-2xl flex items-center gap-2 border border-emerald-400/50 animate-in slide-in-from-top duration-200">
            <CheckCircle2 className="w-4 h-4 text-emerald-200" />
            <span>{successToast}</span>
          </div>
        )}

        {/* Tab 1: Dữ liệu (Bảng Excel 80 máy) */}
        {activeTab === 'data' && (
          <DataTab
            readings={readings}
            onOpenScannerForMachine={() => {
              setActiveTab('scan');
            }}
            onRefresh={refreshData}
          />
        )}

        {/* Tab 2: Quét Liveview */}
        {activeTab === 'scan' && (
          <ScannerTab
            onSaveReading={handleSaveReading}
            onAuditFinished={handleAuditFinished}
          />
        )}
      </main>

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onConfigUpdated={refreshData}
      />
    </div>
  );
};

export default App;
