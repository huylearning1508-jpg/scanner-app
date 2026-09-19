"""
Huấn luyện model đọc số từ ảnh.

Chạy (sau khi đã có data/synthetic/train.npz và val.npz từ generate_synthetic_data.py):
    python3 train.py --train data/synthetic/train.npz --val data/synthetic/val.npz --epochs 30

Nếu có thêm ảnh THẬT đã gán nhãn (xem README mục "Fine-tune bằng ảnh thật"),
truyền thêm --real data/real/real.npz để trộn vào lúc train (khuyến khích, giúp
model bớt lệch giữa dữ liệu giả lập và ảnh chụp thật ngoài đời).
"""
import argparse
import json
import os

import numpy as np
import tensorflow as tf

import config
from model import build_model


def load_npz(path):
    d = np.load(path)
    images = d["images"].astype("float32")[..., None]  # (N,H,W) -> (N,H,W,1)
    labels = d["labels"]  # (N, NUM_SLOTS) int
    return images, labels


def labels_to_head_targets(labels):
    """labels: (N, NUM_SLOTS) -> list gồm NUM_SLOTS mảng (N,) để khớp với list output của model."""
    return [labels[:, i] for i in range(labels.shape[1])]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", default=os.path.join(config.SYNTH_DATA_DIR, "train.npz"))
    ap.add_argument("--val", default=os.path.join(config.SYNTH_DATA_DIR, "val.npz"))
    ap.add_argument("--real", default=None, help="npz ảnh thật để trộn thêm vào tập train (tùy chọn)")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch_size", type=int, default=64)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--out", default=os.path.join(config.MODEL_DIR, "screen_digit_ocr.keras"))
    args = ap.parse_args()

    x_train, y_train = load_npz(args.train)
    x_val, y_val = load_npz(args.val)

    if args.real and os.path.exists(args.real):
        xr, yr = load_npz(args.real)
        # nhân bản ảnh thật lên vài lần để model "chú ý" tới chúng hơn (ít ảnh thật hơn nhiều so với ảnh giả lập)
        repeat = max(1, len(x_train) // max(1, len(xr) * 20))
        x_train = np.concatenate([x_train] + [xr] * repeat, axis=0)
        y_train = np.concatenate([y_train] + [yr] * repeat, axis=0)
        print(f"Đã trộn thêm {len(xr)} ảnh thật (nhân {repeat} lần) vào {len(x_train)} ảnh train")

    print(f"Train: {x_train.shape}, Val: {x_val.shape}")

    model = build_model()
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=args.lr),
        loss=["sparse_categorical_crossentropy"] * config.NUM_SLOTS,
        metrics=[["accuracy"]] * config.NUM_SLOTS,
    )

    os.makedirs(config.MODEL_DIR, exist_ok=True)
    callbacks = [
        tf.keras.callbacks.ModelCheckpoint(args.out, save_best_only=True, monitor="val_loss"),
        tf.keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=3, min_lr=1e-5),
        tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=8, restore_best_weights=True),
    ]

    model.fit(
        x_train, labels_to_head_targets(y_train),
        validation_data=(x_val, labels_to_head_targets(y_val)),
        epochs=args.epochs,
        batch_size=args.batch_size,
        callbacks=callbacks,
    )

    model.save(args.out)
    # lưu thêm bản .h5 (định dạng cũ) vì tensorflowjs_converter hiện chỉ đọc được .h5,
    # chưa hỗ trợ tốt định dạng .keras mới -> dùng file .h5 này ở bước export_tfjs.sh
    h5_path = os.path.splitext(args.out)[0] + ".h5"
    model.save(h5_path)

    # lưu kèm metadata để bên inference (JS) biết cách giải mã output
    meta = {
        "charset": config.CHARSET,
        "blank_index": config.BLANK_INDEX,
        "num_classes": config.NUM_CLASSES,
        "num_slots": config.NUM_SLOTS,
        "format": config.FORMAT,
        "img_height": config.IMG_HEIGHT,
        "img_width": config.IMG_WIDTH,
    }
    meta_path = os.path.join(config.MODEL_DIR, "labels.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"Đã lưu model tại {args.out}")
    print(f"Đã lưu metadata tại {meta_path}")

    # đánh giá nhanh: tỉ lệ ĐÚNG TOÀN BỘ CHUỖI (full-sequence accuracy) trên tập val
    preds = model.predict(x_val, verbose=0)
    pred_labels = np.stack([np.argmax(p, axis=-1) for p in preds], axis=1)  # (N, NUM_SLOTS)
    full_match = np.all(pred_labels == y_val, axis=1).mean()
    per_slot_acc = (pred_labels == y_val).mean()
    print(f"Val — full-string accuracy: {full_match:.4f} | per-slot accuracy: {per_slot_acc:.4f}")


if __name__ == "__main__":
    main()
