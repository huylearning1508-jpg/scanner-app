/**
 * Client-side Image Processing Pipeline
 * Tối ưu hóa xử lý ảnh 100% bằng JavaScript & TypedArray (Canvas 2D):
 * 1. Grayscale (trọng số ITU-R BT.601)
 * 2. Integral Image (Bảng cộng dồn 2D) cho Adaptive Threshold O(1)
 * 3. Lọc triệt tiêu hạt lưới dither Moiré (Connected Components Area Filter)
 * 4. Tách dòng bằng Horizontal Projection Profile & Gom cụm Collinear
 * 5. Tách ký tự đơn lẻ, xử lý riêng dấu chấm (dot), letterbox chuẩn 64x64 và chuẩn hóa [-1, 1]
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CharCropData {
  box: Rect;
  tensorData: Float32Array; // 32x32 normalized [-1, 1]
  isDot: boolean;
}

// Tái sử dụng vùng nhớ TypedArray (Memory Pool) để loại bỏ hoàn toàn chi phí Garbage Collection (GC)
let cachedGray: Uint8Array | null = null;
let cachedIntegral: Int32Array | null = null;
let cachedBinary: Uint8Array | null = null;

function getGrayBuffer(size: number): Uint8Array {
  if (!cachedGray || cachedGray.length < size) {
    cachedGray = new Uint8Array(size);
  }
  return cachedGray;
}

function getIntegralBuffer(size: number): Int32Array {
  if (!cachedIntegral || cachedIntegral.length < size) {
    cachedIntegral = new Int32Array(size);
  }
  return cachedIntegral;
}

function getBinaryBuffer(size: number): Uint8Array {
  if (!cachedBinary || cachedBinary.length < size) {
    cachedBinary = new Uint8Array(size);
  }
  return cachedBinary;
}

/**
 * 1. Chuyển đổi ImageData sang mảng Grayscale 1 kênh (Uint8Array)
 */
export function toGrayscale(imageData: ImageData): Uint8Array {
  const { width, height, data } = imageData;
  const size = width * height;
  const gray = getGrayBuffer(size);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // 0.299 * R + 0.587 * G + 0.114 * B
    gray[j] = ((data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8) & 0xff;
  }
  return gray.subarray(0, size);
}

/**
 * 2. Tính Bảng Cộng Dồn 2D (Integral Image) kích thước (W+1) x (H+1)
 * Cho phép tính tổng pixel trong bất kỳ hình chữ nhật nào trong O(1)
 */
export function computeIntegralImage(gray: Uint8Array, width: number, height: number): Int32Array {
  const stride = width + 1;
  const size = (width + 1) * (height + 1);
  const integral = getIntegralBuffer(size);

  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const yStride = y * width;
    const intYStride = (y + 1) * stride;
    const prevIntYStride = y * stride;

    for (let x = 0; x < width; x++) {
      rowSum += gray[yStride + x];
      integral[intYStride + (x + 1)] = integral[prevIntYStride + (x + 1)] + rowSum;
    }
  }
  return integral.subarray(0, size);
}

/**
 * 3. Adaptive Thresholding siêu tốc sử dụng Integral Image
 * Chữ nét đen (0) trên nền trắng tinh khiết (255)
 * Tham số: blockSize = 21, C = 12 (theo spec)
 */
export function adaptiveThreshold(
  gray: Uint8Array,
  width: number,
  height: number,
  blockSize = 21,
  cVal = 12
): Uint8Array {
  const integral = computeIntegralImage(gray, width, height);
  const size = width * height;
  const binary = getBinaryBuffer(size);
  const stride = width + 1;
  const half = Math.floor(blockSize / 2);

  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - half);
    const y2 = Math.min(height - 1, y + half);
    const boxH = y2 - y1 + 1;
    const intY1 = y1 * stride;
    const intY2 = (y2 + 1) * stride;
    const rowOffset = y * width;

    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - half);
      const x2 = Math.min(width - 1, x + half);
      const boxW = x2 - x1 + 1;
      const count = boxW * boxH;

      // Tổng pixel trong vùng = I(x2+1, y2+1) - I(x2+1, x1) - I(x1, y2+1) + I(x1, y1)
      const sum =
        integral[intY2 + (x2 + 1)] -
        integral[intY2 + x1] -
        integral[intY1 + (x2 + 1)] +
        integral[intY1 + x1];

      const mean = sum / count;
      const pixelVal = gray[rowOffset + x];

      // Nếu pixel tối hơn mức trung bình trừ C => là chữ đen (0), ngược lại là nền trắng (255)
      binary[rowOffset + x] = pixelVal < (mean - cVal) ? 0 : 255;
    }
  }

  return binary.subarray(0, size);
}

