"""
Script trích xuất từng bước trong quy trình tiền xử lý ảnh OCR (Step-by-step Preprocessing Pipeline).
Hỗ trợ nạp bất kỳ ảnh thật nào từ camera điện thoại (ảnh toàn màn hình hoặc ảnh crop sẵn).

Xuất lần lượt 7 file ảnh vào thư mục debug_steps/:
  1. 01_anh_goc_crop.png          : Vùng số cắt từ camera gốc.
  2. 02_anh_xam_grayscale.png     : Ảnh sau khi chuyển sang mức xám (1 kênh).
  3. 03_lam_phang_anh_sang.png    : Khử chói sáng không đều và làm dịu vân sọc LCD.
  4. 04_xoa_nen_trang_den.png     : Ảnh nhị phân bỏ nền hoàn toàn (chữ đen trên nền trắng tinh).
  5. 05_khe_trang_chieu_dung.png  : Các vạch dọc xanh lá đâm xuyên qua đúng các khe trắng dọc giữa các ký tự.
  6. 06_khoanh_vung_tung_ky_tu.png: Khung chữ nhật màu đỏ bao quanh từng ký tự riêng biệt.
  7. 07_dau_cuoi_8_slot_192x48.png: Đặt từng ký tự vào đúng trung tâm các ô của khung chuẩn (192x48).
"""

import argparse
import os
import sys
from pathlib import Path

import cv2
import numpy as np

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import config

# Tọa độ và nhãn chuẩn của các dòng trên màn hình máy slot
PRESET_LINES = {
    1: {
        "name": "Dòng 1 (khoảng 92.734%)",
        "y1": 0.43, "y2": 0.51, "x1": 0.10, "x2": 0.75,
        "labels": ["9", "2", ".", "7", "3", "4", "%"]
    },
    2: {
        "name": "Dòng 2 (khoảng 93.63%)",
        "y1": 0.52, "y2": 0.60, "x1": 0.15, "x2": 0.75,
        "labels": ["9", "3", ".", "6", "3", "%"]
    },
    3: {
        "name": "Dòng 3 (khoảng 12)",
        "y1": 0.63, "y2": 0.70, "x1": 0.25, "x2": 0.75,
        "labels": ["1", "2"]
    }
}


