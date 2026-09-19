"""
Đóng gói các ảnh THẬT (đã tự chụp & gán nhãn qua TÊN FILE) thành 1 file .npz
cùng định dạng với dữ liệu synthetic, để dùng cho train.py --real (fine-tune).

Cách dùng:
  1. Chụp ảnh vùng số (crop tương đối sát vào đúng vùng số, giống cách app sẽ crop ROI sau này).
  2. Đặt tên file = đúng số hiển thị trên ảnh đó, ví dụ:
       12345678.jpg          -> nhãn "12345678"
       123.45.jpg            -> nhãn "123.45"   (chấm trong tên file không sao, script tự parse)
       -42_anh2.png          -> nhãn "-42" (phần sau dấu "_" chỉ để tên file không trùng nhau, bị bỏ qua)
     Bỏ tất cả ảnh đã đặt tên vào thư mục data/real/ (config.REAL_DATA_DIR).
  3. Chạy:
       python3 label_real_images.py
     -> tạo ra data/real/real.npz, dùng được ngay cho: python3 train.py --real data/real/real.npz
"""
import argparse
import glob
import os

import numpy as np
from PIL import Image

import config


def align_label_to_format(label, fmt):
    """Khớp 1 chuỗi nhãn thật (vd '123.45') vào khuôn FORMAT (vd '###D.DD').
    Trả về list ký tự dài len(fmt), None = ô trống. Ném ValueError nếu không khớp được."""
    total_digit_slots = sum(1 for c in fmt if c in "D#")
    n_label_digits = sum(1 for c in label if c.isdigit())
    blanks_needed = total_digit_slots - n_label_digits
    if blanks_needed < 0:
        raise ValueError(f"nhãn '{label}' có nhiều chữ số hơn FORMAT '{fmt}' cho phép")

    chars = []
    li = 0  # con trỏ trong `label`
    hash_blanked = 0
    for c in fmt:
        if c == "#":
            if hash_blanked < blanks_needed:
                chars.append(None)
                hash_blanked += 1
                continue
            # rơi xuống xử lý như digit bắt buộc bên dưới
            if li >= len(label) or not label[li].isdigit():
                raise ValueError(f"nhãn '{label}' thiếu chữ số để khớp FORMAT '{fmt}'")
            chars.append(label[li]); li += 1
        elif c == "D":
            if li >= len(label) or not label[li].isdigit():
                raise ValueError(f"nhãn '{label}' thiếu chữ số bắt buộc để khớp FORMAT '{fmt}'")
            chars.append(label[li]); li += 1
        elif c == "-":
            if li < len(label) and label[li] == "-":
                chars.append("-"); li += 1
            else:
                chars.append(None)
        else:
            if li >= len(label) or label[li] != c:
                raise ValueError(f"nhãn '{label}' không có ký tự cố định '{c}' đúng vị trí (FORMAT '{fmt}')")
            chars.append(c); li += 1

    if li != len(label):
        raise ValueError(f"nhãn '{label}' còn dư ký tự chưa khớp hết vào FORMAT '{fmt}'")
    return chars


def encode(chars):
    idx = []
    for c in chars:
        idx.append(config.BLANK_INDEX if c is None else config.CHARSET.index(c))
    return np.array(idx, dtype=np.int64)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=config.REAL_DATA_DIR)
    ap.add_argument("--out", default=os.path.join(config.REAL_DATA_DIR, "real.npz"))
    args = ap.parse_args()

    paths = sorted(sum([glob.glob(os.path.join(args.dir, f"*.{ext}"))
                         for ext in ("jpg", "jpeg", "png", "bmp")], []))
    if not paths:
        print(f"Không thấy ảnh nào trong {args.dir}. Xem hướng dẫn ở đầu file này.")
        return

    images, labels, ok, skipped = [], [], 0, 0
    for p in paths:
        stem = os.path.splitext(os.path.basename(p))[0]
        label = stem.split("_")[0]
        try:
            chars = align_label_to_format(label, config.FORMAT)
        except ValueError as e:
            print(f"[bỏ qua] {p}: {e}")
            skipped += 1
            continue
        img = Image.open(p).convert("L").resize((config.IMG_WIDTH, config.IMG_HEIGHT), Image.BICUBIC)
        images.append(np.array(img, dtype=np.uint8))
        labels.append(encode(chars))
        ok += 1

    if ok == 0:
        print("Không có ảnh nào hợp lệ để lưu.")
        return

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    np.savez_compressed(args.out, images=np.stack(images), labels=np.stack(labels))
    print(f"Đã lưu {ok} ảnh thật vào {args.out} (bỏ qua {skipped} ảnh lỗi tên/định dạng).")


if __name__ == "__main__":
    main()
