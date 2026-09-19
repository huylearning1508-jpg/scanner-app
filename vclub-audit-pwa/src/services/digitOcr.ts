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

/**
 * Batch inference cho danh sách các tensor ký tự 64x64
 */
export async function predictBatch(
  charTensors: Float32Array[]
): Promise<{ char: string; confidence: number; classId: number }[]> {
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

  const predictions: { char: string; confidence: number; classId: number }[] = [];
  const numClasses = OCR_LABELS.length; // 13

  for (let i = 0; i < N; i++) {
    const logits = outputData.subarray(i * numClasses, (i + 1) * numClasses);
    const probs = softmax(logits);

    let topId = 0;
    let maxProb = probs[0];
    for (let c = 1; c < numClasses; c++) {
      if (probs[c] > maxProb) {
        maxProb = probs[c];
        topId = c;
      }
    }

    predictions.push({
      char: OCR_LABELS[topId] || '?',
      confidence: maxProb,
      classId: topId,
    });
  }

  return predictions;
}

/**
 * Nhận diện toàn bộ ký tự trong 1 dòng văn bản
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

  for (let i = 0; i < preds.length; i++) {
    const p = preds[i];
    const crop = charCrops[i];

    charBoxes.push({
      char: p.char,
      confidence: p.confidence,
      x: crop.box.x,
      y: crop.box.y,
      w: crop.box.w,
      h: crop.box.h,
    });
    lineText += p.char;
  }

  return {
    idx: lineIdx,
    text: lineText,
    box: lineBox,
    chars: charBoxes,
  };
}
