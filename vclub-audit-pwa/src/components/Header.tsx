import React from 'react';
import type { ActiveTab } from '../types';
import { Camera, Table2, Settings, Cpu, Database } from 'lucide-react';

interface HeaderProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  onOpenSettings: () => void;
  isModelReady: boolean;
  isFirebaseOnline: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  onOpenSettings,
  isModelReady,
  isFirebaseOnline,
}) => {
  return (
    <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-4 py-2.5">
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-2">
        {/* Logo & Brand */}
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/20 ring-1 ring-emerald-400/40">
            <span className="text-white font-black text-lg tracking-tighter">V</span>
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="text-sm font-bold text-slate-100 tracking-wide">V CLUB AUDIT</h1>
              <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                PWA
              </span>
            </div>
            <p className="text-[11px] text-slate-400">80 Slot Machines Weekly Audit</p>
          </div>
        </div>

        {/* System Status Indicators */}
        <div className="hidden sm:flex items-center gap-2">
          {/* AI Model Badge */}
          <div
            className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${
              isModelReady
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-amber-500/10 text-amber-400 border-amber-500/30 animate-pulse'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>{isModelReady ? 'AI 64x64 Sẵn sàng' : 'Đang nạp AI...'}</span>
          </div>

          {/* Firebase Badge */}
          <div
            className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${
              isFirebaseOnline
                ? 'bg-blue-500/10 text-blue-400 border-blue-500/30'
                : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}
          >
            <Database className="w-3.5 h-3.5" />
            <span>{isFirebaseOnline ? 'Firebase Sync' : 'Local DB'}</span>
          </div>
        </div>

        {/* Action Button & Navigation */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onOpenSettings}
            title="Cài đặt hệ thống"
            className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors border border-slate-700/60"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main 2 Tabs Navigation Bar */}
      <div className="max-w-5xl mx-auto mt-2 grid grid-cols-2 gap-1.5 p-1 bg-slate-950/80 rounded-xl border border-slate-800">
        <button
          onClick={() => setActiveTab('data')}
          className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
            activeTab === 'data'
              ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/30 ring-1 ring-emerald-400/40'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
          }`}
        >
          <Table2 className="w-4 h-4" />
          <span>Tab 1: Dữ Liệu Máy</span>
        </button>

        <button
          onClick={() => setActiveTab('scan')}
          className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
            activeTab === 'scan'
              ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/30 ring-1 ring-emerald-400/40'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
          }`}
        >
          <Camera className="w-4 h-4" />
          <span>Tab 2: Quét Liveview</span>
        </button>
      </div>
    </header>
  );
};