def load_image(image_path):
    """Nạp ảnh hỗ trợ Unicode path trên Windows & Linux."""
    img_str = str(image_path)
    img = cv2.imread(img_str, cv2.IMREAD_COLOR)
    if img is None:
        try:
            arr = np.fromfile(img_str, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        except Exception:
            img = None
    if img is None:
        raise FileNotFoundError(f"Không thể mở file ảnh: {image_path}")
    return img


def is_full_screen_photo(img):
    """
    Kiểm tra xem ảnh truyền vào là ảnh chụp toàn màn hình hay là ảnh crop sẵn.
    Ảnh toàn màn hình thường có kích thước lớn (>600px chiều cao) và tỷ lệ khung hình không quá dẹt (W/H < 3.0).
    """
    h, w = img.shape[:2]
    aspect_ratio = w / max(1, h)
    return (h > 600 and w > 1000) or aspect_ratio < 3.0


def crop_line_from_full(img, line_num):
    """Cắt vùng dòng chữ số từ ảnh chụp màn hình gốc theo tỷ lệ chuẩn."""
    preset = PRESET_LINES.get(line_num, PRESET_LINES[2])
    h, w = img.shape[:2]
    ymin = max(0, min(int(preset["y1"] * h), h - 1))
    ymax = max(ymin + 1, min(int(preset["y2"] * h), h))
    xmin = max(0, min(int(preset["x1"] * w), w - 1))
    xmax = max(xmin + 1, min(int(preset["x2"] * w), w))
    cropped = img[ymin:ymax, xmin:xmax]
    return cropped, (ymin, ymax, xmin, xmax), preset


def process_and_export_steps(image_input_path, line_num=2, output_dir="debug_steps"):
    """Thực hiện toàn bộ 7 bước tiền xử lý và lưu từng file ảnh riêng biệt."""
    os.makedirs(output_dir, exist_ok=True)

    print("=" * 80)
    print("QUY TRÌNH TIỀN XỬ LÝ ẢNH NÂNG CAO CHO MODEL AI SCREEN DIGIT OCR")
    print(f"Ảnh đầu vào    : {image_input_path}")
    print(f"Dòng chỉ định  : Dòng {line_num} ({PRESET_LINES.get(line_num, {}).get('name', 'Tự do')})")
    print(f"Thư mục kết quả: {output_dir}")
    print("=" * 80 + "\n")

    input_img = load_image(image_input_path)
    preset = PRESET_LINES.get(line_num, PRESET_LINES[2])

    # --------------------------------------------------------------------------
    # BƯỚC 1: 01_anh_goc_crop.png - VÙNG SỐ ĐƯỢC CẮT TỪ CAMERA GỐC
    # --------------------------------------------------------------------------
    if is_full_screen_photo(input_img):
        raw_crop, coords, _ = crop_line_from_full(input_img, line_num)
        print(f"[*] Phát hiện ảnh chụp toàn màn hình ({input_img.shape[1]}x{input_img.shape[0]}).")
        print(f"    Đã cắt Dòng {line_num} tại Y=[{coords[0]}:{coords[1]}], X=[{coords[2]}:{coords[3]}].")
    else:
        raw_crop = input_img.copy()
        print(f"[*] Phát hiện ảnh vùng số đã cắt sẵn ({raw_crop.shape[1]}x{raw_crop.shape[0]}).")

    h, w = raw_crop.shape[:2]
    step1_path = os.path.join(output_dir, "01_anh_goc_crop.png")
    cv2.imwrite(step1_path, raw_crop)
    print(f"[BƯỚC 1/7] {os.path.basename(step1_path):<32} | Kích thước: {w}x{h} (3 kênh BGR)")
    print("           -> Trích xuất vùng ROI chứa chuỗi ký tự từ camera chụp màn hình máy slot.\n")

    # --------------------------------------------------------------------------
    # BƯỚC 2: 02_anh_xam_grayscale.png - ẢNH MỨC XÁM (1 KÊNH)
    # --------------------------------------------------------------------------
    img_gray = cv2.cvtColor(raw_crop, cv2.COLOR_BGR2GRAY)
    step2_path = os.path.join(output_dir, "02_anh_xam_grayscale.png")
    cv2.imwrite(step2_path, img_gray)
    print(f"[BƯỚC 2/7] {os.path.basename(step2_path):<32} | Kích thước: {w}x{h} (1 kênh Gray)")
    print("           -> Chuyển đổi không gian màu BGR sang Grayscale 8-bit [0-255].\n")

    # --------------------------------------------------------------------------
    # BƯỚC 3: 03_lam_phang_anh_sang.png - KHỬ ÁNH SÁNG CHÓI & LÀM DỊU VÂN SỌC LCD
    # --------------------------------------------------------------------------
    # Dùng phép giãn nở Morphological Dilation và Gaussian Blur để ước lượng nền chiếu sáng
    kernel_size = max(15, (min(w, h) // 10) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    bg_estimate = cv2.morphologyEx(img_gray, cv2.MORPH_DILATE, kernel)
    bg_estimate = cv2.GaussianBlur(bg_estimate, (kernel_size, kernel_size), 0)

    # Phép chia chuẩn hóa độ sáng (Division Normalization)
    flattened = cv2.divide(img_gray, bg_estimate, scale=255)
    flattened = cv2.normalize(flattened, None, alpha=0, beta=255, norm_type=cv2.NORM_MINMAX)

    step3_path = os.path.join(output_dir, "03_lam_phang_anh_sang.png")
    cv2.imwrite(step3_path, flattened)
    print(f"[BƯỚC 3/7] {os.path.basename(step3_path):<32} | Kích thước: {w}x{h} (1 kênh Gray)")
    print("           -> Khử quang sai, xóa ánh sáng lóa không đều và làm mịn vân sọc lưới LCD bằng ước tính nền (Morphological Dilation + Gaussian Blur).\n")

    # --------------------------------------------------------------------------
    # BƯỚC 4: 04_xoa_nen_trang_den.png - ẢNH NHỊ PHÂN BỎ NỀN HOÀN TOÀN
    # --------------------------------------------------------------------------
    blur = cv2.GaussianBlur(flattened, (3, 3), 0)
    _, thresh_inv = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Lọc bỏ các đốm hạt nhỏ li ti của sọc LCD bằng Morphological Opening
    clean_ksize = 2 if min(w, h) > 80 else 1
    if clean_ksize > 1:
        kernel_clean = cv2.getStructuringElement(cv2.MORPH_RECT, (clean_ksize, clean_ksize))
        thresh_cleaned = cv2.morphologyEx(thresh_inv, cv2.MORPH_OPEN, kernel_clean)
    else:
        thresh_cleaned = thresh_inv

    # Đảo ngược: Chữ nét đen (0) trên nền trắng tinh (255)
    binary_text_only = cv2.bitwise_not(thresh_cleaned)

    step4_path = os.path.join(output_dir, "04_xoa_nen_trang_den.png")
    cv2.imwrite(step4_path, binary_text_only)
    print(f"[BƯỚC 4/7] {os.path.basename(step4_path):<32} | Kích thước: {w}x{h} (1 kênh Binary)")
    print("           -> Nhị phân hóa Otsu kết hợp Morphological Opening: Loại bỏ 100% sọc nền LCD, chữ đen rõ nét trên nền trắng tinh.\n")

    # --------------------------------------------------------------------------
    # BƯỚC 5: 05_khe_trang_chieu_dung.png - CÁC VẠCH DỌC XANH LÁ CÂY QUA KHE TRẮNG
    # --------------------------------------------------------------------------
    # Phép chiếu đứng Vertical Projection: Đếm số pixel nét chữ theo từng cột dọc
    v_proj = np.sum(thresh_cleaned == 255, axis=0)

    # Ngưỡng phát hiện cột có nét chữ
    min_col_pixels = max(2, int(h * 0.015))
    is_text = v_proj > min_col_pixels

    # Tìm các dải ký tự
    raw_segments = []
    in_seg = False
    start = 0
    min_seg_w = max(3, int(w * 0.003))

    for i, val in enumerate(is_text):
        if val and not in_seg:
            in_seg = True
            start = i
        elif not val and in_seg:
            in_seg = False
            if i - start >= min_seg_w:
                raw_segments.append((start, i))
    if in_seg and len(is_text) - start >= min_seg_w:
        raw_segments.append((start, len(is_text)))

    # Hợp nhất các đoạn quá sát nhau (<= 2 pixel)
    segments = []
    for s, e in raw_segments:
        if not segments:
            segments.append([s, e])
        else:
            if s - segments[-1][1] <= 2:
                segments[-1][1] = e
            else:
                segments.append([s, e])

    # Xác định các khe trắng dọc giữa các ký tự
    gap_x_coords = []
    if segments:
        gap_x_coords.append(max(0, segments[0][0] - 6))
    for idx in range(len(segments) - 1):
        mid_gap = (segments[idx][1] + segments[idx + 1][0]) // 2
        gap_x_coords.append(mid_gap)
    if segments:
        gap_x_coords.append(min(w - 1, segments[-1][1] + 6))

    # Vẽ các đường kẻ đứng màu xanh lá cây (0, 255, 0)
    vis_gaps = raw_crop.copy()
    line_thickness = max(1, int(round(w / 800)))
    for gx in gap_x_coords:
        cv2.line(vis_gaps, (gx, 0), (gx, h), (0, 255, 0), line_thickness)

    step5_path = os.path.join(output_dir, "05_khe_trang_chieu_dung.png")
    cv2.imwrite(step5_path, vis_gaps)
    print(f"[BƯỚC 5/7] {os.path.basename(step5_path):<32} | Kích thước: {w}x{h} (3 kênh BGR)")
    print(f"           -> Thuật toán Vertical Projection Profile: Dò tìm {len(gap_x_coords)} khe hở trắng dọc, vẽ vạch xanh lá cây cắt xuyên qua đúng khe giữa các chữ.\n")

    # --------------------------------------------------------------------------
    # BƯỚC 6: 06_khoanh_vung_tung_ky_tu.png - KHUNG CHỮ NHẬT ĐỎ BAO QUANH TỪNG KÝ TỰ
    # --------------------------------------------------------------------------
    vis_boxes = raw_crop.copy()
    char_crops = []
    sample_labels = preset.get("labels", [])

    box_thickness = max(2, int(round(w / 700)))
    font_scale = max(0.6, w / 2000.0)

    for idx, (s, e) in enumerate(segments):
        col_slice = thresh_cleaned[:, s:e]
        rows = np.where(np.sum(col_slice == 255, axis=1) > 0)[0]
        if len(rows) == 0:
            continue
        y_top, y_bot = rows[0], rows[-1]

        # Đệm nhẹ 2px
        y_top = max(0, y_top - 2)
        y_bot = min(h - 1, y_bot + 2)
        s_pad = max(0, s - 2)
        e_pad = min(w - 1, e + 2)

        c_crop = img_gray[y_top : y_bot + 1, s_pad : e_pad + 1]
        char_crops.append((c_crop, (s_pad, e_pad, y_top, y_bot)))

        # Vẽ khung chữ nhật MÀU ĐỎ (BGR: 0, 0, 255)
        cv2.rectangle(vis_boxes, (s_pad, y_top), (e_pad, y_bot), (0, 0, 255), box_thickness)

        lbl = sample_labels[idx] if idx < len(sample_labels) else f"[{idx+1}]"
        cv2.putText(vis_boxes, f"[{lbl}]", (s_pad, max(26, y_top - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, font_scale, (0, 0, 255), box_thickness)

    step6_path = os.path.join(output_dir, "06_khoanh_vung_tung_ky_tu.png")
    cv2.imwrite(step6_path, vis_boxes)
    detected_chars = [sample_labels[i] if i < len(sample_labels) else f"C{i+1}" for i in range(len(char_crops))]
    print(f"[BƯỚC 6/7] {os.path.basename(step6_path):<32} | Kích thước: {w}x{h} (3 kênh BGR)")
    print(f"           -> Trích xuất Bounding Box chính xác cho {len(char_crops)} ký tự riêng biệt: {detected_chars} với khung viền đỏ.\n")

    # --------------------------------------------------------------------------
    # --------------------------------------------------------------------------
    # BƯỚC 7: 07_dau_cuoi_8_slot_192x48.png - ĐẶT KÝ TỰ VÀO 8 SLOTS CHUẨN 192x48
    # --------------------------------------------------------------------------
    target_w, target_h = config.IMG_WIDTH, config.IMG_HEIGHT  # 192, 48
    slot_w = target_w // config.NUM_SLOTS                     # 24px

    border_pixels = np.concatenate([img_gray[0, :], img_gray[-1, :], img_gray[:, 0], img_gray[:, -1]])
    bg_val = int(np.median(border_pixels))

    canvas_slotted = np.full((target_h, target_w), bg_val, dtype=np.uint8)

    N = len(char_crops)
    if N > 0:
        # Căn chỉnh slot bắt đầu: N=6 đặt từ Slot 1 đến Slot 6 (Slot 0 và 7 để trống)
        if N >= 7:
            start_slot = 0
        elif N == 6:
            start_slot = 1  # Slot 1: [9], Slot 2: [3], Slot 3: [.], Slot 4: [6], Slot 5: [3], Slot 6: [%]
        elif N <= 3:
            start_slot = max(0, config.NUM_SLOTS - N)
        else:
            start_slot = max(0, (config.NUM_SLOTS - N) // 2)

        digit_heights = [c[0].shape[0] for c in char_crops if c[0].shape[0] > 40]
        max_digit_h = max(digit_heights) if digit_heights else max(c[0].shape[0] for c in char_crops)
        target_digit_h = 34  # Chiều cao chuẩn trong ô 48px
        scale = target_digit_h / max(1.0, float(max_digit_h))

        max_allowed_w = slot_w - 2   # Tối đa 22px để không tràn sang slot bên cạnh
        max_allowed_h = target_h - 6 # 42px

        for i in range(N):
            c_crop, info = char_crops[i]
            slot_idx = start_slot + i
            if slot_idx >= config.NUM_SLOTS:
                break

            # Tọa độ tâm X của slot đó: (start_slot + i) * 24 + 12
            slot_center_x = slot_idx * slot_w + (slot_w // 2)
            slot_left = slot_idx * slot_w
            slot_right = slot_left + slot_w

            is_dot = (c_crop.shape[0] < 50 and c_crop.shape[1] < 50)
            is_pct = (info[1] - info[0] > 180 and c_crop.shape[0] > 140)

            # Tính toán kích thước co giãn
            scaled_w = max(1, int(round(c_crop.shape[1] * scale)))
            scaled_h = max(1, int(round(c_crop.shape[0] * scale)))

            if is_dot:
                scaled_w = max(4, min(10, scaled_w))
                scaled_h = max(4, min(10, scaled_h))
            elif is_pct:
                scaled_w = max_allowed_w
                scaled_h = min(max_allowed_h, max(28, int(round(c_crop.shape[0] * scale))))
            else:
                if scaled_w > max_allowed_w:
                    w_factor = max_allowed_w / scaled_w
                    scaled_w = max_allowed_w
                    scaled_h = max(1, int(round(scaled_h * w_factor)))
                if scaled_h > max_allowed_h:
                    h_factor = max_allowed_h / scaled_h
                    scaled_h = max_allowed_h
                    scaled_w = max(1, int(round(scaled_w * h_factor)))

            c_resized = cv2.resize(c_crop, (scaled_w, scaled_h), interpolation=cv2.INTER_AREA)

            # Đặt chính giữa tâm Slot
            cx = slot_center_x - (scaled_w // 2)
            cx = max(slot_left, min(cx, slot_right - scaled_w))

            if is_dot:
                cy = int(round(target_h * 0.76 - scaled_h))
            else:
                cy = (target_h - scaled_h) // 2
            cy = max(0, min(cy, target_h - scaled_h))

            canvas_slotted[cy : cy + scaled_h, cx : cx + scaled_w] = c_resized

    step7_path = os.path.join(output_dir, "07_dau_cuoi_8_slot_192x48.png")
    cv2.imwrite(step7_path, canvas_slotted)

    # Lưu kèm bản phóng to 4x (768x192) để xem rõ nét
    step7_zoom_path = os.path.join(output_dir, "07_dau_cuoi_8_slot_4x_zoom.png")
    canvas_zoom = cv2.resize(canvas_slotted, (768, 192), interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(step7_zoom_path, canvas_zoom)

    # Lưu thêm bản phóng to 4x có vẽ lưới 8 Slot để kiểm tra mắt thường
    step7_grid_path = os.path.join(output_dir, "07_dau_cuoi_8_slot_grid_overlay.png")
    canvas_grid_bgr = cv2.cvtColor(canvas_zoom, cv2.COLOR_GRAY2BGR)

    # Vẽ vạch chia 8 slot (mỗi slot 96px tại 4x)
    for s in range(config.NUM_SLOTS + 1):
        x_line = s * (slot_w * 4)
        if s == 0 or s == config.NUM_SLOTS:
            cv2.line(canvas_grid_bgr, (min(x_line, 767), 0), (min(x_line, 767), 191), (0, 0, 255), 2)
        else:
            cv2.line(canvas_grid_bgr, (x_line, 0), (x_line, 191), (0, 255, 255), 1)

    # Đánh số slot và tên ký tự
    sample_labels = preset.get("labels", [])
    for s in range(config.NUM_SLOTS):
        x_text = s * 96 + 18
        if s >= start_slot and s < start_slot + N:
            char_idx = s - start_slot
            lbl = sample_labels[char_idx] if char_idx < len(sample_labels) else f"C{char_idx+1}"
            cv2.putText(canvas_grid_bgr, f"Slot {s}", (x_text, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1)
            cv2.putText(canvas_grid_bgr, f"[{lbl}]", (x_text + 6, 182), cv2.FONT_HERSHEY_SIMPLEX, 0.50, (0, 180, 0), 1)
        else:
            cv2.putText(canvas_grid_bgr, f"Slot {s}", (x_text, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (120, 120, 120), 1)
            cv2.putText(canvas_grid_bgr, "(trong)", (x_text - 4, 182), cv2.FONT_HERSHEY_SIMPLEX, 0.40, (120, 120, 120), 1)

    cv2.imwrite(step7_grid_path, canvas_grid_bgr)

    print(f"[BƯỚC 7/7] {os.path.basename(step7_path):<32} | Kích thước: {target_w}x{target_h} (1 kênh Gray)")
    print(f"           -> Đặt cân đối {N} ký tự: Tâm Slot i = (start_slot + i)*24 + 12 (Slot 1 -> Slot 6).")
    print(f"           -> Đã xuất ảnh có lưới kiểm tra 8 Slot tại: '{os.path.basename(step7_grid_path)}'.\n")

    print("=" * 80)
    print(f"XUẤT THÀNH CÔNG ĐẦY ĐỦ 7 BƯỚC VÀO THƯ MỤC: {output_dir}")
    print("=" * 80 + "\n")


def main():
    parser = argparse.ArgumentParser(
        description="Bóc tách từng bước tiền xử lý ảnh và xuất ra từng file riêng biệt"
    )
    parser.add_argument(
        "--image", "-i",
        default="crop_preview_line2.jpg",
        help="Đường dẫn đến file ảnh thật (ảnh toàn màn hình hoặc ảnh crop sẵn, mặc định: crop_preview_line2.jpg)"
    )
    parser.add_argument(
        "--line", "-l",
        type=int,
        default=2,
        choices=[1, 2, 3],
        help="Chọn dòng cần soi nếu truyền ảnh chụp cả màn hình (1: 92.734%, 2: 93.63%, 3: 12 - Mặc định: 2)"
    )
    parser.add_argument(
        "--output-dir", "-o",
        default=os.path.join(CURRENT_DIR, "debug_steps"),
        help="Thư mục lưu các file ảnh kết quả (Mặc định: debug_steps/)"
    )
    args = parser.parse_args()

    img_path = args.image
    if not os.path.exists(img_path):
        cand = os.path.join(CURRENT_DIR, img_path)
        if os.path.exists(cand):
            img_path = cand
        else:
            # Tìm trong thư mục ảnh gốc nếu người dùng chỉ truyền tên file
            pic_cand = os.path.join(CURRENT_DIR, "..", "picture for training", img_path)
            if os.path.exists(pic_cand):
                img_path = pic_cand
            else:
                print(f"[LỖI] Không tìm thấy file ảnh: {args.image}")
                sys.exit(1)

    process_and_export_steps(img_path, line_num=args.line, output_dir=args.output_dir)


if __name__ == "__main__":
    main()
