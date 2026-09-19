"""
Hàm dùng chung để sinh & augment ảnh số giả lập mô phỏng chân thực màn hình LCD máy slot.
Hỗ trợ trực tiếp: chữ số (0-9), dấu chấm (.), phần trăm (%) và đô la ($).
"""

import glob
import io
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

import config


def load_fonts():
    """Tải danh sách các font trong thư mục fonts/."""
    paths = sorted(glob.glob(os.path.join(config.FONTS_DIR, "*.ttf")) +
                   glob.glob(os.path.join(config.FONTS_DIR, "*.otf")))
    if not paths:
        fallback = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
            "/usr/share/fonts/truetype/freefont/FreeMonoBold.ttf",
        ]
        paths = [p for p in fallback if os.path.exists(p)]
        if paths:
            print("[!] Không tìm thấy font trong '%s/'. Đang dùng font hệ thống tạm thời." % config.FONTS_DIR)
    if not paths:
        raise RuntimeError("Không tìm thấy font nào trong fonts/. Hãy chép ít nhất 1 file .ttf vào thư mục fonts/.")
    return paths


def generate_random_screen_text():
    """
    Sinh chuỗi số ngẫu nhiên theo tỷ lệ yêu cầu:
      - 40% là số phần trăm có dấu chấm (vd: 92.734%, 93.63%, 0.000%, 5.5%)
      - 30% là số tiền có dấu $ (vd: $0.01, $12.50, $100, $0.50)
      - 30% là số nguyên hoặc số đếm (vd: 12, 1, 100, 25)
    Đảm bảo độ dài chuỗi tối đa 8 ký tự.
    """
    p = random.random()

    if p < 0.40:
        # --- 40% SỐ PHẦN TRĂM (%) ---
        sub = random.random()
        if sub < 0.50:
            # 3 chữ số thập phân: vd 92.734%, 0.000%, 88.125% (độ dài 6-7 ký tự)
            int_part = random.randint(0, 99)
            dec_part = random.randint(0, 999)
            text = f"{int_part}.{dec_part:03d}%"
        elif sub < 0.80:
            # 2 chữ số thập phân: vd 93.63%, 12.50%
            int_part = random.randint(0, 99)
            dec_part = random.randint(0, 99)
            text = f"{int_part}.{dec_part:02d}%"
        elif sub < 0.95:
            # 1 chữ số thập phân hoặc 100.0%: vd 5.5%, 100.0%
            if random.random() < 0.15:
                text = "100.0%"
            else:
                int_part = random.randint(0, 99)
                dec_part = random.randint(0, 9)
                text = f"{int_part}.{dec_part}%"
        else:
            # Số nguyên %: vd 95%, 100%
            text = f"{random.randint(0, 100)}%"

    elif p < 0.70:
        # --- 30% SỐ TIỀN ($) ---
        sub = random.random()
        if sub < 0.40:
            # Tiền xu nhỏ: $0.01, $0.50, $0.25
            cent = random.randint(1, 99)
            text = f"$0.{cent:02d}"
        elif sub < 0.80:
            # Tiền có phần thập phân: $1.50, $12.50, $99.99
            dollar = random.randint(1, 99)
            cent = random.randint(0, 99)
            text = f"${dollar}.{cent:02d}"
        else:
            # Tiền chẵn: $1, $5, $10, $100, $500
            amt = random.choice([random.randint(1, 99), random.randint(100, 999)])
            text = f"${amt}"

    else:
        # --- 30% SỐ NGUYÊN / SỐ ĐẾM ---
        sub = random.random()
        if sub < 0.50:
            # 1-2 chữ số: 12, 1, 25, 99
            text = str(random.randint(1, 99))
        elif sub < 0.85:
            # 3 chữ số: 100, 250, 365
            text = str(random.randint(100, 999))
        else:
            # 4-5 chữ số: 1000, 92734
            text = str(random.randint(1000, 99999))

    # Cắt gọn nếu vượt quá số ô NUM_SLOTS (8)
    if len(text) > config.NUM_SLOTS:
        text = text[:config.NUM_SLOTS]

    return text


