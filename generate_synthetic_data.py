"""
Chương trình All-in-One sinh dữ liệu huấn luyện OCR số màn hình máy slot (Screen Digit OCR).
Tự chứa toàn bộ quy trình: Sinh chuỗi, render ký tự và giả lập quang học camera điện thoại chụp LCD.
Không cần import gen_utils.

Đầu ra tự động:
  - data/synthetic/train.npz (25.000 mẫu)
  - data/synthetic/val.npz   (5.000 mẫu)
  - data/synthetic/preview.png (Ghép 20 ảnh mẫu đầu tiên dạng lưới để kiểm tra mắt thường)
"""

import argparse
import glob
import os
import random
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Thêm thư mục hiện tại vào sys.path để nạp config.py
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import config


# ==============================================================================
# 1. NẠP FONT CHỮ
# ==============================================================================
def load_all_fonts():
    """Nạp tất cả các file font .ttf / .otf từ thư mục fonts/."""
    fonts_dir = os.path.join(CURRENT_DIR, config.FONTS_DIR)
    font_paths = sorted(
        glob.glob(os.path.join(fonts_dir, "*.ttf")) +
        glob.glob(os.path.join(fonts_dir, "*.otf"))
    )

    if not font_paths:
        # Dự phòng các font hệ thống phổ biến nếu fonts/ trống
        system_candidates = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
            "/usr/share/fonts/truetype/freefont/FreeMonoBold.ttf",
            "C:/Windows/Fonts/arial.ttf",
            "C:/Windows/Fonts/segoeui.ttf",
        ]
        font_paths = [p for p in system_candidates if os.path.exists(p)]

    if not font_paths:
        raise RuntimeError(
            f"Không tìm thấy file font nào trong '{fonts_dir}'. "
            "Vui lòng đặt ít nhất 1 file .ttf (vd: arial.ttf) vào thư mục fonts/."
        )

    return font_paths


# ==============================================================================
# 2. HÀM SINH NỘI DUNG CHUỖI (TEXT GENERATOR)
# ==============================================================================
def generate_sample_text():
    """
    Sinh ngẫu nhiên chuỗi số thực tế trên màn hình máy slot theo tỷ lệ:
      - 40%: Chuỗi phần trăm (vd: "92.734%", "93.63%", "0.000%", "5.12%", "100.0%")
      - 30%: Chuỗi tiền tệ (vd: "$0.01", "$12.50", "$100", "$5.99", "$0.50")
      - 30%: Chuỗi số nguyên / số đếm (vd: "12", "1", "13", "100", "365")
    Độ dài tối đa 8 ký tự để khớp với 8 slots.
    """
    category = random.random()

    if category < 0.40:
        # --- 40% CHUỖI PHẦN TRĂM (%) ---
        sub = random.random()
        if sub < 0.50:
            # 3 chữ số thập phân: 92.734%, 0.000%, 88.125% (6-7 ký tự)
            int_part = random.randint(0, 99)
            dec_part = random.randint(0, 999)
            text = f"{int_part}.{dec_part:03d}%"
        elif sub < 0.80:
            # 2 chữ số thập phân: 93.63%, 5.12%, 12.50% (5-6 ký tự)
            int_part = random.randint(0, 99)
            dec_part = random.randint(0, 99)
            text = f"{int_part}.{dec_part:02d}%"
        elif sub < 0.95:
            # 1 chữ số thập phân hoặc 100.0%
            if random.random() < 0.15:
                text = "100.0%"
            else:
                int_part = random.randint(0, 99)
                dec_part = random.randint(0, 9)
                text = f"{int_part}.{dec_part}%"
        else:
            text = f"{random.randint(0, 100)}%"

    elif category < 0.70:
        # --- 30% CHUỖI TIỀN TỆ ($) ---
        sub = random.random()
        if sub < 0.45:
            # Tiền nhỏ: $0.01, $0.50, $0.25, $5.99
            if random.random() < 0.5:
                text = f"$0.{random.randint(1, 99):02d}"
            else:
                text = f"${random.randint(1, 9)}.{random.randint(0, 99):02d}"
        elif sub < 0.80:
            # Tiền có 2 số lẻ: $12.50, $99.99
            text = f"${random.randint(10, 99)}.{random.randint(0, 99):02d}"
        else:
            # Tiền chẵn: $1, $5, $10, $100, $500
            amt = random.choice([random.randint(1, 20), random.randint(25, 999)])
            text = f"${amt}"

    else:
        # --- 30% SỐ NGUYÊN / SỐ ĐẾM ---
        sub = random.random()
        if sub < 0.55:
            # 1-2 chữ số: 12, 1, 13, 25, 99
            text = str(random.randint(1, 99))
        elif sub < 0.85:
            # 3 chữ số: 100, 250, 365
            text = str(random.randint(100, 999))
        else:
            # 4-5 chữ số: 1000, 92734
            text = str(random.randint(1000, 99999))

    # Cắt gọn nếu chuỗi vượt quá số ô FORMAT (8)
    if len(text) > config.NUM_SLOTS:
        text = text[:config.NUM_SLOTS]

    return text


