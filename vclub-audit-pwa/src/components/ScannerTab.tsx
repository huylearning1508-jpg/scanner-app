import React, { useRef, useState, useEffect, useCallback } from 'react';
import type {
  AuditFieldResult,
  ConfidenceScores,
  DetectedLine,
  MachineRecord,
  ScanStep,
} from '../types';
import {
  Camera,
  Zap,
  ZapOff,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  ShieldCheck,
  Calendar,
  ChevronRight,
  RotateCcw,
  Sparkles,
  Lock,
} from 'lucide-react';
import {
  adaptiveThreshold,
  extractLines,
  removeDitherNoise,
  toGrayscale,
} from '../services/imageProcessing';
import { loadOcrSession, recognizeLine } from '../services/digitOcr';
import { extractAuditFields, extractDateFromLines } from '../services/fieldExtractor';
import { StabilityTracker } from '../services/stabilityTracker';
import { playSuccessBeep, playWarningBeep, triggerHaptic } from '../services/audio';

interface ScannerTabProps {
  onSaveReading: (reading: Omit<MachineRecord, 'id' | 'week_number' | 'year'>) => Promise<string>;
  onAuditFinished: () => void;
  defaultMachineNo?: number;
}

const MONTH_NAMES = [
  'Tháng 1 (Jan)',
  'Tháng 2 (Feb)',
  'Tháng 3 (Mar)',
  'Tháng 4 (Apr)',
  'Tháng 5 (May)',
  'Tháng 6 (Jun)',
  'Tháng 7 (Jul)',
  'Tháng 8 (Aug)',
  'Tháng 9 (Sep)',
  'Tháng 10 (Oct)',
  'Tháng 11 (Nov)',
  'Tháng 12 (Dec)',
];

