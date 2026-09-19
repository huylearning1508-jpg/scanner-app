import React, { useState, useMemo } from 'react';
import type { MachineRecord } from '../types';
import {
  Search,
  Download,
  Calendar,
  Layers,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ArrowUpDown,
  Camera,
} from 'lucide-react';
import * as XLSX from 'xlsx';

interface DataTabProps {
  readings: MachineRecord[];
  onOpenScannerForMachine?: (machineNo?: number) => void;
  onRefresh?: () => void;
}

export const DataTab: React.FC<DataTabProps> = ({
  readings,
  onOpenScannerForMachine,
  onRefresh,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedWeek, setSelectedWeek] = useState<string>('all');
  const [sortField, setSortField] = useState<keyof MachineRecord>('machine_no');
  const [sortAsc, setSortAsc] = useState(true);
  const [filterWarningOnly, setFilterWarningOnly] = useState(false);

  // Lấy danh sách các tuần có trong dữ liệu
  const availableWeeks = useMemo(() => {
    const weeks = new Set<number>();
    readings.forEach((r: MachineRecord) => {
      if (r.week_number) weeks.add(r.week_number);
    });
    return Array.from(weeks).sort((a, b) => b - a);
  }, [readings]);

  // Bộ lọc và sắp xếp
  const filteredReadings = useMemo(() => {
    return readings
      .filter((item: MachineRecord) => {
        // Lọc theo search term (Machine number)
        if (searchTerm) {
          const s = searchTerm.trim().toLowerCase();
          const matchNo = item.machine_no.toString().includes(s);
          const matchDate = item.ram_clear_date.toLowerCase().includes(s);
          if (!matchNo && !matchDate) return false;
        }

        // Lọc theo tuần
        if (selectedWeek !== 'all') {
          if (item.week_number !== parseInt(selectedWeek, 10)) return false;
        }

        // Lọc chỉ xem cảnh báo / tự sửa
        if (filterWarningOnly) {
          if (!item.auto_corrected && item.confidence?.anchorFound) return false;
        }

        return true;
      })
      .sort((a: MachineRecord, b: MachineRecord) => {
        const valA = a[sortField];
        const valB = b[sortField];
        if (valA === undefined || valB === undefined) return 0;
        if (valA < valB) return sortAsc ? -1 : 1;
        if (valA > valB) return sortAsc ? 1 : -1;
        return 0;
      });
  }, [readings, searchTerm, selectedWeek, sortField, sortAsc, filterWarningOnly]);

  // Thống kê nhanh
  const stats = useMemo(() => {
    const totalAudited = new Set(readings.map((r: MachineRecord) => r.machine_no)).size;
    const autoCorrectedCount = readings.filter((r: MachineRecord) => r.auto_corrected).length;
    const avgRtp1 =
      readings.length > 0
        ? (readings.reduce((sum: number, r: MachineRecord) => sum + r.rtp1, 0) / readings.length).toFixed(3)
        : '0.000';

    return {
      totalAudited,
      autoCorrectedCount,
      avgRtp1,
    };
  }, [readings]);

  const toggleSort = (field: keyof MachineRecord) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  // Xuất file Excel (.xlsx)
  const handleExportExcel = () => {
    const exportData = filteredReadings.map((r: MachineRecord) => ({
      'Machine No': r.machine_no,
      'RTP 1 (%)': r.rtp1,
      'RTP 2 (%)': r.rtp2,
      'Ngày Clear RAM': r.ram_clear_date,
      'Total Meters': r.total_meters,
      'Periodic Meters': r.periodic_meters,
      'Thời gian xác nhận': new Date(r.confirmed_at).toLocaleString('vi-VN'),
      'Tuần': r.week_number,
      'Năm': r.year,
      'Tự động sửa dấu chấm': r.auto_corrected ? 'Có' : 'Không',
      'Anchor $': r.confidence?.anchorFound ? 'Hợp lệ' : 'Cảnh báo',
      'Nhân viên xác nhận': r.confirmed_by || '',
      'Ghi chú': r.notes || '',
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Audit_Readings');
    XLSX.writeFile(
      wb,
      `V_Club_Audit_Report_${new Date().toISOString().slice(0, 10)}.xlsx`
    );
  };

  return (
    <div className="space-y-4 pb-20">
      {/* Quick KPI Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400 font-medium">Tiến độ Audit</span>
            <Layers className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-xl sm:text-2xl font-black text-slate-100">
              {stats.totalAudited}
            </span>
            <span className="text-xs text-slate-500 font-semibold">/ 80 máy</span>
          </div>
          <div className="mt-1.5 w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-emerald-500 h-full rounded-full transition-all"
              style={{ width: `${Math.min(100, (stats.totalAudited / 80) * 100)}%` }}
            />
          </div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400 font-medium">RTP1 Trung Bình</span>
            <span className="text-xs font-bold text-emerald-400">%</span>
          </div>
          <div className="mt-1 text-xl sm:text-2xl font-black text-emerald-400">
            {stats.avgRtp1}%
          </div>
          <p className="text-[10px] text-slate-500 mt-1">Chuẩn dải [80–99%]</p>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400 font-medium">Tự Sửa Dấu Chấm</span>
            <AlertTriangle className="w-4 h-4 text-amber-400" />
          </div>
          <div className="mt-1 text-xl sm:text-2xl font-black text-amber-400">
            {stats.autoCorrectedCount}
          </div>
          <p className="text-[10px] text-slate-500 mt-1">Fallback dấu thập phân</p>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400 font-medium">Thao tác</span>
            <Download className="w-4 h-4 text-blue-400" />
          </div>
          <button
            onClick={handleExportExcel}
            className="w-full mt-2 py-1.5 px-2 bg-emerald-600/90 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors shadow-sm cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Xuất Excel (.xlsx)</span>
          </button>
        </div>
      </div>

      {/* Search & Filter Toolbar */}
      <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl space-y-2.5">
        <div className="flex flex-col sm:flex-row gap-2">
          {/* Search Box */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Tìm theo số máy (vd: 12, 88) hoặc ngày..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-lg pl-9 pr-3 py-2 text-xs sm:text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition-colors"
            />
          </div>

          {/* Week Filter */}
          <div className="flex items-center gap-2">
            <div className="relative">
              <select
                value={selectedWeek}
                onChange={(e) => setSelectedWeek(e.target.value)}
                className="bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-xs sm:text-sm text-slate-200 focus:outline-none focus:border-emerald-500 appearance-none pr-8 cursor-pointer"
              >
                <option value="all">Tất cả tuần</option>
                {availableWeeks.map((w) => (
                  <option key={w} value={w.toString()}>
                    Tuần {w}
                  </option>
                ))}
              </select>
              <Calendar className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>

            {/* Warning filter toggle */}
            <button
              onClick={() => setFilterWarningOnly(!filterWarningOnly)}
              className={`px-3 py-2 rounded-lg text-xs font-semibold border flex items-center gap-1.5 transition-colors cursor-pointer ${
                filterWarningOnly
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                  : 'bg-slate-950 text-slate-400 border-slate-700/80 hover:text-slate-200'
              }`}
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>Chỉ cảnh báo</span>
            </button>

            {/* Refresh */}
            {onRefresh && (
              <button
                onClick={onRefresh}
                title="Làm mới dữ liệu"
                className="p-2 bg-slate-950 border border-slate-700/80 hover:border-slate-600 rounded-lg text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Excel-like Data Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-950 border-b border-slate-800 text-slate-400 uppercase tracking-wider font-semibold">
                <th
                  onClick={() => toggleSort('machine_no')}
                  className="py-3 px-3 cursor-pointer hover:text-slate-200"
                >
                  <div className="flex items-center gap-1">
                    <span>Machine No</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                <th
                  onClick={() => toggleSort('rtp1')}
                  className="py-3 px-3 cursor-pointer hover:text-slate-200 text-right"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span>RTP 1</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                <th
                  onClick={() => toggleSort('rtp2')}
                  className="py-3 px-3 cursor-pointer hover:text-slate-200 text-right"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span>RTP 2</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                <th className="py-3 px-3 text-center">Clear RAM Date</th>
                <th className="py-3 px-3 text-right">Total Meters</th>
                <th className="py-3 px-3 text-right">Periodic Meters</th>
                <th className="py-3 px-3 text-center">Thời gian</th>
                <th className="py-3 px-3 text-center">Trạng thái</th>
                <th className="py-3 px-3 text-center">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {filteredReadings.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-slate-500 font-sans">
                    Không tìm thấy bản ghi nào khớp với điều kiện tìm kiếm.
                  </td>
                </tr>
              ) : (
                filteredReadings.map((row: MachineRecord) => (
                  <tr
                    key={row.id}
                    className="hover:bg-slate-800/40 transition-colors group"
                  >
                    {/* Machine No */}
                    <td className="py-3 px-3 font-bold text-slate-100 font-sans">
                      <span className="inline-flex items-center justify-center px-2 py-0.5 rounded bg-slate-800 text-emerald-400 border border-slate-700 font-mono font-bold text-xs">
                        #{row.machine_no}
                      </span>
                    </td>

                    {/* RTP 1 */}
                    <td className="py-3 px-3 text-right text-emerald-400 font-bold">
                      {row.rtp1.toFixed(3)}%
                    </td>

                    {/* RTP 2 */}
                    <td className="py-3 px-3 text-right text-teal-400 font-bold">
                      {row.rtp2.toFixed(3)}%
                    </td>

                    {/* Clear RAM Date */}
                    <td className="py-3 px-3 text-center text-slate-300">
                      {row.ram_clear_date}
                    </td>

                    {/* Total Meters */}
                    <td className="py-3 px-3 text-right text-slate-300">
                      {row.total_meters?.toLocaleString('vi-VN') || '—'}
                    </td>

                    {/* Periodic Meters */}
                    <td className="py-3 px-3 text-right text-slate-400">
                      {row.periodic_meters?.toLocaleString('vi-VN') || '—'}
                    </td>

                    {/* Confirmed At */}
                    <td className="py-3 px-3 text-center text-slate-500 font-sans text-[11px]">
                      {new Date(row.confirmed_at).toLocaleDateString('vi-VN')}
                    </td>

                    {/* Status Badge */}
                    <td className="py-3 px-3 text-center font-sans">
                      {row.auto_corrected ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-semibold">
                          <AlertTriangle className="w-2.5 h-2.5" />
                          <span>Tự sửa</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold">
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          <span>Chuẩn</span>
                        </span>
                      )}
                    </td>

                    {/* Action */}
                    <td className="py-3 px-3 text-center">
                      <button
                        onClick={() => onOpenScannerForMachine && onOpenScannerForMachine(row.machine_no)}
                        title="Quét lại máy này"
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-emerald-600/30 text-slate-400 hover:text-emerald-300 transition-colors border border-slate-700 cursor-pointer inline-flex items-center gap-1 text-[11px] font-sans"
                      >
                        <Camera className="w-3 h-3" />
                        <span>Quét</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer info */}
        <div className="p-3 bg-slate-950 border-t border-slate-800 flex items-center justify-between text-xs text-slate-500">
          <span>
            Hiển thị <b className="text-slate-300">{filteredReadings.length}</b> /{' '}
            {readings.length} bản ghi
          </span>
          <span className="text-[11px]">Dữ liệu tự động đồng bộ Realtime Database</span>
        </div>
      </div>
    </div>
  );
};