def create_slot_labels_and_alignment(text):
    """
    Phân bổ chuỗi vào 8 slot:
      - Căn phải (Right-align): ~50% (chuẩn cho số trên bảng)
      - Căn giữa (Center-align): ~35%
      - Căn trái (Left-align): ~10%
      - Lệch ngẫu nhiên: ~5%
    Ô không có ký tự được gán nhãn BLANK_INDEX (13).
    """
    n_slots = config.NUM_SLOTS
    n_chars = len(text)
    blanks = n_slots - n_chars

    align = random.random()
    if align < 0.50:
        # Căn phải
        left_blanks = blanks
    elif align < 0.85:
        # Căn giữa
        left_blanks = blanks // 2
    elif align < 0.95:
        # Căn trái
        left_blanks = 0
    else:
        # Lệch ngẫu nhiên
        left_blanks = random.randint(0, blanks)

    right_blanks = blanks - left_blanks
    slot_chars = [None] * left_blanks + list(text) + [None] * right_blanks

    # Mã hóa nhãn dạng số nguyên
    encoded_labels = np.array([
        config.BLANK_INDEX if c is None else config.CHARSET.index(c)
        for c in slot_chars
    ], dtype=np.int64)

    return slot_chars, encoded_labels


def letterbox_resize(img_gray, target_w=192, target_h=48):
    """
    Resize ảnh giữ nguyên tỷ lệ khung hình (Cách B - Letterbox / Pad):
    - Tính tỷ lệ scale sao cho ảnh vừa khít vào khung (target_w, target_h)
      mà KHÔNG làm biến dạng tỷ lệ ngang/dọc (Aspect Ratio Preserved).
    - Resize ảnh theo tỷ lệ chuẩn đó.
    - Phần còn thiếu (trên/dưới hoặc trái/phải) được đệm thêm viền màu xám
      (lấy giá trị xám trung vị của viền ảnh).
    """
    h, w = img_gray.shape[:2]
    scale = min(target_w / w, target_h / h)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))

    resized = cv2.resize(img_gray, (new_w, new_h), interpolation=cv2.INTER_AREA)

    border_pixels = np.concatenate([
        resized[0, :],
        resized[-1, :],
        resized[:, 0],
        resized[:, -1]
    ])
    bg_val = int(np.median(border_pixels))

    canvas = np.full((target_h, target_w), bg_val, dtype=np.uint8)

    pad_y = (target_h - new_h) // 2
    pad_x = (target_w - new_w) // 2
    canvas[pad_y : pad_y + new_h, pad_x : pad_x + new_w] = resized

    return canvas