export const ScannerTab: React.FC<ScannerTabProps> = ({
  onSaveReading,
  onAuditFinished,
  defaultMachineNo,
}) => {
  // Video & Canvas refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const freezeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewfinderRef = useRef<HTMLDivElement | null>(null);

  // Trạng thái Camera
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraFacing, setCameraFacing] = useState<'environment' | 'user'>('environment');
  const [torchOn, setTorchOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isRequestingCamera, setIsRequestingCamera] = useState(false);

  // Tiến trình 2 bước chụp
  const [step, setStep] = useState<ScanStep>('audit');

  // Trạng thái nhận diện thời gian thực (Live HUD)
  const [liveResult, setLiveResult] = useState<AuditFieldResult | null>(null);
  const [stabilityMatches, setStabilityMatches] = useState(0);
  const stabilityTrackerRef = useRef(new StabilityTracker(2, 0.65));

  // Dữ liệu đã đóng băng cho Modal xác nhận Bước 1 (Audit Screen)
  const [confirmedMachineNo, setConfirmedMachineNo] = useState<string>(
    defaultMachineNo ? defaultMachineNo.toString() : ''
  );
  const [confirmedRtp1, setConfirmedRtp1] = useState<string>('');
  const [confirmedRtp2, setConfirmedRtp2] = useState<string>('');
  const [confirmedTotalMeters, setConfirmedTotalMeters] = useState<string>('');
  const [confirmedPeriodicMeters, setConfirmedPeriodicMeters] = useState<string>('');
  const [isAutoCorrectedRtp, setIsAutoCorrectedRtp] = useState(false);
  const [auditConfidence, setAuditConfidence] = useState<ConfidenceScores>({
    machineNo: 0,
    rtp1: 0,
    rtp2: 0,
    anchorFound: false,
  });

  // Dữ liệu Bước 2 (Màn Ngày Clear RAM)
  const [ramDay, setRamDay] = useState<string>('23');
  const [ramMonth, setRamMonth] = useState<number>(3); // Mặc định tháng 3 theo ảnh mẫu
  const [ramYear, setRamYear] = useState<string>('2026');
  const [isSaving, setIsSaving] = useState(false);

  // 1. Mở camera với cơ chế phân tầng fallback mạnh mẽ
  const startCamera = useCallback(async () => {
    setIsRequestingCamera(true);
    setCameraError(null);

    // Dọn dẹp stream cũ nếu có
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
    }

    // Kiểm tra Secure Context (HTTPS hoặc localhost)
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setCameraError(
        'Trình duyệt chặn Camera do truy cập qua HTTP không an toàn. Vui lòng mở lại trang web bằng giao thức HTTPS (https://...) hoặc http://localhost:... trên máy tính.'
      );
      setIsRequestingCamera(false);
      return;
    }

    // Kiểm tra API mediaDevices
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      setCameraError(
        'Trình duyệt này không hỗ trợ getUserMedia hoặc quyền camera bị chặn bởi chính sách bảo mật.'
      );
      setIsRequestingCamera(false);
      return;
    }

    let mediaStream: MediaStream | null = null;

    // Lần thử 1: HD 1280x720 với facingMode mong muốn
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: cameraFacing },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    } catch (err1) {
      console.warn('Lần thử 1 không thành công, thử fallback 2:', err1);
      // Lần thử 2: facingMode tự do
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: cameraFacing,
          },
          audio: false,
        });
      } catch (err2) {
        console.warn('Lần thử 2 không thành công, thử fallback 3:', err2);
        // Lần thử 3: Bất kỳ camera nào có sẵn
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        } catch (err3: any) {
          console.error('Tất cả lần thử mở camera đều thất bại:', err3);
          setCameraError(
            err3.name === 'NotAllowedError' || err3.name === 'PermissionDeniedError'
              ? 'Quyền truy cập Camera đã bị TỪ CHỐI. Hãy nhấn vào biểu tượng 🔒 hoặc cài đặt trang web trên thanh địa chỉ trình duyệt, chọn "Cho phép" Camera và tải lại trang.'
              : err3.name === 'NotFoundError' || err3.name === 'DevicesNotFoundError'
              ? 'Không tìm thấy thiết bị Camera nào được kết nối với máy tính/điện thoại.'
              : `Lỗi mở Camera: ${err3.message || err3.name}`
          );
          setIsRequestingCamera(false);
          return;
        }
      }
    }

    if (!mediaStream) {
      setCameraError('Không thể tạo luồng video camera.');
      setIsRequestingCamera(false);
      return;
    }

    setStream(mediaStream);

    if (videoRef.current) {
      const v = videoRef.current;
      v.srcObject = mediaStream;
      v.setAttribute('playsinline', 'true');
      v.setAttribute('webkit-playsinline', 'true');
      v.muted = true;

      try {
        await new Promise((resolve) => {
          v.onloadedmetadata = () => resolve(true);
        });
        await v.play();
      } catch (playErr) {
        console.warn('Video play error:', playErr);
      }
    }

    setIsRequestingCamera(false);
  }, [cameraFacing]);

  // Tự động gọi mở camera khi component được mount hoặc đổi camera
  useEffect(() => {
    startCamera();
    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [cameraFacing]);

  // Bật/tắt đèn Flash nếu hỗ trợ
  const toggleTorch = async () => {
    if (!stream) return;
    try {
      const track = stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities ? (track.getCapabilities() as any) : {};
      if (capabilities.torch) {
        const next = !torchOn;
        await (track as any).applyConstraints({ advanced: [{ torch: next }] });
        setTorchOn(next);
      } else {
        alert('Thiết bị này không hỗ trợ điều khiển đèn flash từ trình duyệt.');
      }
    } catch (e) {
      console.warn('Torch toggle error:', e);
    }
  };

  // 2. Chụp và xử lý 1 khung hình từ video
  // 2. Chụp và xử lý 1 khung hình từ video (ưu tiên vùng trong khung ngắm Viewfinder)
  const processCurrentFrame = async (): Promise<AuditFieldResult | null> => {
    if (!videoRef.current || !canvasRef.current || videoRef.current.readyState < 2) {
      return null;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (vw <= 0 || vh <= 0) return null;

    // Tính toán ROI từ khung ngắm Viewfinder trên giao diện
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (viewfinderRef.current) {
      const vRect = video.getBoundingClientRect();
      const fRect = viewfinderRef.current.getBoundingClientRect();
      if (vRect.width > 0 && vRect.height > 0) {
        const scaleX = vw / vRect.width;
        const scaleY = vh / vRect.height;
        sx = Math.max(0, Math.round((fRect.left - vRect.left) * scaleX));
        sy = Math.max(0, Math.round((fRect.top - vRect.top) * scaleY));
        sw = Math.min(vw - sx, Math.round(fRect.width * scaleX));
        sh = Math.min(vh - sy, Math.round(fRect.height * scaleY));
      }
    } else {
      // Mặc định tập trung 85% chiều ngang và 65% chiều cao ở giữa màn hình
      sw = Math.round(vw * 0.85);
      sh = Math.round(vh * 0.65);
      sx = Math.round((vw - sw) / 2);
      sy = Math.round((vh - sh) / 2);
    }

    if (sw <= 20 || sh <= 20) return null;

    // Giới hạn chiều rộng ROI tối đa 800px để xử lý nhanh và sắc nét
    const targetW = Math.min(sw, 800);
    const targetH = Math.round((sh * targetW) / sw);

    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    // Vẽ đúng vùng khung ngắm vào canvas xử lý
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);
    const imageData = ctx.getImageData(0, 0, targetW, targetH);

    // B1: Grayscale
    const gray = toGrayscale(imageData);

    // B2: Tự động nhận diện độ sáng viền để xử lý cả màn sáng chữ tối lẫn màn tối chữ sáng
    let borderSum = 0;
    let borderCount = 0;
    for (let x = 0; x < targetW; x += 8) {
      borderSum += gray[x] + gray[(targetH - 1) * targetW + x];
      borderCount += 2;
    }
    const isDarkBg = borderSum / Math.max(1, borderCount) < 110;

    // B2.1: Adaptive Threshold (blockSize=21, C=6) để giữ lại cả nét chữ mờ trên màn LCD
    let binary = adaptiveThreshold(gray, targetW, targetH, 21, 6);
    if (isDarkBg) {
      // Đảo ngược thành chữ đen (0) trên nền trắng (255)
      for (let i = 0; i < binary.length; i++) {
        binary[i] = binary[i] === 0 ? 255 : 0;
      }
    }

    // B3: Dedither noise
    const cleanBinary = removeDitherNoise(binary, targetW, targetH, 4);

    // B4: Tách dòng
    const scaleFactor = targetW / 800;
    const lineBoxes = extractLines(cleanBinary, targetW, targetH, scaleFactor);

    if (lineBoxes.length === 0) return null;

    // B5: Chạy ONNX Model cho từng dòng
    await loadOcrSession();
    const detectedLines: DetectedLine[] = [];

    for (let i = 0; i < lineBoxes.length; i++) {
      const line = await recognizeLine(cleanBinary, targetW, lineBoxes[i], i, scaleFactor);
      if (line.text.trim().length > 0) {
        detectedLines.push(line);
      }
    }

    // B6: Bóc tách mỏ neo
    if (step === 'audit') {
      const auditResult = extractAuditFields(detectedLines);
      return auditResult;
    } else if (step === 'date') {
      const dateResult = extractDateFromLines(detectedLines);
      if (dateResult.day) setRamDay(dateResult.day.toString());
      if (dateResult.year) setRamYear(dateResult.year.toString());
      return null;
    }

    return null;
  };

  // Đóng băng khung hình video hiện tại
  const freezeCurrentFrame = () => {
    if (videoRef.current && freezeCanvasRef.current) {
      const video = videoRef.current;
      const fCanvas = freezeCanvasRef.current;
      fCanvas.width = video.videoWidth;
      fCanvas.height = video.videoHeight;
      const fCtx = fCanvas.getContext('2d');
      if (fCtx) {
        fCtx.drawImage(video, 0, 0, fCanvas.width, fCanvas.height);
      }
    }
  };

  // 3. Vòng lặp Liveview Auto-detect
  useEffect(() => {
    let animationFrameId: number;
    let isRunning = true;
    let lastScanTime = 0;

    const loop = async (timestamp: number) => {
      // Quét mỗi ~300ms để không nóng máy
      if (
        isRunning &&
        stream &&
        (step === 'audit' || step === 'date') &&
        timestamp - lastScanTime > 300 &&
        !isProcessing
      ) {
        lastScanTime = timestamp;
        try {
          const result = await processCurrentFrame();
          if (result && step === 'audit') {
            setLiveResult(result);

            // Kiểm tra độ ổn định 2-3 frame liên tiếp
            const stability = stabilityTrackerRef.current.pushFrame(result);
            setStabilityMatches(stability.consecutiveMatches);

            if (stability.isStable && stability.bestResult) {
              // PHÁT HIỆN ỔN ĐỊNH: Tiếng bíp, rung, đóng băng hình, mở màn xác nhận!
              playSuccessBeep();
              triggerHaptic([100, 50, 150]);
              freezeCurrentFrame();

              const r = stability.bestResult;
              if (r.machineNo !== null) setConfirmedMachineNo(r.machineNo.toString());
              if (r.rtp1 !== null) setConfirmedRtp1(r.rtp1.toFixed(3));
              if (r.rtp2 !== null) setConfirmedRtp2(r.rtp2.toFixed(3));
              if (r.totalMeters !== null) setConfirmedTotalMeters(r.totalMeters.toString());
              if (r.periodicMeters !== null) setConfirmedPeriodicMeters(r.periodicMeters.toString());
              setIsAutoCorrectedRtp(r.autoCorrected);
              setAuditConfidence(r.confidence);

              // Chuyển sang màn hình xác nhận
              setStep('audit_review');
            }
          }
        } catch (e) {
          console.warn('Detection loop error:', e);
        }
      }

      if (isRunning) {
        animationFrameId = requestAnimationFrame(loop);
      }
    };

    animationFrameId = requestAnimationFrame(loop);

    return () => {
      isRunning = false;
      cancelAnimationFrame(animationFrameId);
    };
  }, [step, isProcessing, stream]);

  // Nút bấm "Chụp & Quét ngay" thủ công
  const handleManualCapture = async () => {
    setIsProcessing(true);
    try {
      freezeCurrentFrame();

      if (step === 'date') {
        await processCurrentFrame();
        playSuccessBeep();
        triggerHaptic(150);
        setStep('final_confirm');
        return;
      }

      const result = await processCurrentFrame();
      if (result) {
        if (result.confidence.anchorFound) {
          playSuccessBeep();
        } else {
          playWarningBeep();
        }
        triggerHaptic(150);

        if (result.machineNo !== null) setConfirmedMachineNo(result.machineNo.toString());
        if (result.rtp1 !== null) setConfirmedRtp1(result.rtp1.toFixed(3));
        if (result.rtp2 !== null) setConfirmedRtp2(result.rtp2.toFixed(3));
        if (result.totalMeters !== null) setConfirmedTotalMeters(result.totalMeters.toString());
        if (result.periodicMeters !== null) setConfirmedPeriodicMeters(result.periodicMeters.toString());
        setIsAutoCorrectedRtp(result.autoCorrected);
        setAuditConfidence(result.confidence);

        setStep('audit_review');
      } else {
        // Vẫn mở popup xác nhận để nhân viên có thể xác nhận hoặc chỉnh nhanh
        playWarningBeep();
        triggerHaptic(100);
        setStep('audit_review');
      }
    } catch (err: any) {
      console.error('Lỗi khi chụp:', err);
      alert('Lỗi xử lý hình ảnh: ' + (err?.message || err));
    } finally {
      setIsProcessing(false);
    }
  };

  // Nạp ảnh mẫu để thử nghiệm ngay mà không cần màn hình slot thật
  const handleSimulateSampleImage = (presetType: 'audit' | 'date') => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 700;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#000000';
    ctx.font = 'bold 36px Arial, sans-serif';

    if (presetType === 'audit') {
      ctx.fillText('58249012', 150, 150); // Total meters
      ctx.fillText('1420395', 150, 220); // Periodic meters
      ctx.fillText('92.734%', 150, 310); // RTP1
      ctx.fillText('93.63%', 150, 390); // RTP2
      ctx.fillText('12', 150, 470); // Machine No
      ctx.fillText('$0.01', 150, 550); // Dollar anchor
    } else {
      ctx.fillText('Mon 23 Mar 2026 07:50:05', 150, 280);
    }

    if (videoRef.current) {
      const testCanvas = canvasRef.current;
      if (testCanvas) {
        testCanvas.width = canvas.width;
        testCanvas.height = canvas.height;
        const tCtx = testCanvas.getContext('2d');
        tCtx?.drawImage(canvas, 0, 0);
      }
    }

    handleManualCapture();
  };

  // Hoàn tất và gửi dữ liệu lên Firebase
  const handleFinalSubmit = async () => {
    setIsSaving(true);
    try {
      const formattedDate = `${ramDay.padStart(2, '0')}/${ramMonth.toString().padStart(2, '0')}/${ramYear}`;

      const payload = {
        machine_no: parseInt(confirmedMachineNo, 10) || 0,
        rtp1: parseFloat(confirmedRtp1) || 0,
        rtp2: parseFloat(confirmedRtp2) || 0,
        total_meters: parseInt(confirmedTotalMeters, 10) || 0,
        periodic_meters: parseInt(confirmedPeriodicMeters, 10) || 0,
        ram_clear_date: formattedDate,
        confidence: auditConfidence,
        auto_corrected: isAutoCorrectedRtp,
        confirmed_at: Date.now(),
        confirmed_by: 'Staff Club',
      };

      await onSaveReading(payload);
      playSuccessBeep();
      triggerHaptic([100, 50, 200]);
      onAuditFinished();
    } catch (e: any) {
      alert('Lỗi lưu dữ liệu: ' + e.message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4 pb-24">
      {/* Error Banner if Camera is Blocked */}
      {cameraError && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-300 flex items-start gap-2.5">
          <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <span className="font-semibold">{cameraError}</span>
            <div className="pt-1 flex items-center gap-2">
              <button
                onClick={() => startCamera()}
                className="px-3 py-1 bg-red-600/80 hover:bg-red-500 text-white rounded-lg font-bold text-xs cursor-pointer"
              >
                Thử lại quyền Camera
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step Header Wizard */}
      <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
              step === 'audit' || step === 'audit_review'
                ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/30'
                : 'bg-emerald-950 text-emerald-400 border border-emerald-800'
            }`}
          >
            1
          </span>
          <div className="text-left">
            <h3 className="text-xs sm:text-sm font-bold text-slate-100">
              Bước 1: Màn Audit / RTP
            </h3>
            <p className="text-[11px] text-slate-400">RTP1, RTP2, Machine No & Meters</p>
          </div>
        </div>

        <ChevronRight className="w-4 h-4 text-slate-600" />

        <div className="flex items-center gap-2">
          <span
            className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
              step === 'date' || step === 'final_confirm'
                ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/30'
                : 'bg-slate-800 text-slate-400'
            }`}
          >
            2
          </span>
          <div className="text-left">
            <h3 className="text-xs sm:text-sm font-bold text-slate-100">Bước 2: Màn Ngày</h3>
            <p className="text-[11px] text-slate-400">RAM Clear Date (Ngày/Tháng/Năm)</p>
          </div>
        </div>
      </div>

      {/* Camera Liveview Viewport */}
      <div className="relative rounded-2xl overflow-hidden bg-black aspect-[3/4] sm:aspect-[4/3] max-h-[65vh] shadow-2xl border border-slate-800 flex items-center justify-center">
        {/* Hidden internal processing canvas */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Video feed */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="w-full h-full object-cover"
        />

        {/* Frozen preview canvas (hidden during liveview) */}
        <canvas
          ref={freezeCanvasRef}
          className={`absolute inset-0 w-full h-full object-cover transition-opacity ${
            step === 'audit_review' || step === 'final_confirm' ? 'opacity-100 z-10' : 'opacity-0 -z-10'
          }`}
        />

        {/* Permission Request Prompt Overlay if Camera is NOT yet running */}
        {!stream && (
          <div className="absolute inset-0 z-40 bg-slate-950/90 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30 shadow-lg shadow-emerald-500/20 animate-pulse">
              <Camera className="w-8 h-8" />
            </div>
            <div className="space-y-1.5 max-w-xs">
              <h4 className="text-base font-bold text-slate-100">Cần quyền truy cập Camera</h4>
              <p className="text-xs text-slate-400">
                Nhấn nút bên dưới để cấp quyền camera liveview quét màn hình máy slot.
              </p>
            </div>
            <button
              onClick={() => startCamera()}
              disabled={isRequestingCamera}
              className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold text-sm shadow-xl shadow-emerald-600/40 flex items-center gap-2 cursor-pointer active:scale-95 transition-all"
            >
              <Camera className="w-5 h-5" />
              <span>{isRequestingCamera ? 'Đang kích hoạt...' : 'Bật Camera & Cấp Quyền'}</span>
            </button>
            <div className="flex items-center gap-1 text-[11px] text-slate-500">
              <Lock className="w-3.5 h-3.5" />
              <span>Ảnh chỉ xử lý trực tiếp trên máy, không gửi lên mạng</span>
            </div>
          </div>
        )}

        {/* Viewfinder Reticle Overlay */}
        <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center p-6 z-20">
          {/* Guide Bounding Box */}
          <div
            ref={viewfinderRef}
            className="w-full max-w-sm h-64 border-2 border-emerald-400/80 rounded-2xl relative shadow-[0_0_0_9999px_rgba(0,0,0,0.5)] transition-all"
          >
            {/* 4 Corner Markers */}
            <div className="absolute -top-1 -left-1 w-6 h-6 border-t-4 border-l-4 border-emerald-400 rounded-tl-lg" />
            <div className="absolute -top-1 -right-1 w-6 h-6 border-t-4 border-r-4 border-emerald-400 rounded-tr-lg" />
            <div className="absolute -bottom-1 -left-1 w-6 h-6 border-b-4 border-l-4 border-emerald-400 rounded-bl-lg" />
            <div className="absolute -bottom-1 -right-1 w-6 h-6 border-b-4 border-r-4 border-emerald-400 rounded-br-lg" />

            {/* Target Label */}
            <div className="absolute -top-4 left-1/2 -translate-x-1/2 px-3 py-1 bg-emerald-600 text-white text-[11px] font-bold rounded-full uppercase tracking-wider shadow-md whitespace-nowrap">
              {step === 'audit' ? 'Đưa màn hình Audit vào đây' : 'Đưa dòng ngày Clear RAM vào đây'}
            </div>

            {/* Center Laser Line */}
            <div className="absolute left-4 right-4 top-1/2 -translate-y-1/2 h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent opacity-80 animate-pulse" />

            {/* Stability Progress Indicator */}
            {step === 'audit' && stabilityMatches > 0 && (
              <div className="absolute bottom-3 left-4 right-4 bg-slate-900/90 backdrop-blur-md rounded-xl p-2 border border-emerald-500/40 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-emerald-400 animate-spin" />
                  <span className="text-[11px] text-emerald-300 font-semibold">
                    Đang khóa mục tiêu ({stabilityMatches}/2 frame)
                  </span>
                </div>
                <div className="flex gap-1">
                  <span
                    className={`w-3 h-3 rounded-full ${
                      stabilityMatches >= 1 ? 'bg-emerald-400' : 'bg-slate-700'
                    }`}
                  />
                  <span
                    className={`w-3 h-3 rounded-full ${
                      stabilityMatches >= 2 ? 'bg-emerald-400' : 'bg-slate-700'
                    }`}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Realtime Detection HUD (Phần hiển thị kết quả trực tiếp) */}
        {step === 'audit' && liveResult && (
          <div className="absolute top-3 left-3 right-3 z-30 flex flex-wrap gap-1.5 pointer-events-none">
            {liveResult.machineNo !== null && (
              <span className="bg-slate-900/95 backdrop-blur text-emerald-400 font-mono font-bold text-xs px-2.5 py-1 rounded-lg border border-emerald-500/40 shadow-lg">
                Machine #{liveResult.machineNo}
              </span>
            )}
            {liveResult.rtp1 !== null && (
              <span className="bg-slate-900/95 backdrop-blur text-slate-200 font-mono font-bold text-xs px-2.5 py-1 rounded-lg border border-slate-700 shadow-lg">
                RTP1: {liveResult.rtp1.toFixed(3)}%
              </span>
            )}
            {liveResult.rtp2 !== null && (
              <span className="bg-slate-900/95 backdrop-blur text-slate-200 font-mono font-bold text-xs px-2.5 py-1 rounded-lg border border-slate-700 shadow-lg">
                RTP2: {liveResult.rtp2.toFixed(3)}%
              </span>
            )}
            {liveResult.confidence.anchorFound ? (
              <span className="bg-emerald-500/20 text-emerald-300 font-semibold text-[10px] px-2 py-1 rounded-lg border border-emerald-500/40 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                <span>Anchor $ OK</span>
              </span>
            ) : (
              <span className="bg-amber-500/20 text-amber-300 font-semibold text-[10px] px-2 py-1 rounded-lg border border-amber-500/40 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                <span>Thiếu Anchor $</span>
              </span>
            )}
          </div>
        )}

        {/* Camera Quick Controls */}
        <div className="absolute bottom-4 left-4 right-4 z-30 flex items-center justify-between pointer-events-auto">
          {/* Torch toggle */}
          <button
            onClick={toggleTorch}
            className="p-3 rounded-full bg-slate-900/80 backdrop-blur text-white hover:bg-slate-800 border border-slate-700/80 shadow-lg active:scale-95 transition-all cursor-pointer"
            title="Bật/tắt đèn Flash"
          >
            {torchOn ? <Zap className="w-5 h-5 text-amber-400" /> : <ZapOff className="w-5 h-5" />}
          </button>

          {/* Main Manual Snap Button */}
          <button
            onClick={handleManualCapture}
            disabled={isProcessing}
            className="px-6 py-3 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-xl shadow-emerald-600/40 flex items-center gap-2 active:scale-95 transition-all border border-emerald-400/40 cursor-pointer"
          >
            <Camera className="w-5 h-5" />
            <span>{isProcessing ? 'Đang đọc...' : 'Chụp & Quét ngay'}</span>
          </button>

          {/* Camera Switcher */}
          <button
            onClick={() => setCameraFacing(cameraFacing === 'environment' ? 'user' : 'environment')}
            className="p-3 rounded-full bg-slate-900/80 backdrop-blur text-white hover:bg-slate-800 border border-slate-700/80 shadow-lg active:scale-95 transition-all cursor-pointer"
            title="Đổi camera trước/sau"
          >
            <RotateCcw className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Demo helper buttons (nếu camera không có sẵn trên PC) */}
      <div className="bg-slate-900/80 border border-slate-800 p-2.5 rounded-xl flex items-center justify-between text-xs">
        <span className="text-slate-400">Kiểm thử nhanh không cần máy thật:</span>
        <div className="flex gap-2">
          <button
            onClick={() => handleSimulateSampleImage('audit')}
            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-emerald-400 rounded-lg font-semibold border border-slate-700 cursor-pointer"
          >
            Thử mẫu Audit
          </button>
          <button
            onClick={() => handleSimulateSampleImage('date')}
            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-teal-400 rounded-lg font-semibold border border-slate-700 cursor-pointer"
          >
            Thử mẫu Ngày
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* MODAL XÁC NHẬN BƯỚC 1: MÀN HÌNH AUDIT (MACHINE NO HIỆN NỔI BẬT ĐẦU TIÊN)  */}
      {/* ========================================================================= */}
      {step === 'audit_review' && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-3 sm:p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg p-5 shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
                <h3 className="font-bold text-slate-100 text-base">
                  Xác nhận dữ liệu màn Audit
                </h3>
              </div>
              <button
                onClick={() => setStep('audit')}
                className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded bg-slate-800 cursor-pointer"
              >
                Quét lại
              </button>
            </div>

            {/* Cảnh báo nếu tự sửa hoặc thiếu anchor */}
            {isAutoCorrectedRtp && (
              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-start gap-2 text-xs text-amber-300">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <span>
                  <b>Tự động sửa dấu chấm:</b> Hệ thống đã tự chèn dấu thập phân cho RTP sau 2
                  chữ số đầu theo luật fallback. Vui lòng kiểm tra lại.
                </span>
              </div>
            )}

            {!auditConfidence.anchorFound && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl flex items-start gap-2 text-xs text-red-300">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>
                  <b>Không tìm thấy anchor $:</b> Vui lòng kiểm tra kỹ số máy và RTP trước khi
                  tiếp tục.
                </span>
              </div>
            )}

            {/* 1. MACHINE NUMBER NỔI BẬT TO TRÊN CÙNG (Yêu cầu Spec) */}
            <div className="bg-slate-950 p-4 rounded-xl border-2 border-emerald-500/50 shadow-inner">
              <label className="block text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-1">
                Machine Number (Số máy slot)
              </label>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-black text-slate-500 font-mono">#</span>
                <input
                  type="number"
                  min="0"
                  max="900"
                  value={confirmedMachineNo}
                  onChange={(e) => setConfirmedMachineNo(e.target.value)}
                  className="w-full bg-transparent text-3xl font-black text-emerald-400 font-mono focus:outline-none tracking-wider"
                  placeholder="0 - 900"
                />
              </div>
              <p className="text-[11px] text-slate-500 mt-1">Dải hợp lệ: 0 – 900</p>
            </div>

            {/* 2. RTP 1 & RTP 2 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  RTP 1 (%)
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    step="0.001"
                    min="80"
                    max="99.999"
                    value={confirmedRtp1}
                    onChange={(e) => setConfirmedRtp1(e.target.value)}
                    className="w-full bg-transparent text-xl font-bold text-slate-100 font-mono focus:outline-none"
                    placeholder="92.734"
                  />
                  <span className="text-slate-500 font-bold">%</span>
                </div>
                <span className="text-[10px] text-slate-500">Chuẩn: 80 - 99%</span>
              </div>

              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  RTP 2 (%)
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    step="0.001"
                    min="80"
                    max="99.999"
                    value={confirmedRtp2}
                    onChange={(e) => setConfirmedRtp2(e.target.value)}
                    className="w-full bg-transparent text-xl font-bold text-slate-100 font-mono focus:outline-none"
                    placeholder="93.630"
                  />
                  <span className="text-slate-500 font-bold">%</span>
                </div>
                <span className="text-[10px] text-slate-500">Chuẩn: 80 - 99%</span>
              </div>
            </div>

            {/* 3. Total & Periodic Meters */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  Total Meters
                </label>
                <input
                  type="number"
                  value={confirmedTotalMeters}
                  onChange={(e) => setConfirmedTotalMeters(e.target.value)}
                  className="w-full bg-transparent text-base font-bold text-slate-200 font-mono focus:outline-none"
                  placeholder="Số nguyên"
                />
              </div>

              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  Periodic Meters
                </label>
                <input
                  type="number"
                  value={confirmedPeriodicMeters}
                  onChange={(e) => setConfirmedPeriodicMeters(e.target.value)}
                  className="w-full bg-transparent text-base font-bold text-slate-200 font-mono focus:outline-none"
                  placeholder="Số nguyên"
                />
              </div>
            </div>

            {/* Action button */}
            <button
              onClick={() => setStep('date')}
              className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/30 transition-all cursor-pointer"
            >
              <span>Xác nhận & Sang Bước 2 (Màn Ngày)</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* BƯỚC 2: MÀN HÌNH NGÀY (RAM CLEAR DATE)                                     */}
      {/* ========================================================================= */}
      {step === 'date' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Calendar className="w-5 h-5 text-teal-400" />
              <div>
                <h3 className="font-bold text-slate-100 text-sm sm:text-base">
                  Bước 2: Ngày Clear RAM
                </h3>
                <p className="text-[11px] text-slate-400">
                  Ngày và Năm tự đọc bằng model AI; Tháng chọn từ danh sách
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2.5">
            {/* Ngày (tự đọc) */}
            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Ngày (Day)
              </label>
              <input
                type="number"
                min="1"
                max="31"
                value={ramDay}
                onChange={(e) => setRamDay(e.target.value)}
                className="w-full bg-transparent text-2xl font-black text-slate-100 font-mono focus:outline-none"
                placeholder="23"
              />
              <span className="text-[10px] text-emerald-400 font-medium">Tự đọc từ ảnh</span>
            </div>

            {/* Tháng (Dropdown chọn tay - Giai đoạn 1) */}
            <div className="bg-slate-950 p-3 rounded-xl border-2 border-teal-500/60">
              <label className="block text-[11px] font-semibold text-teal-400 mb-1">
                Tháng (GĐ 1: Chọn tay)
              </label>
              <select
                value={ramMonth}
                onChange={(e) => setRamMonth(parseInt(e.target.value, 10))}
                className="w-full bg-slate-950 text-slate-100 text-sm font-bold focus:outline-none py-1.5 cursor-pointer"
              >
                {MONTH_NAMES.map((name, idx) => (
                  <option key={idx + 1} value={idx + 1}>
                    {name}
                  </option>
                ))}
              </select>
              <span className="text-[10px] text-teal-400 font-medium">Chọn tháng</span>
            </div>

            {/* Năm (tự đọc) */}
            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Năm (Year)
              </label>
              <input
                type="number"
                min="2020"
                max="2035"
                value={ramYear}
                onChange={(e) => setRamYear(e.target.value)}
                className="w-full bg-transparent text-2xl font-black text-slate-100 font-mono focus:outline-none"
                placeholder="2026"
              />
              <span className="text-[10px] text-emerald-400 font-medium">Tự đọc từ ảnh</span>
            </div>
          </div>

          {/* Tóm tắt toàn bộ số liệu cuối cùng trước khi ghi */}
          <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-xs space-y-1.5 font-mono">
            <div className="flex justify-between text-slate-400 font-sans">
              <span>Máy Audit:</span>
              <b className="text-emerald-400 font-mono text-sm">#{confirmedMachineNo}</b>
            </div>
            <div className="flex justify-between text-slate-400 font-sans">
              <span>RTP 1 & 2:</span>
              <span className="text-slate-200">
                {confirmedRtp1}% / {confirmedRtp2}%
              </span>
            </div>
            <div className="flex justify-between text-slate-400 font-sans">
              <span>Ngày Clear RAM đã chọn:</span>
              <b className="text-teal-400">
                {ramDay.padStart(2, '0')}/{ramMonth.toString().padStart(2, '0')}/{ramYear}
              </b>
            </div>
          </div>

          {/* Nút gửi dữ liệu lên Firebase */}
          <button
            onClick={handleFinalSubmit}
            disabled={isSaving}
            className="w-full py-3.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl font-bold text-sm shadow-xl shadow-emerald-600/30 flex items-center justify-center gap-2 active:scale-98 transition-all cursor-pointer"
          >
            <CheckCircle2 className="w-5 h-5" />
            <span>{isSaving ? 'Đang gửi số liệu...' : 'Xác Nhận & Lưu Lên Firebase'}</span>
          </button>
        </div>
      )}
    </div>
  );
};