/**
 * 4. Tẩy hạt dither Moiré bằng lọc diện tích thành phần liên thông (Connected-Components)
 * Loại bỏ các cụm pixel đen nhỏ li ti (area <= areaThresh)
 */
export function removeDitherNoise(
  binary: Uint8Array,
  width: number,
  height: number,
  areaThresh = 4
): Uint8Array {
  const labels = new Int32Array(width * height);
  let currentLabel = 0;

  // Two-pass CCL với Disjoint Set Union (DSU)
  const parent: number[] = [0];
  const area: number[] = [0];

  function find(i: number): number {
    let root = i;
    while (root !== parent[root]) {
      root = parent[root];
    }
    let curr = i;
    while (curr !== root) {
      const next = parent[curr];
      parent[curr] = root;
      curr = next;
    }
    return root;
  }

  function union(i: number, j: number) {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) {
      parent[rootI] = rootJ;
      area[rootJ] += area[rootI];
    }
  }

  // Pass 1: Gán nhãn sơ bộ
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    const prevRowOffset = (y - 1) * width;

    for (let x = 0; x < width; x++) {
      if (binary[rowOffset + x] === 0) {
        // Pixel đen (chữ hoặc hạt)
        const left = x > 0 && binary[rowOffset + (x - 1)] === 0 ? labels[rowOffset + (x - 1)] : 0;
        const top = y > 0 && binary[prevRowOffset + x] === 0 ? labels[prevRowOffset + x] : 0;
        const topLeft = x > 0 && y > 0 && binary[prevRowOffset + (x - 1)] === 0 ? labels[prevRowOffset + (x - 1)] : 0;
        const topRight = x < width - 1 && y > 0 && binary[prevRowOffset + (x + 1)] === 0 ? labels[prevRowOffset + (x + 1)] : 0;

        const neighbors = [left, top, topLeft, topRight].filter((l) => l > 0);

        if (neighbors.length === 0) {
          currentLabel++;
          parent.push(currentLabel);
          area.push(1);
          labels[rowOffset + x] = currentLabel;
        } else {
          const minLabel = Math.min(...neighbors);
          labels[rowOffset + x] = minLabel;
          area[minLabel]++;
          for (const n of neighbors) {
            if (n !== minLabel) {
              union(n, minLabel);
            }
          }
        }
      }
    }
  }

  // Tính tổng diện tích của từng root component
  const rootArea = new Map<number, number>();
  for (let l = 1; l <= currentLabel; l++) {
    const root = find(l);
    rootArea.set(root, (rootArea.get(root) || 0) + area[l]);
  }

  // Pass 2: Loại bỏ hạt dither diện tích nhỏ
  const cleanBinary = new Uint8Array(width * height);
  cleanBinary.set(binary);

  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l > 0) {
      const root = find(l);
      const totalArea = rootArea.get(root) || 0;
      if (totalArea <= areaThresh) {
        cleanBinary[i] = 255; // Tẩy về nền trắng
      }
    }
  }

  return cleanBinary;
}

/**
 * 5. Tách dòng bằng Horizontal Projection Profile (HPP) & Bounding Box Merging
 */