# ==============================================================================
# 3. VẼ KÝ TỰ CƠ BẢN BẰNG PIL TRƯỚC KHI AUGMENT
# ==============================================================================
def render_base_text_image(slot_chars, font_paths):
    """
    Vẽ chữ cơ bản và áp dụng Letterbox Resize (Cách B) để giữ nguyên tỷ lệ khung hình:
    - Mô phỏng tỷ lệ khung hình thực tế của các thanh số (aspect ratio 4.2:1 đến 5.8:1).
    - Mỗi slot được dành đúng 24px (tại 192px), đặc biệt dấu '.' có vùng đệm 10-15px riêng biệt,
      không bao giờ bị dính sát vào số đứng trước hoặc sau.
    - Áp dụng Letterbox để đệm viền xám trên/dưới, các con số luôn giữ hình dạng tự nhiên.
    """
    # Màu nền xám nhạt màn hình LCD máy slot
    bg_val = random.randint(180, 220)
    bg_color = (
        bg_val,
        max(0, min(255, bg_val + random.randint(-4, 4))),
        max(0, min(255, bg_val + random.randint(-4, 4)))
    )

    # Màu chữ đen / xám đậm
    fg_val = random.randint(15, 50)
    fg_color = (
        fg_val,
        max(0, min(255, fg_val + random.randint(-3, 3))),
        max(0, min(255, fg_val + random.randint(-3, 3)))
    )

    # Mô phỏng chiều cao thực tế của thanh số trước khi đệm viền (34-44px ở 1x)
    canvas_w = 384
    canvas_h = random.randint(68, 88)

    img = Image.new("RGB", (canvas_w, canvas_h), bg_color)
    draw = ImageDraw.Draw(img)

    font_path = random.choice(font_paths)
    font_size = int(canvas_h * random.uniform(0.68, 0.82))
    font = ImageFont.truetype(font_path, font_size)

    cell_w = canvas_w / len(slot_chars)  # 48px ở 2x (tương ứng 24px ở 1x)

    for i, c in enumerate(slot_chars):
        if c is None:
            continue
        cell_center_x = (i + 0.5) * cell_w
        bbox = draw.textbbox((0, 0), c, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]

        jitter_x = random.uniform(-0.04, 0.04) * cell_w
        jitter_y = random.uniform(-0.04, 0.04) * canvas_h

        x = cell_center_x - tw / 2.0 - bbox[0] + jitter_x
        if c == ".":
            # Dấu chấm nằm sát mép đáy, có khoảng đệm 2 bên rộng rãi (48px cell, dấu chấm chỉ rộng ~6px)
            y = canvas_h * 0.76 - bbox[3] + jitter_y
        else:
            y = (canvas_h - th) / 2.0 - bbox[1] + jitter_y

        draw.text((x, y), c, font=font, fill=fg_color)

    # Chuyển sang Grayscale
    img_gray = np.array(img.convert("L"), dtype=np.uint8)

    # Áp dụng Letterbox Resize (Cách B) đưa về (192, 48) có đệm viền xám
    base_img = letterbox_resize(img_gray, config.IMG_WIDTH, config.IMG_HEIGHT)
    return base_img, bg_val


