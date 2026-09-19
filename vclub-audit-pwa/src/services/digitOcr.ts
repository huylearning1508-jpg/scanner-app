/**
 * ONNX Runtime Web OCR Service
 * Nạp mô hình digit_model_64x64.onnx (13 lớp: 0-9, %, $, .)
 * và thực hiện batch inference tốc độ cao.
 */

import * as ort from 'onnxruntime-web';
import type { CharBox, DetectedLine } from '../types';
import { extractCharactersFromLine } from './imageProcessing';
import type { Rect } from './imageProcessing';

// Danh sách 13 nhãn chuẩn theo đúng file labels.json
export const OCR_LABELS = [
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '%',
  '$',
  '.',
];

let session: ort.InferenceSession | null = null;
let isLoading = false;
let loadPromise: Promise<ort.InferenceSession> | null = null;

// Cấu hình WASM single-threaded (numThreads=1) để tương thích 100% trên thiết bị di động
// không yêu cầu SharedArrayBuffer hay Cross-Origin Isolation
try {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.wasmPaths = '/wasm/';
} catch (e) {
  console.warn('Configuring ONNX WASM path warning:', e);
}

/**
 * Nạp mô hình ONNX Runtime Web
 */
export async function loadOcrSession(): Promise<ort.InferenceSession> {
  if (session) return session;
  if (loadPromise) return loadPromise;

  isLoading = true;
  loadPromise = (async () => {
    try {
      console.log('Loading ONNX model from /models/digit_model_64x64.onnx (local wasm)...');
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;
      ort.env.wasm.wasmPaths = '/wasm/';

      const sess = await ort.InferenceSession.create('/models/digit_model_64x64.onnx', {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      session = sess;
      console.log('ONNX Model digit_model_64x64.onnx loaded successfully!');
      return sess;
    } catch (localErr) {
      console.warn('Local WASM load failed, retrying with CDN fallback...', localErr);
      try {
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.simd = true;
        ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
        const sess = await ort.InferenceSession.create('/models/digit_model_64x64.onnx', {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });
        session = sess;
        console.log('ONNX Model loaded via CDN fallback!');
        return sess;
      } catch (cdnErr) {
        console.error('All ONNX loading attempts failed:', cdnErr);
        loadPromise = null;
        throw cdnErr;
      }
    } finally {
      isLoading = false;
    }
  })();

  return loadPromise;
}

export function isModelReady(): boolean {
  return session !== null;
}

export function isModelLoading(): boolean {
  return isLoading;
}

/**
 * Tính Softmax trên mảng logits để lấy xác suất [0..1]
 */
function softmax(logits: Float32Array | number[]): number[] {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > max) max = logits[i];
  }
  let sum = 0;
  const exps = new Float64Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    exps[i] = Math.exp(logits[i] - max);
    sum += exps[i];
  }
  const probs: number[] = new Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    probs[i] = exps[i] / (sum || 1);
  }
  return probs;
}

export interface CharPrediction {
  char: string;
  confidence: number;
  classId: number;
  candidates: { char: string; confidence: number }[];
}

/**
 * Batch inference cho danh sách các tensor ký tự 64x64
 */
export async function predictBatch(
  charTensors: Float32Array[]
): Promise<CharPrediction[]> {
  const sess = await loadOcrSession();
  const N = charTensors.length;
  if (N === 0) return [];

  // Ghép N tensor 64x64 thành 1 tensor liên tục [N, 1, 64, 64]
  const batchData = new Float32Array(N * 64 * 64);
  for (let i = 0; i < N; i++) {
    batchData.set(charTensors[i], i * 64 * 64);
  }

  const inputTensor = new ort.Tensor('float32', batchData, [N, 1, 64, 64]);
  const feeds: Record<string, ort.Tensor> = {};
  feeds[sess.inputNames[0] || 'input'] = inputTensor;

  const results = await sess.run(feeds);
  const outputTensor = results[sess.outputNames[0] || 'output'];
  const outputData = outputTensor.data as Float32Array;

  const predictions: CharPrediction[] = [];
  const numClasses = OCR_LABELS.length; // 13

  for (let i = 0; i < N; i++) {
    const logits = outputData.subarray(i * numClasses, (i + 1) * numClasses);
    const probs = softmax(logits);

    const candidates = probs
      .map((p, idx) => ({ char: OCR_LABELS[idx] || '?', confidence: p }))
      .sort((a, b) => b.confidence - a.confidence);

    predictions.push({
      char: candidates[0].char,
      confidence: candidates[0].confidence,
      classId: OCR_LABELS.indexOf(candidates[0].char),
      candidates,
    });
  }

  return predictions;
}

/**
 * Nhận diện toàn bộ ký tự trong 1 dòng văn bản với ngữ pháp ràng buộc (Grammar-aware)
 */
export async function recognizeLine(
  cleanBinary: Uint8Array,
  imgWidth: number,
  lineBox: Rect,
  lineIdx: number,
  scaleFactor = 1.0
): Promise<DetectedLine> {
  const charCrops = extractCharactersFromLine(cleanBinary, imgWidth, lineBox, scaleFactor);
  if (charCrops.length === 0) {
    return {
      idx: lineIdx,
      text: '',
      box: lineBox,
      chars: [],
    };
  }

  const tensors = charCrops.map((c) => c.tensorData);
  const preds = await predictBatch(tensors);

  const charBoxes: CharBox[] = [];
  let lineText = '';
  const N = preds.length;

  // Kiểm tra nếu là dòng số nguyên ngắn (vd: Số máy 1..3 chữ số không có dấu chấm '.')
  const hasDot = preds.some((p) => p.char === '.');
  const isShortInteger = N <= 3 && !hasDot;

  for (let i = 0; i < N; i++) {
    const p = preds[i];
    const crop = charCrops[i];
    const isFirst = i === 0;
    const isLast = i === N - 1;

    let chosenChar = p.char;
    let chosenConf = p.confidence;

    if (isShortInteger) {
      // Trong dòng số nguyên (Số máy), BẮT BUỘC là chữ số 0-9, không bao giờ là % hay $
      const digitCand = p.candidates.find((c) => /^[0-9]$/.test(c.char));
      if (digitCand) {
        chosenChar = digitCand.char;
        chosenConf = digitCand.confidence;
      }
    } else {
      // '$' chỉ được phép đứng đầu dòng (Mệnh giá $0.01)
      if (chosenChar === '$' && !isFirst) {
        const alt = p.candidates.find((c) => c.char !== '$');
        if (alt) {
          chosenChar = alt.char;
          chosenConf = alt.confidence;
        }
      }
      // '%' chỉ được phép đứng cuối dòng (RTP 92.827%)
      if (chosenChar === '%' && !isLast) {
        const alt = p.candidates.find((c) => c.char !== '%');
        if (alt) {
          chosenChar = alt.char;
          chosenConf = alt.confidence;
        }
      }
    }

    charBoxes.push({
      char: chosenChar,
      confidence: chosenConf,
      x: crop.box.x,
      y: crop.box.y,
      w: crop.box.w,
      h: crop.box.h,
    });
    lineText += chosenChar;
  }

  return {
    idx: lineIdx,
    text: lineText,
    box: lineBox,
    chars: charBoxes,
  };
}
