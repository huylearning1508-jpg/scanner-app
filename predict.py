"""
Script nhận diện chuỗi số từ ảnh sử dụng model đã huấn luyện (Screen Digit OCR).
Không dùng GUI/cv2.imshow để chạy mượt mà trên môi trường Linux/WSL.

Tính năng:
  1. Cắt vùng ảnh linh hoạt bằng tham số: --crop y1 y2 x1 x2 (tỷ lệ 0.0 -> 1.0)
     Tự động lưu ảnh vùng cắt ra file: crop_preview.jpg để kiểm tra mắt thường.
  2. Chế độ quét nhanh các dòng định sẵn: --presets
     Tự động cắt và đọc 3 dòng chính trên ảnh màn hình máy slot.

Ví dụ sử dụng:
  # Cắt theo tỷ lệ y1 y2 x1 x2:
  python3 predict.py --image "../picture for training/PXL_20260901_025922291.jpg" --crop 0.43 0.51 0.15 0.75

  # Quét tự động 3 dòng định sẵn:
  python3 predict.py --image "../picture for training/PXL_20260901_025922291.jpg" --presets
"""

import argparse
import os
import sys
from pathlib import Path

import numpy as np

# Thư mục chứa script
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import config

try:
    import cv2
except ImportError:
    print("\n[LỖI] Chưa cài đặt OpenCV. Hãy chạy: pip install opencv-python\n")
    sys.exit(1)

import tensorflow as tf

# Tắt log cảnh báo của TensorFlow
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"


# Danh sách 3 dòng định sẵn theo tỷ lệ màn hình
PRESET_LINES = [
    {
        "name": "Dòng 1 (khoảng 92.734%)",
        "y1": 0.43, "y2": 0.51, "x1": 0.10, "x2": 0.75,
        "preview_file": "crop_preview_line1.jpg"
    },
    {
        "name": "Dòng 2 (khoảng 93.63%)",
        "y1": 0.52, "y2": 0.60, "x1": 0.15, "x2": 0.75,
        "preview_file": "crop_preview_line2.jpg"
    },
    {
        "name": "Dòng 3 (khoảng 12)",
        "y1": 0.63, "y2": 0.70, "x1": 0.25, "x2": 0.75,
        "preview_file": "crop_preview_line3.jpg"
    }
]


def get_model_path(custom_path=None):
    """Tìm đường dẫn file model .keras hoặc .h5."""
    if custom_path:
        if os.path.exists(custom_path):
            return custom_path
        raise FileNotFoundError(f"Không tìm thấy model tại: {custom_path}")

    model_dir = os.path.join(CURRENT_DIR, config.MODEL_DIR)
    keras_path = os.path.join(model_dir, "screen_digit_ocr.keras")
    h5_path = os.path.join(model_dir, "screen_digit_ocr.h5")

    if os.path.exists(keras_path):
        return keras_path
    if os.path.exists(h5_path):
        return h5_path

    raise FileNotFoundError(
        f"Không tìm thấy file model nào trong '{model_dir}'.\n"
        f"Cần ít nhất một trong hai file: 'screen_digit_ocr.keras' hoặc 'screen_digit_ocr.h5'."
    )


def load_image(image_path):
    """Đọc ảnh từ đường dẫn (hỗ trợ cả đường dẫn Windows và Linux)."""
    img_str = str(image_path)
    img = cv2.imread(img_str, cv2.IMREAD_COLOR)
    if img is None:
        try:
            img_array = np.fromfile(img_str, dtype=np.uint8)
            img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
        except Exception:
            img = None

    if img is None:
        raise ValueError(f"Không thể mở file ảnh: {image_path}")
    return img


def crop_by_ratio(image, y1, y2, x1, x2):
    """
    Cắt ảnh theo tỷ lệ (0.0 -> 1.0):
      ymin = int(y1 * H), ymax = int(y2 * H)
      xmin = int(x1 * W), xmax = int(x2 * W)
    """
    H, W = image.shape[:2]
    ymin = max(0, min(int(y1 * H), H - 1))
    ymax = max(ymin + 1, min(int(y2 * H), H))
    xmin = max(0, min(int(x1 * W), W - 1))
    xmax = max(xmin + 1, min(int(x2 * W), W))

    cropped = image[ymin:ymax, xmin:xmax]
    return cropped, (ymin, ymax, xmin, xmax), (H, W)