# ==============================================================================
# 4. GIẢ LẬP QUANG HỌC CAMERA CHỤP MÀN HÌNH (OPENCV & NUMPY)
# ==============================================================================
def apply_camera_screen_simulation(img, bg_val):
    """
    Áp dụng đầy đủ các hiện tượng quang học khi camera điện thoại chụp màn hình LCD:
      a. Lưới sọc màn hình LCD (LCD Scanlines)
      b. Hiệu ứng vân Moiré tần số thấp (sóng sin 2D)
      c. Biến dạng góc chụp & xoay (Perspective & Tilt)
      d. Ánh sáng không đều & vệt lóa sáng (Gradient & Glare reflection)
      e. Mờ nhòe & Nhiễu hạt cảm biến (Motion blur, Gaussian blur & ISO Noise)
    """
    h, w = img.shape[:2]
    out = img.astype(np.float32)

    # --------------------------------------------------------------------------
    # a. LƯỚI SỌC MÀN HÌNH LCD (LCD SCANLINES)
    # --------------------------------------------------------------------------
    if random.random() < 0.85:
        # Sọc dọc li ti cách nhau 1-2 pixel
        step_x = random.choice([2, 3])
        vert_stripe = np.ones((1, w), dtype=np.float32)
        vert_stripe[0, ::step_x] = random.uniform(0.91, 0.96)
        out *= vert_stripe

        # Sọc ngang li ti mờ nhẹ
        if random.random() < 0.50:
            step_y = random.choice([2, 3])
            horiz_stripe = np.ones((h, 1), dtype=np.float32)
            horiz_stripe[::step_y, 0] = random.uniform(0.93, 0.97)
            out *= horiz_stripe

    # --------------------------------------------------------------------------
    # b. HIỆU ỨNG VÂN SÓNG MOIRÉ (2D SINE WAVE INTERFERENCE)
    # --------------------------------------------------------------------------
    if random.random() < 0.70:
        y_grid, x_grid = np.mgrid[0:h, 0:w]
        # Tần số góc gợn sóng mô phỏng giao thoa lưới cảm biến và điểm ảnh
        freq_x = random.uniform(0.03, 0.12)
        freq_y = random.uniform(0.02, 0.08)
        phase = random.uniform(0, 2 * np.pi)
        amplitude = random.uniform(5.0, 16.0)

        moire_wave = amplitude * np.sin(freq_x * x_grid + freq_y * y_grid + phase)
        out += moire_wave

    # --------------------------------------------------------------------------
    # c. BIẾN DẠNG GÓC CHỤP (PERSPECTIVE & TILT)
    # --------------------------------------------------------------------------
    # Xoay nhẹ (-4° đến +4°)
    angle = random.uniform(-4.0, 4.0)
    rot_mat = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), angle, 1.0)
    out = cv2.warpAffine(out, rot_mat, (w, h), borderMode=cv2.BORDER_REPLICATE)

    # Biến dạng phối cảnh 4 góc (chụp nghiêng điện thoại)
    if random.random() < 0.75:
        dx = random.uniform(0.01, 0.04) * w
        dy = random.uniform(0.01, 0.05) * h
        src_pts = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        dst_pts = np.float32([
            [random.uniform(0, dx), random.uniform(0, dy)],
            [w - random.uniform(0, dx), random.uniform(0, dy)],
            [w - random.uniform(0, dx), h - random.uniform(0, dy)],
            [random.uniform(0, dx), h - random.uniform(0, dy)]
        ])
        persp_mat = cv2.getPerspectiveTransform(src_pts, dst_pts)
        out = cv2.warpPerspective(out, persp_mat, (w, h), borderMode=cv2.BORDER_REPLICATE)

    # --------------------------------------------------------------------------
    # d. ÁNH SÁNG & LÓA SÁNG (GLARE / REFLECTION & GRADIENT)
    # --------------------------------------------------------------------------
    # Gradient chiếu sáng không đều (vignette / bóng sáng góc)
    if random.random() < 0.80:
        gx = np.linspace(random.uniform(-15, 15), random.uniform(-15, 15), w)[None, :]
        gy = np.linspace(random.uniform(-12, 12), random.uniform(-12, 12), h)[:, None]
        out += (gx + gy)

    # Vệt lóa sáng bóng đèn phòng phản chiếu trên mặt kính
    if random.random() < 0.45:
        glare_mask = np.zeros((h, w), dtype=np.float32)
        center_x = random.choice([
            random.randint(0, int(w * 0.35)),
            random.randint(int(w * 0.65), w)
        ])
        center_y = random.choice([
            random.randint(0, int(h * 0.40)),
            random.randint(int(h * 0.60), h)
        ])
        axes = (random.randint(int(w * 0.15), int(w * 0.45)),
                random.randint(int(h * 0.25), int(h * 0.60)))
        glare_val = random.uniform(22.0, 52.0)

        cv2.ellipse(glare_mask, (center_x, center_y), axes, random.uniform(0, 180), 0, 360, glare_val, -1)
        glare_blur = cv2.GaussianBlur(glare_mask, (0, 0), sigmaX=axes[0] * 0.45, sigmaY=axes[1] * 0.45)
        out += glare_blur

    # --------------------------------------------------------------------------
    # e. MỜ NHÒE & NHIỄU HẠT (BLUR & ISO NOISE)
    # --------------------------------------------------------------------------
    # Rung tay nhẹ (Motion Blur)
    if random.random() < 0.35:
        ksize = random.choice([3, 5])
        kernel_mb = np.zeros((ksize, ksize), dtype=np.float32)
        if random.random() < 0.5:
            kernel_mb[ksize // 2, :] = 1.0  # Rung ngang
        else:
            np.fill_diagonal(kernel_mb, 1.0)  # Rung chéo
        kernel_mb /= ksize
        out = cv2.filter2D(out, -1, kernel_mb)

    # Lấy nét mờ nhẹ (Gaussian Blur bán kính 0.5 - 1.0)
    if random.random() < 0.65:
        sigma = random.uniform(0.5, 1.0)
        out = cv2.GaussianBlur(out, (0, 0), sigmaX=sigma, sigmaY=sigma)

    # Nhiễu hạt cảm biến ISO (Gaussian Noise)
    if random.random() < 0.70:
        noise_sigma = random.uniform(2.5, 7.0)
        noise = np.random.normal(0, noise_sigma, out.shape)
        out += noise

    # Tương phản và độ sáng ngẫu nhiên
    alpha = random.uniform(0.85, 1.25)
    beta = random.uniform(-8.0, 8.0)
    final_img = np.clip(out * alpha + beta, 0, 255).astype(np.uint8)

    return final_img


def generate_single_sample(fonts):
    """Sinh hoàn chỉnh 1 mẫu (ảnh uint8 shape (48, 192), nhãn int64 shape (8,))."""
    text = generate_sample_text()
    slot_chars, labels = create_slot_labels_and_alignment(text)
    base_img, bg_val = render_base_text_image(slot_chars, fonts)
    final_img = apply_camera_screen_simulation(base_img, bg_val)
    return final_img, labels, text


# ==============================================================================
# 5. TẠO TẬP DỮ LIỆU & GHÉP ẢNH PREVIEW
# ==============================================================================
def create_preview_grid(sample_images, sample_texts, output_path, cols=4, rows=5):
    """
    Ghép 20 ảnh mẫu đầu tiên thành lưới ảnh preview (5 hàng x 4 cột)
    để người dùng kiểm tra mắt thường trên Windows.
    """
    n_tiles = min(len(sample_images), cols * rows)
    img_h, img_w = config.IMG_HEIGHT, config.IMG_WIDTH
    padding = 2

    grid_w = cols * img_w + (cols + 1) * padding
    grid_h = rows * img_h + (rows + 1) * padding
    canvas = np.full((grid_h, grid_w), 240, dtype=np.uint8)

    print(f"\n[PREVIEW] Danh sách {n_tiles} mẫu ảnh đầu tiên:")
    for idx in range(n_tiles):
        r = idx // cols
        c = idx % cols
        x0 = padding + c * (img_w + padding)
        y0 = padding + r * (img_h + padding)
        canvas[y0 : y0 + img_h, x0 : x0 + img_w] = sample_images[idx]
        print(f"  Mẫu {idx + 1:2d}: '{sample_texts[idx]}'")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    cv2.imwrite(output_path, canvas)
    print(f"\n-> Đã lưu ảnh xem thử vào: {output_path}")
    print("   Bạn hãy mở file ảnh trên để kiểm tra vân Moiré, sọc LCD và độ mờ trước khi train!\n")


def generate_dataset_batch(n_samples, fonts, desc=""):
    """Tạo một mảng n_samples ảnh và nhãn."""
    images = np.zeros((n_samples, config.IMG_HEIGHT, config.IMG_WIDTH), dtype=np.uint8)
    labels = np.zeros((n_samples, config.NUM_SLOTS), dtype=np.int64)
    preview_imgs = []
    preview_texts = []

    print(f"[TIẾN ĐỘ] Bắt đầu sinh {n_samples} mẫu {desc}...")
    log_interval = max(1, n_samples // 10)

    for i in range(n_samples):
        img, lbl, txt = generate_single_sample(fonts)
        images[i] = img
        labels[i] = lbl

        if len(preview_imgs) < 20:
            preview_imgs.append(img)
            preview_texts.append(txt)

        if (i + 1) % log_interval == 0 or (i + 1) == n_samples:
            pct = (i + 1) / n_samples * 100.0
            print(f"  {desc} -> {i + 1:6d}/{n_samples} ({pct:5.1f}%)")

    return images, labels, preview_imgs, preview_texts


# ==============================================================================
# 6. HÀM MAIN VÀ DÒNG LỆNH (CLI)
# ==============================================================================
def main():
    parser = argparse.ArgumentParser(
        description="All-in-One: Sinh dữ liệu synthetic mô phỏng camera điện thoại chụp LCD",
        formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument(
        "--train-n", type=int, default=25000,
        help="Số lượng mẫu cho tập Train (mặc định: 25000)"
    )
    parser.add_argument(
        "--val-n", type=int, default=5000,
        help="Số lượng mẫu cho tập Val (mặc định: 5000)"
    )
    parser.add_argument(
        "--preview", action="store_true",
        help="Chỉ sinh 20 ảnh mẫu lưu vào preview.png để kiểm tra nhanh (không sinh file .npz)"
    )
    parser.add_argument(
        "--seed", type=int, default=None,
        help="Hạt giống ngẫu nhiên (tùy chọn)"
    )
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)
        np.random.seed(args.seed)

    fonts = load_all_fonts()
    print("=" * 65)
    print("SCREEN DIGIT OCR - ALL-IN-ONE SYNTHETIC GENERATOR")
    print(f"  - Font sử dụng : {len(fonts)} font ({[os.path.basename(f) for f in fonts]})")
    print(f"  - Kích thước   : {config.IMG_WIDTH}x{config.IMG_HEIGHT}")
    print(f"  - Cấu hình     : {config.NUM_SLOTS} slots ('{config.FORMAT}')")
    print(f"  - CHARSET      : '{config.CHARSET}' (BLANK_INDEX={config.BLANK_INDEX}, Classes={config.NUM_CLASSES})")
    print("=" * 65)

    preview_path = os.path.join(CURRENT_DIR, config.SYNTH_DATA_DIR, "preview.png")

    # Nếu chỉ chạy kiểm tra preview
    if args.preview:
        print("\n[CHẾ ĐỘ XEM THỬ] Đang tạo 20 ảnh mẫu kiểm tra mắt thường...")
        preview_imgs = []
        preview_texts = []
        for _ in range(20):
            img, _, txt = generate_single_sample(fonts)
            preview_imgs.append(img)
            preview_texts.append(txt)
        create_preview_grid(preview_imgs, preview_texts, preview_path, cols=4, rows=5)
        return

    # QUY TRÌNH TẠO TOÀN BỘ 30.000 MẪU (25.000 TRAIN + 5.000 VAL)
    out_dir = os.path.join(CURRENT_DIR, config.SYNTH_DATA_DIR)
    os.makedirs(out_dir, exist_ok=True)
    train_npz = os.path.join(out_dir, "train.npz")
    val_npz = os.path.join(out_dir, "val.npz")

    # 1. Sinh tập Train (25.000 mẫu)
    train_imgs, train_lbls, prev_imgs, prev_txts = generate_dataset_batch(
        args.train_n, fonts, desc="Train"
    )
    print(f"[LƯU TRỮ] Đang nén và lưu {args.train_n} mẫu Train vào: {train_npz}")
    np.savez_compressed(train_npz, images=train_imgs, labels=train_lbls)

    # 2. Sinh tập Val (5.000 mẫu)
    val_imgs, val_lbls, _, _ = generate_dataset_batch(
        args.val_n, fonts, desc="Val"
    )
    print(f"[LƯU TRỮ] Đang nén và lưu {args.val_n} mẫu Val vào: {val_npz}")
    np.savez_compressed(val_npz, images=val_imgs, labels=val_lbls)

    # 3. Tạo ảnh preview 20 mẫu đầu tiên
    create_preview_grid(prev_imgs, prev_txts, preview_path, cols=4, rows=5)

    print("=" * 65)
    print("HOÀN TẤT TẠO BỘ DỮ LIỆU SYNTHETIC!")
    print(f"  -> Tập Train : {train_npz} (Shape: {train_imgs.shape})")
    print(f"  -> Tập Val   : {val_npz}   (Shape: {val_imgs.shape})")
    print(f"  -> Ảnh mẫu   : {preview_path}")
    print("Bạn có thể bắt đầu chạy train.py ngay bây giờ!")
    print("=" * 65 + "\n")


if __name__ == "__main__":
    main()