def random_label():
    """
    Sinh nhãn 8 slots:
    - Căn lề: Căn phải (Right-align) hoặc căn giữa (Center-align) ngẫu nhiên
      để khớp với vị trí thực tế của các ô số trên màn hình máy slot.
    - Các ô không có chữ sẽ được đặt là None (ô trống).
    """
    text = generate_random_screen_text()
    n_slots = config.NUM_SLOTS
    n_chars = len(text)
    blanks = n_slots - n_chars

    align_choice = random.random()
    if align_choice < 0.55:
        # Căn phải (Right-align): các ô trống nằm bên trái (phổ biến nhất cho số)
        left_blanks = blanks
    elif align_choice < 0.85:
        # Căn giữa (Center-align): phân bổ đều 2 bên
        left_blanks = blanks // 2
    else:
        # Độ lệch ngẫu nhiên (chống lệch crop ROI)
        left_blanks = random.randint(0, blanks)

    right_blanks = blanks - left_blanks
    chars = [None] * left_blanks + list(text) + [None] * right_blanks
    return chars


def encode_label(chars):
    """Chuyển list 8 ký tự sang mảng numpy int (index 13 là BLANK)."""
    idx = []
    for c in chars:
        if c is None:
            idx.append(config.BLANK_INDEX)
        else:
            idx.append(config.CHARSET.index(c))
    return np.array(idx, dtype=np.int64)


def _find_perspective_coeffs(src, dst):
    """Tính ma trận phối cảnh cho PIL Image.transform."""
    matrix = []
    for p1, p2 in zip(dst, src):
        matrix.append([p1[0], p1[1], 1, 0, 0, 0, -p2[0] * p1[0], -p2[0] * p1[1]])
        matrix.append([0, 0, 0, p1[0], p1[1], 1, -p2[1] * p1[0], -p2[1] * p1[1]])
    A = np.array(matrix, dtype=np.float64)
    B = np.array(src).reshape(8)
    res = np.linalg.solve(A, B)
    return res.tolist()


