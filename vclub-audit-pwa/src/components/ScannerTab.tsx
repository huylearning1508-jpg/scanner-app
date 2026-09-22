import React, { useRef, useState, useEffect, useCallback } from 'react';
import type {
  AuditFieldResult,
  ConfidenceScores,
  DetectedLine,
  MachineRecord,
} from '../types';
import {
  Camera,
  Zap,
  ZapOff,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  Lock,
} from 'lucide-react';
import {
  adaptiveThreshold,
  extractLines,
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

const MONTH_OPTIONS = [
  { value: 1, label: 'Jan' },
  { value: 2, label: 'Feb' },
  { value: 3, label: 'Mar' },
  { value: 4, label: 'Apr' },
  { value: 5, label: 'May' },
  { value: 6, label: 'Jun' },
  { value: 7, label: 'Jul' },
  { value: 8, label: 'Aug' },
  { value: 9, label: 'Sep' },
  { value: 10, label: 'Oct' },
  { value: 11, label: 'Nov' },
  { value: 12, label: 'Dec' },
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
  const [isNearestFocus, setIsNearestFocus] = useState(false);
  const [focusStatusMessage, setFocusStatusMessage] = useState<string | null>(null);
  const isNearestFocusRef = useRef(false);
  isNearestFocusRef.current = isNearestFocus;

  // Trạng thái khóa khung hình (Freeze Frame)
  const [isFrozen, setIsFrozen] = useState(false);

  // Trạng thái nhận diện thời gian thực (Live HUD)
  const [liveResult, setLiveResult] = useState<AuditFieldResult | null>(null);
  const [stabilityMatches, setStabilityMatches] = useState(0);
  const stabilityTrackerRef = useRef(new StabilityTracker(2, 0.65));

  // Dữ liệu form tự điền (Khớp giao diện yêu cầu của người dùng)
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

  // Dữ liệu Ngày Clear RAM: Ngày - Tháng (dropdown) - Năm
  const [ramDay, setRamDay] = useState<string>('23');
  const [ramMonth, setRamMonth] = useState<number>(1); // Mặc định Jan theo mockup
  const [ramYear, setRamYear] = useState<string>('2026');
  const [isSaving, setIsSaving] = useState(false);

  // Khóa nét gần nhất (Macro) hoặc bật lại Auto Focus trên luồng camera
  const applyFocusConstraint = async (mediaStream: MediaStream, lockNearest: boolean): Promise<boolean> => {
    try {
      const track = mediaStream.getVideoTracks()[0];
      if (!track) return false;
      const capabilities = track.getCapabilities ? (track.getCapabilities() as any) : {};

      const supportsMode = Array.isArray(capabilities.focusMode);
      const hasManual = supportsMode && capabilities.focusMode.includes('manual');
      const hasContinuous = supportsMode && capabilities.focusMode.includes('continuous');
      const hasDistance = Boolean(capabilities.focusDistance);

      if (!hasManual && !hasDistance) {
        return false;
      }

      if (lockNearest) {
        const advancedObj: any = {};
        if (hasManual) {
          advancedObj.focusMode = 'manual';
        }
        if (hasDistance) {
          // Lấy nét ở cự ly GẦN NHẤT (Macro): dùng min focus distance
          advancedObj.focusDistance = capabilities.focusDistance.min ?? 0.05;
        }
        await (track as any).applyConstraints({ advanced: [advancedObj] });
        return true;
      } else {
        const advancedObj: any = {};
        if (hasContinuous) {
          advancedObj.focusMode = 'continuous';
        }
        await (track as any).applyConstraints({ advanced: [advancedObj] });
        return true;
      }
    } catch (err) {
      console.warn('Lỗi áp dụng focus constraint:', err);
      return false;
    }
  };

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

    if (isNearestFocusRef.current) {
      applyFocusConstraint(mediaStream, true);
    }

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

  // Xử lý bật/tắt checkbox Khóa Nét Gần Nhất (Macro)
  const handleToggleNearestFocus = async (enabled: boolean) => {
    setIsNearestFocus(enabled);
    if (!stream) {
      setFocusStatusMessage(enabled ? 'Đã bật khóa nét gần (chờ camera)' : 'Đã tắt khóa nét');
      setTimeout(() => setFocusStatusMessage(null), 2500);
      return;
    }

    const track = stream.getVideoTracks()[0];
    const capabilities = track?.getCapabilities ? (track.getCapabilities() as any) : {};
    const supportsFocus = Boolean(capabilities.focusMode?.includes?.('manual') || capabilities.focusDistance);

    if (!supportsFocus) {
      setFocusStatusMessage('Thiết bị/trình duyệt này không hỗ trợ Web Focus API');
      setTimeout(() => setFocusStatusMessage(null), 3500);
      return;
    }

    const success = await applyFocusConstraint(stream, enabled);
    if (success) {
      setFocusStatusMessage(enabled ? 'Đã khóa nét gần nhất (Macro)' : 'Đã chuyển về Auto Focus');
    } else {
      setFocusStatusMessage('Không thể áp dụng khóa nét trên thiết bị này');
    }
    setTimeout(() => setFocusStatusMessage(null), 3000);
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

    // Giới hạn chiều rộng ROI tối đa 450px (thay vì 800px) để xử lý siêu tốc <5ms
    const targetW = Math.min(sw, 450);
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

    // B2.1: Adaptive Threshold (blockSize=21, C=6) để giữ lại nét chữ rõ ràng
    const binary = adaptiveThreshold(gray, targetW, targetH, 21, 6);
    if (isDarkBg) {
      // Đảo ngược thành chữ đen (0) trên nền trắng (255)
      for (let i = 0; i < targetW * targetH; i++) {
        binary[i] = binary[i] === 0 ? 255 : 0;
      }
    }

    // B3: Tách dòng trực tiếp từ binary (Bỏ lọc dither & dedither để đạt tốc độ tối đa ~0.05s)
    const scaleFactor = targetW / 800;
    const lineBoxes = extractLines(binary, targetW, targetH, scaleFactor);

    if (lineBoxes.length === 0) return null;

    // B4: Chạy ONNX Model cho từng dòng
    await loadOcrSession();
    const detectedLines: DetectedLine[] = [];

    for (let i = 0; i < lineBoxes.length; i++) {
      const line = await recognizeLine(binary, targetW, lineBoxes[i], i, scaleFactor, gray);
      if (line.text.trim().length > 0) {
        detectedLines.push(line);
      }
    }

    // B5: Bóc tách mỏ neo & ngày
    const auditResult = extractAuditFields(detectedLines);
    const dateResult = extractDateFromLines(detectedLines);
    if (dateResult.day) setRamDay(dateResult.day.toString());
    if (dateResult.month) setRamMonth(dateResult.month);
    if (dateResult.year) setRamYear(dateResult.year.toString());
    return auditResult;
  };

  // Đóng băng khung hình video hiện tại
  const freezeCurrentFrame = () => {
    if (videoRef.current && freezeCanvasRef.current) {
      const video = videoRef.current;
      const fCanvas = freezeCanvasRef.current;
      fCanvas.width = video.videoWidth || 1280;
      fCanvas.height = video.videoHeight || 720;
      const fCtx = fCanvas.getContext('2d');
      if (fCtx) {
        fCtx.drawImage(video, 0, 0, fCanvas.width, fCanvas.height);
      }
    }
  };

  // Cờ bận xử lý frame theo chuẩn CameraX (Busy-Flag)
  const isBusyRef = useRef(false);

  // 3. Vòng lặp Liveview Auto-detect: Tự động nhận diện, tự điền & tự khóa khung hình
  useEffect(() => {
    let animationFrameId: number;
    let isRunning = true;

    const loop = async () => {
      // Busy-flag loop (tương tự CameraX STRATEGY_KEEP_ONLY_LATEST):
      // Khi không bận và chưa bị khóa khung hình, lập tức lấy frame mới nhất từ video stream
      if (
        isRunning &&
        stream &&
        !isFrozen &&
        !isBusyRef.current
      ) {
        isBusyRef.current = true;
        try {
          const result = await processCurrentFrame();
          if (result) {
            setLiveResult(result);

            // Kiểm tra độ ổn định 2 frame liên tiếp
            const stability = stabilityTrackerRef.current.pushFrame(result);
            setStabilityMatches(stability.consecutiveMatches);

            // Tự động khóa khung hình và tự điền khi nhận diện thành công
            if (stability.isStable && stability.bestResult) {
              const r = stability.bestResult;
              if (r.machineNo !== null || r.rtp1 !== null) {
                freezeCurrentFrame();
                setIsFrozen(true);
                playSuccessBeep();
                triggerHaptic([100, 50, 150]);

                if (r.machineNo !== null) setConfirmedMachineNo(r.machineNo.toString());
                if (r.rtp1 !== null) setConfirmedRtp1(r.rtp1.toFixed(3));
                if (r.rtp2 !== null) setConfirmedRtp2(r.rtp2.toFixed(3));
                if (r.totalMeters !== null) setConfirmedTotalMeters(r.totalMeters.toString());
                if (r.periodicMeters !== null) setConfirmedPeriodicMeters(r.periodicMeters.toString());
                setIsAutoCorrectedRtp(r.autoCorrected);
                setAuditConfidence(r.confidence);
              }
            }
          }
        } catch (e) {
          console.warn('Detection loop error:', e);
        } finally {
          isBusyRef.current = false;
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
  }, [isFrozen, isProcessing, stream]);

  // Nút bấm "Chụp & Quét ngay" thủ công: Tự động khóa hình và tự điền
  const handleManualCapture = async () => {
    setIsProcessing(true);
    try {
      freezeCurrentFrame();
      setIsFrozen(true);

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
      } else {
        playWarningBeep();
        triggerHaptic(100);
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
    if (presetType === 'audit') {
      setConfirmedMachineNo('12');
      setConfirmedRtp1('92.734');
      setConfirmedRtp2('93.630');
      setConfirmedTotalMeters('58249012');
      setConfirmedPeriodicMeters('1420395');
      setRamDay('23');
      setRamMonth(3);
      setRamYear('2026');
      setIsFrozen(true);
      playSuccessBeep();
      triggerHaptic([100, 50, 150]);
    } else {
      setRamDay('15');
      setRamMonth(8);
      setRamYear('2026');
      setIsFrozen(true);
      playSuccessBeep();
      triggerHaptic(100);
    }
  };

  // Hoàn tất và gửi dữ liệu lên Firebase
  const handleFinalSubmit = async () => {
    if (!confirmedMachineNo) {
      alert('Vui lòng nhập Machine No (Số máy)!');
      return;
    }
    setIsSaving(true);
    try {
      const formattedDate = `${(ramDay || '01').padStart(2, '0')}/${ramMonth.toString().padStart(2, '0')}/${ramYear || '2026'}`;

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
      // Reset form sau khi lưu thành công
      setConfirmedMachineNo('');
      setConfirmedRtp1('');
      setConfirmedRtp2('');
      setConfirmedTotalMeters('');
      setConfirmedPeriodicMeters('');
      setIsFrozen(false);
      stabilityTrackerRef.current.reset();
      setStabilityMatches(0);
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

      {/* Camera Liveview Viewport */}
      <div className="relative rounded-2xl overflow-hidden bg-black aspect-[3/4] sm:aspect-[4/3] max-h-[60vh] shadow-2xl border border-zinc-800 flex items-center justify-center">
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

        {/* Frozen preview canvas (hiển thị khi tự khóa khung hình) */}
        <canvas
          ref={freezeCanvasRef}
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-200 ${
            isFrozen ? 'opacity-100 z-10' : 'opacity-0 pointer-events-none -z-10'
          }`}
        />

        {/* Overlay trạng thái Đã khóa khung hình */}
        {isFrozen && (
          <div className="absolute top-3 left-3 z-30 flex items-center gap-2 animate-in fade-in duration-200">
            <span className="bg-emerald-600/95 text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-lg flex items-center gap-1.5 backdrop-blur-sm">
              <CheckCircle2 className="w-4 h-4" />
              <span>Đã khóa khung hình</span>
            </span>
            <button
              onClick={() => {
                setIsFrozen(false);
                stabilityTrackerRef.current.reset();
                setStabilityMatches(0);
              }}
              className="bg-zinc-900/90 hover:bg-zinc-800 text-zinc-200 text-xs font-semibold px-3 py-1.5 rounded-full border border-zinc-700 shadow-lg cursor-pointer active:scale-95 flex items-center gap-1 transition-all"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Mở lại camera</span>
            </button>
          </div>
        )}

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
              Đưa màn hình Audit vào đây
            </div>

            {/* Center Laser Line */}
            <div className="absolute left-4 right-4 top-1/2 -translate-y-1/2 h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent opacity-80 animate-pulse" />

            {/* Stability Progress Indicator */}
            {!isFrozen && stabilityMatches > 0 && (
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
        {!isFrozen && liveResult && (
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

        {/* Khóa nét Gần Nhất (Macro) Checkbox Option */}
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-1.5 pointer-events-auto">
          {focusStatusMessage && (
            <div className="px-3 py-1 bg-slate-900/95 text-amber-300 text-[11px] font-semibold rounded-full border border-amber-500/40 shadow-lg animate-in fade-in duration-200 whitespace-nowrap">
              {focusStatusMessage}
            </div>
          )}
          <label className="flex items-center gap-2 px-3.5 py-1.5 bg-slate-900/85 backdrop-blur-md rounded-full border border-slate-700/80 text-xs text-slate-200 cursor-pointer shadow-lg hover:bg-slate-800/90 transition-all select-none active:scale-95">
            <input
              type="checkbox"
              checked={isNearestFocus}
              onChange={(e) => handleToggleNearestFocus(e.target.checked)}
              className="w-4 h-4 rounded text-emerald-500 bg-slate-800 border-slate-600 focus:ring-emerald-500 focus:ring-offset-slate-900 cursor-pointer accent-emerald-500"
            />
            <span className="font-semibold text-slate-100 flex items-center gap-1">
              Khóa nét gần nhất <span className="text-emerald-400 font-bold">(Macro)</span>
            </span>
          </label>
        </div>

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

      {/* ========================================================================= */}
      {/* GIAO DIỆN TỰ ĐIỀN KHỚP 100% ẢNH MẪU YÊU CẦU (media_1789811049299.jpg)     */}
      {/* ========================================================================= */}
      <div className="bg-[#121214] border border-zinc-800/90 rounded-2xl p-4 sm:p-5 space-y-4 shadow-2xl">
        {/* Row 1: Machine No */}
        <div>
          <label className="block text-xs sm:text-[13px] font-medium text-zinc-400 mb-1.5">
            Machine No
          </label>
          <input
            type="number"
            min="0"
            max="999"
            value={confirmedMachineNo}
            onChange={(e) => setConfirmedMachineNo(e.target.value)}
            placeholder="Machine No"
            className="w-full bg-[#202024] border border-zinc-700/60 rounded-2xl px-4 py-3.5 text-base text-zinc-100 placeholder:text-zinc-500 font-semibold focus:outline-none focus:border-emerald-500 transition-colors shadow-inner"
          />
        </div>

        {/* Row 2: RTP1 (%) & RTP2 (%) */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs sm:text-[13px] font-medium text-zinc-400 mb-1.5">
              RTP1 (%)
            </label>
            <input
              type="number"
              step="0.001"
              value={confirmedRtp1}
              onChange={(e) => setConfirmedRtp1(e.target.value)}
              placeholder="RTP1 (%)"
              className="w-full bg-[#202024] border border-zinc-700/60 rounded-2xl px-4 py-3.5 text-base text-zinc-100 placeholder:text-zinc-500 font-semibold focus:outline-none focus:border-emerald-500 transition-colors shadow-inner"
            />
          </div>
          <div>
            <label className="block text-xs sm:text-[13px] font-medium text-zinc-400 mb-1.5">
              RTP2 (%)
            </label>
            <input
              type="number"
              step="0.001"
              value={confirmedRtp2}
              onChange={(e) => setConfirmedRtp2(e.target.value)}
              placeholder="RTP2 (%)"
              className="w-full bg-[#202024] border border-zinc-700/60 rounded-2xl px-4 py-3.5 text-base text-zinc-100 placeholder:text-zinc-500 font-semibold focus:outline-none focus:border-emerald-500 transition-colors shadow-inner"
            />
          </div>
        </div>

        {/* Row 3: Ngày Clear RAM */}
        <div>
          <label className="block text-xs sm:text-[13px] font-medium text-zinc-400 mb-1.5">
            Ngày Clear RAM
          </label>
          <div className="grid grid-cols-3 gap-2.5">
            {/* Ngày */}
            <input
              type="number"
              min="1"
              max="31"
              value={ramDay}
              onChange={(e) => setRamDay(e.target.value)}
              placeholder="Ngày"
              className="w-full bg-[#202024] border border-zinc-700/60 rounded-2xl px-4 py-3.5 text-base text-zinc-100 placeholder:text-zinc-500 font-semibold focus:outline-none focus:border-emerald-500 transition-colors shadow-inner text-center"
            />

            {/* Tháng Dropdown */}
            <div className="relative">
              <select
                value={ramMonth}
                onChange={(e) => setRamMonth(Number(e.target.value))}
                className="w-full appearance-none bg-[#202024] border border-zinc-700/60 rounded-2xl px-4 py-3.5 text-base text-zinc-100 font-semibold focus:outline-none focus:border-emerald-500 transition-colors shadow-inner pr-8 cursor-pointer text-center"
              >
                {MONTH_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value} className="bg-[#202024] text-zinc-100">
                    {m.label}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-zinc-400">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>

            {/* Năm */}
            <input
              type="number"
              min="2020"
              max="2035"
              value={ramYear}
              onChange={(e) => setRamYear(e.target.value)}
              placeholder="Năm"
              className="w-full bg-[#202024] border border-zinc-700/60 rounded-2xl px-4 py-3.5 text-base text-zinc-100 placeholder:text-zinc-500 font-semibold focus:outline-none focus:border-emerald-500 transition-colors shadow-inner text-center"
            />
          </div>
        </div>

        {/* Cảnh báo nhẹ nếu tự sửa RTP hoặc thiếu anchor */}
        {isAutoCorrectedRtp && (
          <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-start gap-2 text-xs text-amber-300">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <span>Tự động bù dấu chấm RTP: Vui lòng kiểm tra lại trước khi lưu.</span>
          </div>
        )}

        {/* Nút hành động */}
        <div className="pt-2 flex flex-col sm:flex-row gap-2.5">
          <button
            onClick={handleFinalSubmit}
            disabled={isSaving || !confirmedMachineNo}
            className={`flex-1 py-3.5 rounded-2xl font-bold text-sm sm:text-base flex items-center justify-center gap-2 shadow-lg transition-all cursor-pointer active:scale-98 ${
              confirmedMachineNo
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/30'
                : 'bg-zinc-800 text-zinc-500 cursor-not-allowed border border-zinc-700'
            }`}
          >
            <CheckCircle2 className="w-5 h-5" />
            <span>{isSaving ? 'Đang lưu...' : 'Lưu Dữ Liệu'}</span>
          </button>

          {isFrozen && (
            <button
              onClick={() => {
                setIsFrozen(false);
                stabilityTrackerRef.current.reset();
                setStabilityMatches(0);
              }}
              className="py-3.5 px-5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-2xl font-semibold text-sm border border-zinc-700 flex items-center justify-center gap-2 cursor-pointer transition-all active:scale-98"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Quét lại</span>
            </button>
          )}
        </div>
      </div>

      {/* Demo helper buttons (nếu camera không có sẵn trên PC) */}
      <div className="bg-zinc-900/80 border border-zinc-800 p-2.5 rounded-xl flex items-center justify-between text-xs">
        <span className="text-zinc-400">Kiểm thử nhanh không cần máy thật:</span>
        <div className="flex gap-2">
          <button
            onClick={() => handleSimulateSampleImage('audit')}
            className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-emerald-400 rounded-lg font-semibold border border-zinc-700 cursor-pointer"
          >
            Thử mẫu Audit
          </button>
          <button
            onClick={() => handleSimulateSampleImage('date')}
            className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-teal-400 rounded-lg font-semibold border border-zinc-700 cursor-pointer"
          >
            Thử mẫu Ngày
          </button>
        </div>
      </div>
    </div>
  );
};
