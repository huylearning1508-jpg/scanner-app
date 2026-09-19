import React, { useState } from 'react';
import type { FirebaseConfig } from '../types';
import {
  getSavedFirebaseConfig,
  saveFirebaseConfig,
  SEED_MOCK_READINGS,
} from '../services/firebase';
import { X, Save, Database, RefreshCw, Cpu, Check } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfigUpdated: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onConfigUpdated,
}) => {
  const currentConfig = getSavedFirebaseConfig();
  const [apiKey, setApiKey] = useState(currentConfig?.apiKey || '');
  const [authDomain, setAuthDomain] = useState(currentConfig?.authDomain || '');
  const [databaseURL, setDatabaseURL] = useState(
    currentConfig?.databaseURL ||
      'https://vclub-audit-default-rtdb.asia-southeast1.firebasedatabase.app'
  );
  const [projectId, setProjectId] = useState(currentConfig?.projectId || 'vclub-audit');
  const [savedSuccess, setSavedSuccess] = useState(false);

  if (!isOpen) return null;

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const newConfig: FirebaseConfig = {
      apiKey: apiKey.trim(),
      authDomain: authDomain.trim(),
      databaseURL: databaseURL.trim(),
      projectId: projectId.trim(),
    };
    saveFirebaseConfig(newConfig);
    setSavedSuccess(true);
    onConfigUpdated();
    setTimeout(() => {
      setSavedSuccess(false);
      onClose();
    }, 1200);
  };

  const handleResetDemoData = () => {
    if (
      confirm(
        'Bạn có chắc chắn muốn nạp lại dữ liệu mẫu ban đầu (khởi tạo lại danh sách 4 máy audit)?'
      )
    ) {
      localStorage.setItem('vclub_audit_readings', JSON.stringify(SEED_MOCK_READINGS));
      onConfigUpdated();
      alert('Đã nạp lại dữ liệu mẫu thành công!');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-5 shadow-2xl space-y-4 animate-in fade-in zoom-in-95">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-emerald-400" />
            <h3 className="font-bold text-slate-100 text-base">Cài Đặt Hệ Thống & Firebase</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Model Info Card */}
        <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl space-y-1.5 text-xs">
          <div className="flex items-center gap-1.5 font-bold text-slate-200">
            <Cpu className="w-4 h-4 text-emerald-400" />
            <span>Mô hình AI: digit_model_64x64.onnx</span>
          </div>
          <p className="text-slate-400 text-[11px]">
            Classifier 64×64, 13 lớp: <code>0-9, %, $, .</code> (Bản Model 1.2 "10-Segments Drop",
            chịu được segment mờ/rớt nét).
          </p>
        </div>

        {/* Firebase Config Form */}
        <form onSubmit={handleSave} className="space-y-3 text-xs">
          <div>
            <label className="block font-semibold text-slate-300 mb-1">
              Firebase Project ID
            </label>
            <input
              type="text"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="vd: vclub-audit"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
            />
          </div>

          <div>
            <label className="block font-semibold text-slate-300 mb-1">
              Realtime Database URL (Khu vực asia-southeast1)
            </label>
            <input
              type="text"
              value={databaseURL}
              onChange={(e) => setDatabaseURL(e.target.value)}
              placeholder="https://...-default-rtdb.asia-southeast1.firebasedatabase.app"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
            />
          </div>

          <div>
            <label className="block font-semibold text-slate-300 mb-1">Firebase API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="AIzaSy..."
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
            />
          </div>

          <div>
            <label className="block font-semibold text-slate-300 mb-1">Auth Domain</label>
            <input
              type="text"
              value={authDomain}
              onChange={(e) => setAuthDomain(e.target.value)}
              placeholder="vclub-audit.firebaseapp.com"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
            />
          </div>

          {savedSuccess && (
            <div className="p-2 bg-emerald-500/20 text-emerald-300 rounded-lg flex items-center gap-1.5 text-xs font-semibold">
              <Check className="w-4 h-4" />
              <span>Đã lưu cấu hình Firebase thành công!</span>
            </div>
          )}

          <div className="pt-2 flex gap-2">
            <button
              type="submit"
              className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold flex items-center justify-center gap-1.5 shadow-md shadow-emerald-600/30"
            >
              <Save className="w-4 h-4" />
              <span>Lưu Cấu Hình</span>
            </button>
          </div>
        </form>

        {/* Local database actions */}
        <div className="border-t border-slate-800 pt-3 flex items-center justify-between text-xs text-slate-400">
          <span>Dữ liệu cục bộ:</span>
          <button
            onClick={handleResetDemoData}
            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center gap-1"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Nạp lại 4 máy mẫu</span>
          </button>
        </div>
      </div>
    </div>
  );
};
