/**
 * Multi-frame Stability Tracker
 * Theo dõi kết quả nhận diện qua 2-3 frame liên tiếp.
 * Khi kết quả Machine No, RTP1, RTP2 ổn định và đạt ngưỡng tin cậy,
 * kích hoạt sự kiện khóa màn hình và chuyển sang bước xác nhận.
 */

import type { AuditFieldResult } from '../types';

export interface StabilityState {
  isStable: boolean;
  consecutiveMatches: number;
  bestResult: AuditFieldResult | null;
}

export class StabilityTracker {
  private history: AuditFieldResult[] = [];
  private requiredConsecutive: number;
  private minConfidence: number;

  constructor(requiredConsecutive = 2, minConfidence = 0.7) {
    this.requiredConsecutive = requiredConsecutive;
    this.minConfidence = minConfidence;
  }

  public reset() {
    this.history = [];
  }

  /**
   * So sánh xem 2 kết quả có tương đương nhau hay không
   */
  private areResultsEqual(a: AuditFieldResult, b: AuditFieldResult): boolean {
    if (a.machineNo !== b.machineNo) return false;

    // So sánh RTP1 với sai số cho phép rất nhỏ 0.001
    if (a.rtp1 === null || b.rtp1 === null) {
      if (a.rtp1 !== b.rtp1) return false;
    } else if (Math.abs(a.rtp1 - b.rtp1) > 0.005) {
      return false;
    }

    // So sánh RTP2
    if (a.rtp2 === null || b.rtp2 === null) {
      if (a.rtp2 !== b.rtp2) return false;
    } else if (Math.abs(a.rtp2 - b.rtp2) > 0.005) {
      return false;
    }

    return true;
  }

  /**
   * Đẩy kết quả frame mới vào và đánh giá độ ổn định
   */
  public pushFrame(result: AuditFieldResult): StabilityState {
    // Chỉ chấp nhận các frame đã đọc được Machine No và ít nhất 1 RTP
    if (result.machineNo === null || (result.rtp1 === null && result.rtp2 === null)) {
      this.history = [];
      return { isStable: false, consecutiveMatches: 0, bestResult: null };
    }

    // Kiểm tra ngưỡng confidence tối thiểu
    const avgConfidence =
      (result.confidence.machineNo +
        result.confidence.rtp1 +
        (result.confidence.rtp2 || result.confidence.rtp1)) /
      3;

    if (avgConfidence < this.minConfidence && !result.confidence.anchorFound) {
      this.history = [];
      return { isStable: false, consecutiveMatches: 0, bestResult: null };
    }

    if (this.history.length === 0) {
      this.history.push(result);
      return { isStable: false, consecutiveMatches: 1, bestResult: result };
    }

    const last = this.history[this.history.length - 1];
    if (this.areResultsEqual(last, result)) {
      this.history.push(result);
      const matches = this.history.length;

      if (matches >= this.requiredConsecutive) {
        return {
          isStable: true,
          consecutiveMatches: matches,
          bestResult: result,
        };
      }
      return {
        isStable: false,
        consecutiveMatches: matches,
        bestResult: result,
      };
    } else {
      // Đổi giá trị => reset lại chuỗi
      this.history = [result];
      return { isStable: false, consecutiveMatches: 1, bestResult: result };
    }
  }
}