export function extractLines(
  cleanBinary: Uint8Array,
  width: number,
  height: number,
  scaleFactor = 1.0
): Rect[] {
  // 1. Tính tổng số pixel đen trên mỗi hàng
  const hpp = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    const offset = y * width;
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (cleanBinary[offset + x] === 0) count++;
    }
    hpp[y] = count;
  }

  // 2. Làm mượt HPP bằng bộ lọc 1D trung bình động 5 pixel để loại bỏ nhiễu răng cưa
  const smoothed = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let cnt = 0;
    for (let dy = -2; dy <= 2; dy++) {
      const ny = y + dy;
      if (ny >= 0 && ny < height) {
        sum += hpp[ny];
        cnt++;
      }
    }
    smoothed[y] = sum / (cnt || 1);
  }

  // 3. Tính ngưỡng động theo phân vị (percentile) thay vì cố định minTextPix = 5
  // Giúp phát hiện rãnh ngắt dòng (valleys) ngay cả khi có ánh sáng phản chiếu hoặc dither
  const sorted = Array.from(smoothed).sort((a, b) => a - b);
  const p25 = sorted[Math.floor(height * 0.25)] || 0;
  const p75 = sorted[Math.floor(height * 0.75)] || 0;
  const maxVal = sorted[height - 1] || 0;

  if (maxVal < 8) return [];

  // Ngưỡng tách dòng: vượt lên trên thung lũng (valleys) giữa các dòng
  const thresh = Math.max(10, p25 + (p75 - p25) * 0.2);

  const minLineH = Math.max(6, Math.floor(8 * scaleFactor));
  const lineBands: { y1: number; y2: number }[] = [];
  let inLine = false;
  let startY = 0;

  for (let y = 0; y < height; y++) {
    if (smoothed[y] >= thresh) {
      if (!inLine) {
        inLine = true;
        startY = y;
      }
    } else {
      if (inLine) {
        inLine = false;
        if (y - startY >= minLineH) {
          lineBands.push({ y1: startY, y2: y });
        }
      }
    }
  }
  if (inLine && height - startY >= minLineH) {
    lineBands.push({ y1: startY, y2: height });
  }

  // 4. Với mỗi dải Y, dò biên độ X trái - phải (loại trừ các hạt biên sát mép)
  const lines: Rect[] = [];
  const pad = Math.max(2, Math.floor(3 * scaleFactor));

  for (const band of lineBands) {
    let minX = width;
    let maxX = 0;

    for (let y = band.y1; y < band.y2; y++) {
      const offset = y * width;
      for (let x = 0; x < width; x++) {
        if (cleanBinary[offset + x] === 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }

    if (maxX > minX && maxX - minX > Math.floor(12 * scaleFactor)) {
      const x0 = Math.max(0, minX - pad);
      const y0 = Math.max(0, band.y1 - pad);
      const x1 = Math.min(width, maxX + pad + 1);
      const y1 = Math.min(height, band.y2 + pad + 1);
      lines.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  }

  // Sắp xếp các dòng theo thứ tự từ trên xuống dưới
  lines.sort((a, b) => a.y - b.y);
  return lines;
}

/**
 * 6. Tách từng ký tự trong một dòng, resize giữ nguyên tỉ lệ vào khung 32x32
 * lấy trực tiếp từ ảnh xám tự nhiên (grayImage) và chuẩn hóa tensor về [-1, 1]
 */
export function extractCharactersFromLine(
  cleanBinary: Uint8Array,
  imgWidth: number,
  lineBox: Rect,
  scaleFactor = 1.0,
  grayImage?: Uint8Array
): CharCropData[] {
  const { x: lx, y: ly, w: lw, h: lh } = lineBox;
  if (lw <= 0 || lh <= 0) return [];

  // Tính Vertical Projection Profile trong dải dòng từ binary
  const vpp = new Int32Array(lw);
  for (let x = 0; x < lw; x++) {
    let count = 0;
    for (let y = 0; y < lh; y++) {
      const idx = (ly + y) * imgWidth + (lx + x);
      if (cleanBinary[idx] === 0) count++;
    }
    vpp[x] = count;
  }

  // Dò các cụm ký tự theo trục X
  const rawBoxes: Rect[] = [];
  let inChar = false;
  let charStartX = 0;

  for (let x = 0; x < lw; x++) {
    if (vpp[x] > 0) {
      if (!inChar) {
        inChar = true;
        charStartX = x;
      }
    } else {
      if (inChar) {
        inChar = false;
        const charW = x - charStartX;
        if (charW >= 1) {
          // Dò minY, maxY cho cụm ký tự này
          let minY = lh;
          let maxY = 0;
          for (let cy = 0; cy < lh; cy++) {
            for (let cx = charStartX; cx < x; cx++) {
              if (cleanBinary[(ly + cy) * imgWidth + (lx + cx)] === 0) {
                if (cy < minY) minY = cy;
                if (cy > maxY) maxY = cy;
              }
            }
          }
          if (maxY >= minY) {
            rawBoxes.push({
              x: lx + charStartX,
              y: ly + minY,
              w: charW,
              h: maxY - minY + 1,
            });
          }
        }
      }
    }
  }

  if (inChar) {
    const charW = lw - charStartX;
    let minY = lh;
    let maxY = 0;
    for (let cy = 0; cy < lh; cy++) {
      for (let cx = charStartX; cx < lw; cx++) {
        if (cleanBinary[(ly + cy) * imgWidth + (lx + cx)] === 0) {
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
        }
      }
    }
    if (maxY >= minY) {
      rawBoxes.push({
        x: lx + charStartX,
        y: ly + minY,
        w: charW,
        h: maxY - minY + 1,
      });
    }
  }

  // Hợp nhất chỉ khi một trong 2 cụm là mảnh nét đứt của ký tự đặc biệt (như $, %)
  // Tuyệt đối KHÔNG hợp nhất 2 chữ số đứng sát nhau thành một ô
  const merged: Rect[] = [];
  const maxGap = Math.max(1, Math.floor(1.5 * scaleFactor));

  for (const b of rawBoxes) {
    if (merged.length === 0) {
      merged.push(b);
    } else {
      const prev = merged[merged.length - 1];
      const gap = b.x - (prev.x + prev.w);
      const isFragment = prev.h < lh * 0.35 || b.h < lh * 0.35 || (prev.w + b.w <= lh * 0.65);

      if (gap <= maxGap && isFragment) {
        const nx = prev.x;
        const ny = Math.min(prev.y, b.y);
        const nw = Math.max(prev.x + prev.w, b.x + b.w) - nx;
        const nh = Math.max(prev.y + prev.h, b.y + b.h) - ny;
        merged[merged.length - 1] = { x: nx, y: ny, w: nw, h: nh };
      } else {
        merged.push(b);
      }
    }
  }

  const results: CharCropData[] = [];
  const TARGET_SIZE = 32;
  const dotLimitH = Math.max(5, Math.floor(lh * 0.35));
  const dotLimitW = Math.max(5, Math.floor(lh * 0.35));

  for (const box of merged) {
    if (box.w <= 0 || box.h <= 0) continue;

    // Kiểm tra xem có phải là dấu chấm '.' hay không (kích thước rất nhỏ nằm ở đáy)
    const isDot = box.h <= dotLimitH && box.w <= dotLimitW;

    if (isDot) {
      // Dấu chấm: gán cờ isDot = true, tự động gán nhãn '.' mà không cần gọi model ONNX
      results.push({
        box,
        tensorData: new Float32Array(TARGET_SIZE * TARGET_SIZE),
        isDot: true,
      });
      continue;
    }

    // Co giãn giữ nguyên tỉ lệ (Aspect Ratio) vào giữa canvas 32x32
    // Đệm viền bằng màu nền xung quanh nét chữ (tương đương resize_with_padding)
    const canvas = new Uint8Array(TARGET_SIZE * TARGET_SIZE);
    let fill = 255;
    if (grayImage) {
      const p1 = grayImage[box.y * imgWidth + box.x];
      const p2 = grayImage[box.y * imgWidth + Math.min(imgWidth - 1, box.x + box.w - 1)];
      const p3 = grayImage[Math.min(grayImage.length - 1, (box.y + box.h - 1) * imgWidth + box.x)];
      const p4 = grayImage[Math.min(grayImage.length - 1, (box.y + box.h - 1) * imgWidth + Math.min(imgWidth - 1, box.x + box.w - 1))];
      fill = Math.round((p1 + p2 + p3 + p4) / 4);
    }
    canvas.fill(fill);

    const maxCharDim = 28; // Giữ biên đệm viền ngoài
    let scale = maxCharDim / Math.max(box.h, 1);
    let newW = Math.max(1, Math.min(28, Math.round(box.w * scale)));
    let newH = Math.max(1, Math.min(28, Math.round(box.h * scale)));

    if (newW > 28) {
      scale = 28 / Math.max(box.w, 1);
      newW = Math.max(1, Math.min(28, Math.round(box.w * scale)));
      newH = Math.max(1, Math.min(28, Math.round(box.h * scale)));
    }

    const sx = Math.floor((TARGET_SIZE - newW) / 2);
    const sy = Math.floor((TARGET_SIZE - newH) / 2);

    // Lấy pixel trực tiếp từ ảnh xám tự nhiên (grayImage) để giữ nguyên độ mịn font & anti-aliasing
    const sourcePixels = grayImage || cleanBinary;

    for (let dy = 0; dy < newH; dy++) {
      const srcY = box.y + Math.floor((dy * box.h) / newH);
      for (let dx = 0; dx < newW; dx++) {
        const srcX = box.x + Math.floor((dx * box.w) / newW);
        canvas[(sy + dy) * TARGET_SIZE + (sx + dx)] =
          sourcePixels[srcY * imgWidth + srcX];
      }
    }

    // Chuẩn hóa tensor float32: (pixel / 127.5) - 1.0 => [-1.0, 1.0] (khớp chuẩn PyTorch/ONNX)
    const tensorData = new Float32Array(TARGET_SIZE * TARGET_SIZE);
    for (let i = 0; i < tensorData.length; i++) {
      tensorData[i] = (canvas[i] / 127.5) - 1.0;
    }

    results.push({ box, tensorData, isDot: false });
  }

  return results;
}