def letterbox_resize(img_gray, target_w=192, target_h=48):
    """Dự phòng: Resize giữ nguyên tỷ lệ khung hình có đệm viền xám."""
    h, w = img_gray.shape[:2]
    scale = min(target_w / w, target_h / h)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    resized = cv2.resize(img_gray, (new_w, new_h), interpolation=cv2.INTER_AREA)

    border_pixels = np.concatenate([resized[0, :], resized[-1, :], resized[:, 0], resized[:, -1]])
    bg_val = int(np.median(border_pixels))
    canvas = np.full((target_h, target_w), bg_val, dtype=np.uint8)
    pad_y = (target_h - new_h) // 2
    pad_x = (target_w - new_w) // 2
    canvas[pad_y : pad_y + new_h, pad_x : pad_x + new_w] = resized
    return canvas


def segment_characters_by_vpp(img_gray):
    """
    Sử dụng thuật toán Vertical Projection Profile (VPP):
    1. Lọc nhiễu và nhị phân hóa (Otsu THRESH_BINARY_INV) tách nét chữ tối màu khỏi nền sáng.
    2. Chiếu tổng độ sáng theo cột dọc (Vertical Projection).
    3. Cột nào không có pixel nét chữ -> khe hở phân cách.
    4. Trích xuất bounding box của từng ký tự riêng lẻ từ trái qua phải.
    """
    blur = cv2.GaussianBlur(img_gray, (5, 5), 0)
    _, thresh = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Chiếu tổng số pixel chữ theo từng cột dọc
    v_proj = np.sum(thresh == 255, axis=0)

    # Ngưỡng phát hiện cột có chữ
    min_col_pixels = max(2, int(img_gray.shape[0] * 0.015))
    is_text = v_proj > min_col_pixels

    # Tìm các đoạn ký tự liên tục
    segments = []
    in_seg = False
    start = 0
    for i, val in enumerate(is_text):
        if val and not in_seg:
            in_seg = True
            start = i
        elif not val and in_seg:
            in_seg = False
            if i - start >= 4:  # Bỏ qua nhiễu hạt siêu nhỏ < 4px
                segments.append((start, i))
    if in_seg and len(is_text) - start >= 4:
        segments.append((start, len(is_text)))

    # Hợp nhất các đoạn quá gần nhau (<= 2 pixel)
    merged_segments = []
    for s, e in segments:
        if not merged_segments:
            merged_segments.append([s, e])
        else:
            prev_s, prev_e = merged_segments[-1]
            if s - prev_e <= 2:
                merged_segments[-1][1] = e
            else:
                merged_segments.append([s, e])

    # Cắt Bounding Box chính xác cho từng ký tự
    char_crops = []
    for (s, e) in merged_segments:
        col_slice = thresh[:, s:e]
        rows_with_text = np.where(np.sum(col_slice == 255, axis=1) > 0)[0]
        if len(rows_with_text) == 0:
            continue
        y_top, y_bot = rows_with_text[0], rows_with_text[-1]

        y_top = max(0, y_top - 1)
        y_bot = min(img_gray.shape[0] - 1, y_bot + 1)
        s_pad = max(0, s - 1)
        e_pad = min(img_gray.shape[1], e + 1)

        char_crop = img_gray[y_top : y_bot + 1, s_pad : e_pad]
        char_crops.append((char_crop, (s_pad, e_pad, y_top, y_bot)))

    return char_crops


