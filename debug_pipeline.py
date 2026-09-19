"""
Script trực quan hóa toàn bộ các bước tiền xử lý ảnh (Preprocessing Pipeline Dashboard).
Phân tích chi tiết từ ảnh camera gốc đến input của mạng nơ-ron và 8 slot grid.

Đầu ra: debug_preprocessing_steps.png
"""

import argparse
import os
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Thêm thư mục hiện tại vào sys.path
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import config

import tensorflow as tf

# Tắt bớt log thừa của TensorFlow
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"


# ==============================================================================
# HÀM HỖ TRỢ NẠP FONT & MODEL
# ==============================================================================
def load_font(size, bold=False):
    """Nạp font TrueType hỗ trợ tiếng Việt có sẵn trong fonts/ hoặc hệ thống."""
    fonts_dir = os.path.join(CURRENT_DIR, config.FONTS_DIR)
    candidates = [
        os.path.join(fonts_dir, "arialbd.ttf" if bold else "arial.ttf"),
        os.path.join(fonts_dir, "segoeuib.ttf" if bold else "segoeui.ttf"),
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                pass
    return ImageFont.load_default()


def get_model_path(custom_path=None):
    """Tìm đường dẫn file model."""
    if custom_path and os.path.exists(custom_path):
        return custom_path

    model_dir = os.path.join(CURRENT_DIR, config.MODEL_DIR)
    keras_path = os.path.join(model_dir, "screen_digit_ocr.keras")
    h5_path = os.path.join(model_dir, "screen_digit_ocr.h5")

    if os.path.exists(keras_path):
        return keras_path
    if os.path.exists(h5_path):
        return h5_path

    raise FileNotFoundError(f"Không tìm thấy model trong '{model_dir}'.")


def decode_class_id(class_id):
    """Chuyển class_id sang ký tự hiển thị."""
    if class_id == config.BLANK_INDEX:
        return "(trống)"
    if 0 <= class_id < len(config.CHARSET):
        return config.CHARSET[class_id]
    return "?"


def predict_image(model, img_192x48):
    """Dự đoán chuỗi số từ ảnh kích thước 192x48."""
    tensor = img_192x48.astype(np.float32).reshape(1, config.IMG_HEIGHT, config.IMG_WIDTH, 1)
    preds = model.predict(tensor, verbose=0)
    if not isinstance(preds, list):
        preds = [preds]

    slot_results = []
    clean_chars = []
    for i in range(config.NUM_SLOTS):
        prob_dist = preds[i][0] if preds[i].ndim > 1 else preds[i]
        top_id = int(np.argmax(prob_dist))
        conf = float(prob_dist[top_id])
        char_disp = decode_class_id(top_id)

        if top_id != config.BLANK_INDEX:
            clean_chars.append(char_disp)

        slot_results.append({
            "slot": i,
            "char": char_disp,
            "confidence": conf
        })

    predicted_string = "".join(clean_chars)
    return predicted_string, slot_results


# ==============================================================================
# HÀM XỬ LÝ RESIZE GIỮ TỶ LỆ (LETTERBOX / PAD)
# ==============================================================================
def letterbox_resize(img_gray, target_w=192, target_h=48):
    """
    Resize giữ nguyên tỷ lệ khung hình:
    - Thu nhỏ hình ảnh về chiều rộng 192 (chiều cao ~34px)
    - Thêm đệm viền xám đồng màu nền vào trên & dưới để đủ 48px.
    """
    h, w = img_gray.shape[:2]
    scale = min(target_w / w, target_h / h)
    new_w = int(round(w * scale))
    new_h = int(round(h * scale))

    resized = cv2.resize(img_gray, (new_w, new_h), interpolation=cv2.INTER_AREA)

    # Lấy màu nền mẫu từ 4 góc của ảnh
    corner_vals = [int(img_gray[0, 0]), int(img_gray[0, -1]), int(img_gray[-1, 0]), int(img_gray[-1, -1])]
    bg_val = int(np.median(corner_vals))

    canvas = np.full((target_h, target_w), bg_val, dtype=np.uint8)
    pad_y = (target_h - new_h) // 2
    pad_x = (target_w - new_w) // 2
    canvas[pad_y : pad_y + new_h, pad_x : pad_x + new_w] = resized

    return canvas, (new_w, new_h), (pad_x, pad_y)


# ==============================================================================
# QUY TRÌNH TỔNG HỢP DASHBOARD
# ==============================================================================
def generate_preprocessing_dashboard(full_image_path, model_path, output_path):
    print(f"[1/5] Đang nạp ảnh camera gốc: {full_image_path}")
    full_bgr = cv2.imread(str(full_image_path))
    if full_bgr is None:
        try:
            arr = np.fromfile(str(full_image_path), dtype=np.uint8)
            full_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        except Exception:
            full_bgr = None

    if full_bgr is None:
        raise FileNotFoundError(f"Không thể mở ảnh gốc: {full_image_path}")

    full_h, full_w = full_bgr.shape[:2]

    # Tọa độ Dòng 2 (Y=2121:2448, X=460:2304)
    ymin, ymax = 2121, 2448
    xmin, xmax = 460, 2304
    crop_h = ymax - ymin
    crop_w = xmax - xmin
    crop_ratio = crop_w / crop_h

    print(f"[2/5] Cắt vùng Dòng 2: Y=[{ymin}:{ymax}], X=[{xmin}:{xmax}] (Kích thước: {crop_w}x{crop_h}, Tỷ lệ: {crop_ratio:.2f}:1)")
    crop_bgr = full_bgr[ymin:ymax, xmin:xmax]
    crop_gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)

    # Cách A: Resize trực tiếp (ép co ngang)
    img_direct_192 = cv2.resize(crop_gray, (config.IMG_WIDTH, config.IMG_HEIGHT), interpolation=cv2.INTER_AREA)

    # Cách B: Letterbox pad (giữ tỷ lệ)
    img_letterbox_192, (lb_w, lb_h), (lb_px, lb_py) = letterbox_resize(crop_gray, config.IMG_WIDTH, config.IMG_HEIGHT)

    # Dự đoán model cho cả 2 cách
    print(f"[3/5] Nạp model và dự đoán: {model_path}")
    model = tf.keras.models.load_model(model_path, compile=False)

    pred_direct_str, slots_direct = predict_image(model, img_direct_192)
    pred_letterbox_str, slots_letterbox = predict_image(model, img_letterbox_192)

    print(f"  -> Dự đoán Cách A (Ép thẳng)     : \"{pred_direct_str}\"")
    print(f"  -> Dự đoán Cách B (Giữ đúng tỷ lệ): \"{pred_letterbox_str}\"")

    # ==========================================================================
    # BẮT ĐẦU VẼ INFOGRAPHIC DASHBOARD
    # ==========================================================================
    print("[4/5] Đang thiết kế ảnh Dashboard tổng hợp...")
    DASH_W = 960
    DASH_H = 1680

    bg_canvas = np.full((DASH_H, DASH_W, 3), (22, 26, 32), dtype=np.uint8)  # Nền tối công nghệ
    canvas_pil = Image.fromarray(cv2.cvtColor(bg_canvas, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(canvas_pil)

    # Fonts
    f_title = load_font(23, bold=True)
    f_sub = load_font(13, bold=False)
    f_card_h = load_font(15, bold=True)
    f_badge = load_font(12, bold=True)
    f_body = load_font(12, bold=False)
    f_slot_lbl = load_font(11, bold=True)
    f_slot_val = load_font(22, bold=True)
    f_slot_conf = load_font(11, bold=False)

    curr_y = 20

    # --- BANNER TIÊU ĐỀ ---
    draw.text((30, curr_y), "SCREEN DIGIT OCR — TRỰC QUAN HÓA TOÀN BỘ BƯỚC TIỀN XỬ LÝ (PREPROCESSING)", fill=(0, 215, 255), font=f_title)
    curr_y += 32
    info_sub = f"Ảnh: {os.path.basename(full_image_path)} | Vùng: Dòng 2 (93.63%) | Target: {config.IMG_WIDTH}x{config.IMG_HEIGHT}px | Model: 8 Slots"
    draw.text((30, curr_y), info_sub, fill=(165, 180, 200), font=f_sub)
    curr_y += 28

    draw.line([(30, curr_y), (DASH_W - 30, curr_y)], fill=(50, 60, 75), width=1)
    curr_y += 16

    # ==========================================================================
    # KHUNG 1: VỊ TRÍ CẮT TRÊN ẢNH GỐC
    # ==========================================================================
    card_w = DASH_W - 60
    draw.rectangle([30, curr_y, 30 + card_w, curr_y + 240], fill=(28, 33, 42), outline=(55, 68, 85), width=1)
    draw.text((45, curr_y + 10), "KHUNG 1 — VỊ TRÍ CẮT TRÊN ẢNH CAMERA GỐC (FULL FRAME)", fill=(255, 255, 255), font=f_card_h)

    # Thu nhỏ ảnh camera gốc hiển thị trong khung
    thumb_h = 185
    thumb_w = int(full_w * (thumb_h / full_h))  # 3072 * (185/4080) ~ 139 px
    full_thumb = cv2.resize(full_bgr, (thumb_w, thumb_h), interpolation=cv2.INTER_AREA)

    # Tọa độ khung chữ nhật đỏ trên ảnh thu nhỏ
    sy = thumb_h / full_h
    sx = thumb_w / full_w
    box_ymin = int(ymin * sy)
    box_ymax = int(ymax * sy)
    box_xmin = int(xmin * sx)
    box_xmax = int(xmax * sx)
    cv2.rectangle(full_thumb, (box_xmin, box_ymin), (box_xmax, box_ymax), (0, 0, 255), 2)

    thumb_rgb = cv2.cvtColor(full_thumb, cv2.COLOR_BGR2RGB)
    canvas_pil.paste(Image.fromarray(thumb_rgb), (45, curr_y + 40))

    # Thông tin chú thích bên phải ảnh thu nhỏ
    info_x = 45 + thumb_w + 30
    draw.text((info_x, curr_y + 45), f"• Độ phân giải ảnh camera: {full_w} x {full_h} pixel (12.5 MP)", fill=(210, 225, 245), font=f_body)
    draw.text((info_x, curr_y + 70), f"• Tọa độ hộp cắt Dòng 2 : Y=[{ymin} : {ymax}], X=[{xmin} : {xmax}]", fill=(255, 205, 100), font=f_body)
    draw.text((info_x, curr_y + 95), f"• Kích thước vùng số     : Rộng {crop_w}px  x  Cao {crop_h}px", fill=(210, 225, 245), font=f_body)
    draw.text((info_x, curr_y + 120), f"• Tỷ lệ khung hình gốc   : {crop_ratio:.2f} : 1  (rộng gấp 5.64 lần cao)", fill=(0, 215, 255), font=f_body)
    draw.text((info_x, curr_y + 145), "• Khung màu đỏ chỉ rõ vị trí thanh audit meters trên màn hình LCD máy slot.", fill=(160, 175, 195), font=f_body)

    curr_y += 256

    # ==========================================================================
    # KHUNG 2: VÙNG CẮT NGUYÊN BẢN (RAW CROP)
    # ==========================================================================
    draw.rectangle([30, curr_y, 30 + card_w, curr_y + 145], fill=(28, 33, 42), outline=(55, 68, 85), width=1)
    draw.text((45, curr_y + 8), f"KHUNG 2 — VÙNG CẮT NGUYÊN BẢN (Raw Crop): {crop_w}x{crop_h} px | Aspect Ratio = {crop_ratio:.2f}:1", fill=(255, 255, 255), font=f_card_h)

    # Hiển thị ảnh raw crop vừa chiều ngang card (768px wide)
    disp_w = 820
    disp_h = int(crop_h * (disp_w / crop_w))  # ~145 px
    disp_h_fit = min(95, disp_h)
    disp_w_fit = int(crop_w * (disp_h_fit / crop_h))
    raw_disp = cv2.resize(crop_bgr, (disp_w_fit, disp_h_fit), interpolation=cv2.INTER_AREA)
    raw_rgb = cv2.cvtColor(raw_disp, cv2.COLOR_BGR2RGB)
    canvas_pil.paste(Image.fromarray(raw_rgb), (45, curr_y + 36))

    curr_y += 160

    # ==========================================================================
    # KHUNG 3: ẢNH MỨC XÁM (GRAYSCALE)
    # ==========================================================================
    draw.rectangle([30, curr_y, 30 + card_w, curr_y + 145], fill=(28, 33, 42), outline=(55, 68, 85), width=1)
    draw.text((45, curr_y + 8), "KHUNG 3 — ẢNH MỨC XÁM (Grayscale 1 kênh): Kiểm tra độ tương phản giữa chữ và vân sọc LCD", fill=(255, 255, 255), font=f_card_h)

    gray_disp = cv2.resize(crop_gray, (disp_w_fit, disp_h_fit), interpolation=cv2.INTER_AREA)
    gray_rgb = cv2.cvtColor(gray_disp, cv2.COLOR_GRAY2RGB)
    canvas_pil.paste(Image.fromarray(gray_rgb), (45, curr_y + 36))

    curr_y += 160

    # ==========================================================================
    # KHUNG 4: ẢNH SAU KHI RESIZE VỀ 192x48 (PHÓNG TO 4X: 768x192)
    # ==========================================================================
    draw.rectangle([30, curr_y, 30 + card_w, curr_y + 245], fill=(28, 33, 42), outline=(55, 68, 85), width=1)
    draw.text((45, curr_y + 8), "KHUNG 4 — ẢNH SAU KHI RESIZE VỀ 192x48 (Phóng to 4x: 768x192 px để nhìn rõ)", fill=(255, 255, 255), font=f_card_h)
    draw.text((45, curr_y + 28), "⚠️ LƯU Ý QUAN TRỌNG: Ảnh bị ép co ngang từ tỷ lệ 5.64:1 về 4.0:1 khiến các con số bị bóp hẹp lại.", fill=(255, 165, 2), font=f_sub)

    img_direct_4x = cv2.resize(img_direct_192, (768, 192), interpolation=cv2.INTER_NEAREST)
    img_direct_4x_rgb = cv2.cvtColor(img_direct_4x, cv2.COLOR_GRAY2RGB)
    canvas_pil.paste(Image.fromarray(img_direct_4x_rgb), (45, curr_y + 46))

    curr_y += 260

    # ==========================================================================
    # KHUNG 5: SO SÁNH 2 CÁCH RESIZE
    # ==========================================================================
    draw.rectangle([30, curr_y, 30 + card_w, curr_y + 195], fill=(28, 33, 42), outline=(55, 68, 85), width=1)
    draw.text((45, curr_y + 8), "KHUNG 5 — SO SÁNH 2 CÁCH RESIZE: ÉP THẲNG (CÁCH A) vs GIỮ ĐÚNG TỶ LỆ (CÁCH B)", fill=(255, 255, 255), font=f_card_h)

    # Bảng so sánh 2 cột
    col_w = (card_w - 30) // 2
    c1_x = 45
    c2_x = 45 + col_w + 10

    # Cột A
    draw.rectangle([c1_x, curr_y + 32, c1_x + col_w, curr_y + 180], fill=(35, 42, 54), outline=(70, 85, 105), width=1)
    draw.text((c1_x + 12, curr_y + 38), "Cách A: Ép thẳng về 192x48 (Bị méo ngang)", fill=(255, 110, 110), font=f_badge)
    disp_a = cv2.resize(img_direct_192, (col_w - 24, 76), interpolation=cv2.INTER_NEAREST)
    canvas_pil.paste(Image.fromarray(cv2.cvtColor(disp_a, cv2.COLOR_GRAY2RGB)), (c1_x + 12, curr_y + 58))
    draw.text((c1_x + 12, curr_y + 142), f"-> Model đoán: \"{pred_direct_str}\"", fill=(255, 220, 100), font=f_badge)
    draw.text((c1_x + 12, curr_y + 160), "Tỷ lệ biến dạng: Chữ bị co hẹp 29% chiều ngang", fill=(170, 185, 205), font=f_slot_conf)

    # Cột B
    draw.rectangle([c2_x, curr_y + 32, c2_x + col_w, curr_y + 180], fill=(35, 42, 54), outline=(70, 85, 105), width=1)
    draw.text((c2_x + 12, curr_y + 38), "Cách B: Giữ đúng tỷ lệ (Pad viền xám 7px trên/dưới)", fill=(46, 213, 115), font=f_badge)
    disp_b = cv2.resize(img_letterbox_192, (col_w - 24, 76), interpolation=cv2.INTER_NEAREST)
    canvas_pil.paste(Image.fromarray(cv2.cvtColor(disp_b, cv2.COLOR_GRAY2RGB)), (c2_x + 12, curr_y + 58))
    draw.text((c2_x + 12, curr_y + 142), f"-> Model đoán: \"{pred_letterbox_str}\"", fill=(100, 255, 150), font=f_badge)
    draw.text((c2_x + 12, curr_y + 160), "Tỷ lệ chuẩn: Chữ giữ nguyên hình dạng vuông vắn tự nhiên", fill=(170, 185, 205), font=f_slot_conf)

    curr_y += 210

    # ==========================================================================
    # KHUNG 6: BẢN ĐỒ 8 Ô SLOT (SLOT GRID OVERLAY)
    # ==========================================================================
    draw.rectangle([30, curr_y, 30 + card_w, curr_y + 335], fill=(28, 33, 42), outline=(55, 68, 85), width=1)
    draw.text((45, curr_y + 8), "KHUNG 6 — BẢN ĐỒ 8 Ô SLOT (SLOT GRID OVERLAY): Xem từng ký tự rơi vào ô nào", fill=(255, 255, 255), font=f_card_h)

    grid_img_w = 768
    grid_img_h = 192
    grid_slot_w = grid_img_w // config.NUM_SLOTS  # 96px

    grid_render = cv2.resize(img_direct_192, (grid_img_w, grid_img_h), interpolation=cv2.INTER_NEAREST)
    grid_render_rgb = cv2.cvtColor(grid_render, cv2.COLOR_GRAY2RGB)

    # Kẻ 8 đường vạch đứng đỏ chia đều
    for i in range(config.NUM_SLOTS + 1):
        lx = min(grid_img_w - 1, i * grid_slot_w)
        cv2.line(grid_render_rgb, (lx, 0), (lx, grid_img_h), (255, 40, 40), 2)

    # Khung viền đỏ
    cv2.rectangle(grid_render_rgb, (0, 0), (grid_img_w - 1, grid_img_h - 1), (255, 40, 40), 2)

    grid_x0 = 45
    grid_y0 = curr_y + 50

    # Vẽ nhãn Slot 0 -> Slot 7 trên đầu
    for i in range(config.NUM_SLOTS):
        sx0 = grid_x0 + i * grid_slot_w
        draw.rectangle([sx0 + 1, curr_y + 28, sx0 + grid_slot_w - 1, curr_y + 48], fill=(42, 54, 72))
        draw.text((sx0 + 14, curr_y + 31), f"Slot {i} [{i*24}:{(i+1)*24}]", fill=(180, 225, 255), font=f_slot_lbl)

    canvas_pil.paste(Image.fromarray(grid_render_rgb), (grid_x0, grid_y0))

    # In kết quả model đoán ngay dưới từng ô
    box_res_y = grid_y0 + grid_img_h + 4
    for s in slots_direct:
        i = s["slot"]
        sx0 = grid_x0 + i * grid_slot_w
        conf_pct = s["confidence"] * 100.0

        if conf_pct >= 80:
            border_c = (46, 213, 115)
            text_c = (46, 213, 115)
        elif conf_pct >= 50:
            border_c = (255, 165, 2)
            text_c = (255, 165, 2)
        else:
            border_c = (255, 71, 87)
            text_c = (255, 71, 87)

        draw.rectangle([sx0 + 1, box_res_y, sx0 + grid_slot_w - 1, box_res_y + 50],
                       fill=(32, 38, 48), outline=border_c, width=1)
        draw.text((sx0 + 36, box_res_y + 2), s["char"], fill=text_c, font=f_slot_val)
        draw.text((sx0 + 26, box_res_y + 32), f"{conf_pct:.1f}%", fill=(180, 195, 210), font=f_slot_conf)

    # Dòng kết quả tổng kết
    sum_y = box_res_y + 56
    draw.text((45, sum_y), f"-> KẾT QUẢ ĐỌC CHUỖI CUỐI CÙNG:  \"{pred_direct_str}\"", fill=(0, 215, 255), font=f_card_h)

    # 5. Lưu ảnh hoàn chỉnh
    print(f"[5/5] Đang lưu ảnh Dashboard vào: {output_path}")
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    canvas_pil.save(output_path, quality=95)

    print("\n" + "=" * 65)
    print("HOÀN TẤT XUẤT ẢNH DASHBOARD PREPROCESSING:")
    print(f"  -> File lưu: {output_path}")
    print("=" * 65 + "\n")


def main():
    parser = argparse.ArgumentParser(
        description="Debug Preprocessing Pipeline - Trực quan hóa các bước tiền xử lý ảnh",
        formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument(
        "--full-image",
        default="../picture for training/PXL_20260901_025922291.jpg",
        help="Đường dẫn ảnh camera gốc (mặc định: ../picture for training/PXL_20260901_025922291.jpg)"
    )
    parser.add_argument(
        "--output", "-o",
        default="debug_preprocessing_steps.png",
        help="Đường dẫn lưu ảnh dashboard (mặc định: debug_preprocessing_steps.png)"
    )
    parser.add_argument(
        "--model", "-m",
        default=None,
        help="Đường dẫn model (.keras hoặc .h5). Mặc định tự tìm trong models/"
    )
    args = parser.parse_args()

    # Tìm ảnh gốc
    img_path = args.full_image
    if not os.path.exists(img_path):
        # Thử đường dẫn cùng cấp
        cand = os.path.join(CURRENT_DIR, img_path)
        if os.path.exists(cand):
            img_path = cand
        else:
            cand2 = os.path.join(os.path.dirname(CURRENT_DIR), "picture for training", "PXL_20260901_025922291.jpg")
            if os.path.exists(cand2):
                img_path = cand2
            else:
                print(f"[LỖI] Không tìm thấy ảnh camera gốc: {args.full_image}")
                sys.exit(1)

    # Tìm model
    try:
        model_file = get_model_path(args.model)
    except Exception as e:
        print(f"[LỖI MODEL] {e}")
        sys.exit(1)

    generate_preprocessing_dashboard(img_path, model_file, args.output)


if __name__ == "__main__":
    main()