def render_sample(chars, font_paths, img_width=None, img_height=None):
    """
    Vẽ 1 ảnh mẫu (PIL grayscale 192x48) từ nhãn `chars`, mô phỏng chân thực:
      - Nền xám nhạt (RGB 180-220) giống màn hình máy slot thật.
      - Chữ màu đen / xám đậm có antialiasing.
      - Hiệu ứng vân sọc màn hình LCD (Scanlines / Moiré).
      - Làm mờ nhẹ (Gaussian Blur 0.5 - 1.0), nhiễu cảm biến, độ tương phản.
    """
    img_width = img_width or config.IMG_WIDTH
    img_height = img_height or config.IMG_HEIGHT

    # Vẽ ở canvas phóng to rồi scale xuống để chữ sắc nét tự nhiên
    scale = random.uniform(1.5, 2.0)
    cw, ch = int(img_width * scale), int(img_height * scale)

    # 1. MÀU NỀN VÀ MÀU CHỮ MÀN HÌNH LCD
    if random.random() < 0.90:
        # Nền xám nhạt (RGB quanh 180-220) giống màn hình thật
        bg_val = random.randint(180, 220)
        bg_color = (
            bg_val,
            max(0, min(255, bg_val + random.randint(-4, 4))),
            max(0, min(255, bg_val + random.randint(-4, 4)))
        )
        # Chữ đen / xám đậm
        fg_val = random.randint(15, 50)
        fg_color = (
            fg_val,
            max(0, min(255, fg_val + random.randint(-3, 3))),
            max(0, min(255, fg_val + random.randint(-3, 3)))
        )
    else:
        # Thi thoảng cho nền trắng thuần hoặc nền tối nhẹ để đa dạng
        if random.random() < 0.5:
            bg_color, fg_color = (245, 245, 245), (10, 10, 10)
        else:
            bg_color, fg_color = (30, 30, 35), (220, 220, 220)

    img = Image.new("RGB", (cw, ch), bg_color)
    draw = ImageDraw.Draw(img)

    n_slots = len(chars)
    cell_w = cw / n_slots

    font_path = random.choice(font_paths)
    font_size = int(ch * random.uniform(0.55, 0.75))
    font = ImageFont.truetype(font_path, font_size)

    # 2. VẼ KÝ TỰ THEO TỪNG SLOT
    for i, c in enumerate(chars):
        if c is None:
            continue
        cell_x0 = i * cell_w
        bbox = draw.textbbox((0, 0), c, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]

        # Jitter vị trí nhẹ
        jitter_x = random.uniform(-0.06, 0.06) * cell_w
        jitter_y = random.uniform(-0.05, 0.05) * ch

        # Dấu chấm (.) nằm sát đáy hơn
        if c == ".":
            x = cell_x0 + (cell_w - tw) / 2 - bbox[0] + jitter_x
            y = ch * 0.70 - bbox[3] + jitter_y
        else:
            x = cell_x0 + (cell_w - tw) / 2 - bbox[0] + jitter_x
            y = (ch - th) / 2 - bbox[1] + jitter_y

        draw.text((x, y), c, font=font, fill=fg_color)

    # 3. HIỆU ỨNG VÂN SỌC MÀN HÌNH LCD (Scanlines / Moiré)
    if random.random() < 0.85:
        arr = np.array(img, dtype=np.float32)
        h_arr, w_arr = arr.shape[:2]

        # Sọc dọc li ti cách nhau 1-2 pixel mô phỏng lưới điểm ảnh LCD
        stride_x = random.choice([2, 3])
        col_mask = np.ones((1, w_arr, 1), dtype=np.float32)
        col_mask[0, ::stride_x, 0] = random.uniform(0.91, 0.96)
        arr *= col_mask

        # Sọc ngang mờ nhẹ
        if random.random() < 0.50:
            stride_y = random.choice([2, 3])
            row_mask = np.ones((h_arr, 1, 1), dtype=np.float32)
            row_mask[::stride_y, 0, 0] = random.uniform(0.93, 0.97)
            arr *= row_mask

        arr = np.clip(arr, 0, 255).astype(np.uint8)
        img = Image.fromarray(arr)

    # 4. GÓC NGHIÊNG & PHỐI CẢNH (CHỤP CAMERA ĐIỆN THOẠI)
    # Xoay nhẹ (-2.5 đến 2.5 độ)
    angle = random.uniform(-2.5, 2.5)
    img = img.rotate(angle, resample=Image.BICUBIC, expand=False, fillcolor=bg_color)

    # Nghiêng phối cảnh nhẹ
    if random.random() < 0.60:
        d = random.uniform(0, 0.03) * cw
        src = [(0, 0), (cw, 0), (cw, ch), (0, ch)]
        dst = [
            (random.uniform(0, d), random.uniform(0, d)),
            (cw - random.uniform(0, d), random.uniform(0, d)),
            (cw - random.uniform(0, d), ch - random.uniform(0, d)),
            (random.uniform(0, d), ch - random.uniform(0, d))
        ]
        coeffs = _find_perspective_coeffs(src, dst)
        img = img.transform((cw, ch), Image.PERSPECTIVE, coeffs, resample=Image.BICUBIC, fillcolor=bg_color)

    # 5. RESIZE VỀ KÍCH THƯỚC CHUẨN (192, 48)
    img = img.resize((img_width, img_height), Image.BICUBIC)

    # 6. LÀM MỜ NHẸ (Gaussian Blur bán kính 0.5 - 1.0)
    img = img.filter(ImageFilter.GaussianBlur(random.uniform(0.5, 1.0)))

    # 7. ĐỘ TƯƠNG PHẢN & ĐỘ SÁNG NGẪU NHIÊN
    img = ImageEnhance.Contrast(img).enhance(random.uniform(0.80, 1.30))
    img = ImageEnhance.Brightness(img).enhance(random.uniform(0.85, 1.15))

    # 8. NHIỄU CẢM BIẾN (Noise)
    if random.random() < 0.70:
        arr = np.array(img, dtype=np.int16)
        noise = np.random.normal(0, random.uniform(2, 6), arr.shape)
        arr = np.clip(arr + noise, 0, 255).astype(np.uint8)
        img = Image.fromarray(arr)

    # 9. NÉN JPEG MÔ PHỎNG CAMERA ĐIỆN THOẠI
    if random.random() < 0.50:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=random.randint(45, 85))
        buf.seek(0)
        img = Image.open(buf).convert("RGB")

    return img.convert("L")  # Grayscale