def place_characters_into_slots(img_gray, char_crops, num_slots=8, target_w=192, target_h=48):
    """
    Phân bổ chính xác từng ký tự vào 8 Slots:
    - Mỗi slot rộng 24px (192 / 8 = 24).
    - Đặt lần lượt từng ký tự vào trung tâm của các Slot liên tiếp.
    - Đảm bảo mỗi slot chứa ĐÚNG 1 KÝ TỰ, các ô thừa ở 2 bên giữ màu nền xám (ô trống).
    """
    border_pixels = np.concatenate([img_gray[0, :], img_gray[-1, :], img_gray[:, 0], img_gray[:, -1]])
    bg_val = int(np.median(border_pixels))

    canvas = np.full((target_h, target_w), bg_val, dtype=np.uint8)
    slot_w = target_w // num_slots  # 24px

    N = len(char_crops)
    if N == 0:
        return letterbox_resize(img_gray, target_w, target_h)

    # Giới hạn tối đa 8 ký tự
    if N > num_slots:
        char_crops = sorted(char_crops, key=lambda c: c[0].shape[0] * c[0].shape[1], reverse=True)[:num_slots]
        char_crops = sorted(char_crops, key=lambda c: c[1][0])
        N = len(char_crops)

    digit_heights = [c[0].shape[0] for c in char_crops if c[0].shape[0] > 40]
    max_digit_h = max(digit_heights) if digit_heights else max(c[0].shape[0] for c in char_crops)
    target_digit_h = 34  # Chiều cao chuẩn của chữ số trong ô 48px
    scale = target_digit_h / max(1.0, float(max_digit_h))

    # Căn chỉnh slot bắt đầu:
    # N = 6 (93.63%): Bắt đầu từ Slot 1 (Slots 1..6, Slot 0 và Slot 7 là ô trống)
    # N = 7 (92.734%): Bắt đầu từ Slot 0 (Slots 0..6)
    # N <= 3 (12): Bắt đầu từ Slot 6 (hoặc căn giữa)
    if N >= 7:
        start_slot = 0
    elif N == 6:
        start_slot = 1  # Slot 1 đến Slot 6
    elif N <= 3:
        start_slot = max(0, num_slots - N)
    else:
        start_slot = max(0, (num_slots - N) // 2)

    max_allowed_w = slot_w - 2   # 22px
    max_allowed_h = target_h - 6 # 42px

    for idx, (c_crop, info) in enumerate(char_crops):
        slot_idx = start_slot + idx
        if slot_idx >= num_slots:
            break

        # Tọa độ tâm X của slot đó: (start_slot + idx) * 24 + 12
        slot_center_x = slot_idx * slot_w + (slot_w // 2)
        slot_left = slot_idx * slot_w
        slot_right = slot_left + slot_w

        is_dot = (c_crop.shape[0] < 50 and c_crop.shape[1] < 50)
        is_pct = (info[1] - info[0] > 180 and c_crop.shape[0] > 140)

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

        # Đặt vào chính giữa Slot: cx = slot_center_x - scaled_w // 2
        cx = slot_center_x - (scaled_w // 2)
        cx = max(slot_left, min(cx, slot_right - scaled_w))

        if is_dot:
            cy = int(round(target_h * 0.76 - scaled_h))
        else:
            cy = (target_h - scaled_h) // 2
        cy = max(0, min(cy, target_h - scaled_h))

        canvas[cy : cy + scaled_h, cx : cx + scaled_w] = c_resized

    return canvas


def preprocess_for_model(cropped_img):
    """
    Tiền xử lý ảnh vùng cắt sử dụng Vertical Projection Profile (VPP):
    1. Đưa về Grayscale.
    2. Tách từng ký tự bằng phép chiếu đứng (Vertical Projection).
    3. Phân bổ lần lượt từng ký tự vào các slot riêng biệt trên canvas (192, 48),
       mỗi slot chứa ĐÚNG 1 KÝ TỰ, các ô thừa giữ màu nền xám.
    4. Reshape về (1, 48, 192, 1) float32, giữ nguyên dải [0, 255].
    """
    if len(cropped_img.shape) == 3 and cropped_img.shape[2] == 3:
        gray = cv2.cvtColor(cropped_img, cv2.COLOR_BGR2GRAY)
    else:
        gray = cropped_img

    # 1. Trích xuất từng ký tự bằng Vertical Projection Profile
    char_crops = segment_characters_by_vpp(gray)

    # 2. Phân bổ vào 8 slots độc lập
    vpp_canvas = place_characters_into_slots(gray, char_crops, config.NUM_SLOTS, config.IMG_WIDTH, config.IMG_HEIGHT)

    tensor = vpp_canvas.astype(np.float32).reshape(1, config.IMG_HEIGHT, config.IMG_WIDTH, 1)
    return tensor, vpp_canvas


def predict_tensor(model, tensor):
    """
    Suy luận và giải mã qua các đầu phân loại (NUM_SLOTS slots):
    - Slot có class_id == BLANK_INDEX -> ô trống (bỏ qua khi ghép chuỗi).
    - Ngược lại lấy ký tự trong CHARSET.
    """
    preds = model.predict(tensor, verbose=0)
    if not isinstance(preds, list):
        preds = [preds]

    slots_detail = []
    clean_chars = []
    raw_slots = []

    for i in range(config.NUM_SLOTS):
        prob_dist = preds[i][0] if preds[i].ndim > 1 else preds[i]
        class_id = int(np.argmax(prob_dist))
        confidence = float(prob_dist[class_id])

        if class_id == config.BLANK_INDEX:
            char_display = " "
            label_display = "(trống)"
        elif 0 <= class_id < len(config.CHARSET):
            char_display = config.CHARSET[class_id]
            label_display = f"'{char_display}'"
            clean_chars.append(char_display)
        else:
            char_display = "?"
            label_display = "'?'"

        raw_slots.append(char_display)
        slots_detail.append({
            "slot": i,
            "char": char_display,
            "label": label_display,
            "confidence": confidence
        })

    predicted_string = "".join(clean_chars)
    raw_string = "[" + " ".join(raw_slots) + "]"
    return predicted_string, raw_string, slots_detail


def print_result(title, pred_str, raw_str, slots_detail, crop_info=None, preview_path=None):
    """In kết quả nhận diện ra terminal."""
    print("=" * 65)
    print(f"Mục: {title}")
    if crop_info:
        ymin, ymax, xmin, xmax, H, W = crop_info
        print(f"  -> Tọa độ Pixel       : Y=[{ymin}:{ymax}], X=[{xmin}:{xmax}] (Ảnh gốc: {W}x{H})")
    if preview_path:
        print(f"  -> File ảnh vừa cắt   : {preview_path}")
    print(f"  -> Chuỗi số nhận diện : {pred_str if pred_str else '(trống hoàn toàn)'}")
    print(f"  -> Trạng thái {config.NUM_SLOTS} slots : {raw_str}")
    print("  -> Độ tin cậy từng slot:")
    for s in slots_detail:
        pct = s["confidence"] * 100.0
        print(f"     Slot {s['slot']}: {s['label']:<9} ({pct:6.2f}%)")


def collect_images(image_path_input):
    """Thu thập file ảnh từ đường dẫn truyền vào."""
    target_path = Path(image_path_input)
    if not target_path.exists():
        raise FileNotFoundError(f"Đường dẫn không tồn tại: {image_path_input}")

    valid_exts = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tiff"}

    if target_path.is_file():
        if target_path.suffix.lower() in valid_exts:
            return [target_path]
        raise ValueError(f"Định dạng file không hỗ trợ: {target_path.suffix}")

    elif target_path.is_dir():
        found = []
        for file in target_path.iterdir():
            if file.is_file() and file.suffix.lower() in valid_exts:
                found.append(file)
        return sorted(found)

    return []


def main():
    parser = argparse.ArgumentParser(
        description="Screen Digit OCR - Suy luận chuỗi số từ ảnh chụp màn hình",
        formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument(
        "--image", "-i",
        required=True,
        help="Đường dẫn file ảnh hoặc thư mục ảnh cần nhận diện"
    )
    parser.add_argument(
        "--crop", "-c",
        nargs=4,
        type=float,
        metavar=("Y1", "Y2", "X1", "X2"),
        default=None,
        help="Cắt theo tỷ lệ y1 y2 x1 x2 (từ 0.0 đến 1.0).\nVí dụ: --crop 0.43 0.51 0.15 0.75"
    )
    parser.add_argument(
        "--presets",
        action="store_true",
        help="Tự động quét và đọc 3 dòng định sẵn trên màn hình máy slot"
    )
    parser.add_argument(
        "--model", "-m",
        default=None,
        help="Đường dẫn file model (.keras hoặc .h5). Mặc định tìm trong models/"
    )
    args = parser.parse_args()

    # 1. Thu thập ảnh
    try:
        image_files = collect_images(args.image)
    except Exception as e:
        print(f"[LỖI ĐƯỜNG DẪN] {e}")
        sys.exit(1)

    if not image_files:
        print(f"[THÔNG BÁO] Không tìm thấy file ảnh hợp lệ nào trong '{args.image}'.")
        sys.exit(0)

    # 2. Nạp Model
    try:
        model_file = get_model_path(args.model)
        print(f"\n[KHỞI ĐỘNG] Đang nạp model từ: {model_file}")
        model = tf.keras.models.load_model(model_file, compile=False)
        print("[KHỞI ĐỘNG] Nạp model thành công!")
    except Exception as e:
        print(f"[LỖI NẠP MODEL] {e}")
        sys.exit(1)

    print(f"[DANH SÁCH] Có {len(image_files)} ảnh cần xử lý.\n")

    # 3. Duyệt và dự đoán từng ảnh
    for img_path in image_files:
        try:
            image = load_image(img_path)
        except Exception as e:
            print(f"[LỖI ĐỌC ẢNH] {img_path.name}: {e}")
            continue

        # TRƯỜNG HỢP 1: Quét 3 dòng định sẵn (--presets)
        if args.presets:
            print("\n" + "#" * 65)
            print(f"BẮT ĐẦU QUÉT PRESETS CHO ẢNH: {img_path.name}")
            print("#" * 65)

            for line in PRESET_LINES:
                cropped, (ymin, ymax, xmin, xmax), (H, W) = crop_by_ratio(
                    image, line["y1"], line["y2"], line["x1"], line["x2"]
                )

                # Tiền xử lý Letterbox (Cách B)
                tensor, letterboxed = preprocess_for_model(cropped)

                # Lưu ảnh letterbox đã đệm viền ra file preview để kiểm tra
                preview_file = line["preview_file"]
                cv2.imwrite(preview_file, letterboxed)

                # Dự đoán
                pred_str, raw_str, slots_detail = predict_tensor(model, tensor)

                print_result(
                    title=f"{img_path.name} -> {line['name']}",
                    pred_str=pred_str,
                    raw_str=raw_str,
                    slots_detail=slots_detail,
                    crop_info=(ymin, ymax, xmin, xmax, H, W),
                    preview_path=preview_file
                )
            continue

        # TRƯỜNG HỢP 2: Cắt theo tỷ lệ truyền vào (--crop y1 y2 x1 x2)
        if args.crop:
            y1, y2, x1, x2 = args.crop
            cropped, (ymin, ymax, xmin, xmax), (H, W) = crop_by_ratio(image, y1, y2, x1, x2)

            tensor, letterboxed = preprocess_for_model(cropped)

            # Lưu ảnh letterbox vừa xử lý ra crop_preview.jpg
            preview_file = "crop_preview.jpg"
            cv2.imwrite(preview_file, letterboxed)

            pred_str, raw_str, slots_detail = predict_tensor(model, tensor)

            print_result(
                title=f"{img_path.name} (Vùng cắt: y=[{y1}:{y2}], x=[{x1}:{x2}])",
                pred_str=pred_str,
                raw_str=raw_str,
                slots_detail=slots_detail,
                crop_info=(ymin, ymax, xmin, xmax, H, W),
                preview_path=preview_file
            )
            continue

        # TRƯỜNG HỢP 3: Không truyền crop hoặc presets (dự đoán cả ảnh)
        H, W = image.shape[:2]
        print(f"[CẢNH BÁO] Đang đọc toàn bộ ảnh ({W}x{H}).")
        print("          Khuyên dùng: --crop y1 y2 x1 x2 hoặc --presets")

        tensor, letterboxed = preprocess_for_model(image)

        preview_file = "crop_preview.jpg"
        cv2.imwrite(preview_file, letterboxed)

        pred_str, raw_str, slots_detail = predict_tensor(model, tensor)

        print_result(
            title=f"{img_path.name} (Toàn bộ ảnh)",
            pred_str=pred_str,
            raw_str=raw_str,
            slots_detail=slots_detail,
            preview_path=preview_file
        )

    print("\n" + "=" * 65)
    print("[HOÀN TẤT] Quá trình nhận diện kết thúc.\n")


if __name__ == "__main__":
    main()
