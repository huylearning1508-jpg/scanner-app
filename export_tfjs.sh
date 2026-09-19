#!/usr/bin/env bash
# Chuyển model đã train (.h5) sang định dạng TensorFlow.js để chạy trong trình duyệt.
#
# QUAN TRỌNG: gói `tensorflowjs` (converter) thường xung đột phiên bản với các bản
# TensorFlow mới nhất. Cách chắc ăn nhất là tạo 1 virtualenv RIÊNG chỉ để export,
# tách biệt với môi trường bạn dùng để train (train.py có thể dùng TF bản mới hơn thoải mái).
#
# Cách dùng:
#   bash export_tfjs.sh models/screen_digit_ocr.h5 models/tfjs_model
#
set -e
IN_MODEL=${1:-models/screen_digit_ocr.h5}
OUT_DIR=${2:-models/tfjs_model}

VENV_DIR=".venv_tfjs_export"
if [ ! -d "$VENV_DIR" ]; then
    echo ">> Tạo virtualenv riêng cho export tại $VENV_DIR (chỉ cần làm 1 lần)..."
    python3 -m venv "$VENV_DIR"
    # shellcheck disable=SC1091
    source "$VENV_DIR/bin/activate"
    pip install -q --upgrade pip
    # cặp phiên bản này đã kiểm chứng hoạt động tốt cùng nhau
    pip install -q "tensorflow==2.16.1" "tensorflowjs==4.20.0"
else
    # shellcheck disable=SC1091
    source "$VENV_DIR/bin/activate"
fi

echo ">> Đang convert $IN_MODEL -> $OUT_DIR ..."
tensorflowjs_converter --input_format=keras --quantize_uint8=* "$IN_MODEL" "$OUT_DIR"

echo ">> Xong! Copy models/labels.json vào chung thư mục $OUT_DIR để web app đọc được."
cp models/labels.json "$OUT_DIR/labels.json"
echo ">> Đã sẵn sàng: $OUT_DIR/{model.json, group1-shard*.bin, labels.json}"
