"""
Cấu hình dùng chung cho toàn bộ pipeline (sinh dữ liệu, train, predict).
Hỗ trợ nhận diện trực tiếp: chữ số (0-9), dấu chấm (.), phần trăm (%), đô la ($).
"""

# --- Tập ký tự model nhận diện trực tiếp ---
# Bao gồm các chữ số (0-9), dấu chấm (.), dấu phần trăm (%) và dấu đô la ($)
CHARSET = "0123456789.%$"

# Ký tự đại diện cho "ô trống" (blank slot)
BLANK_INDEX = len(CHARSET)          # index 13 là ô trống
NUM_CLASSES = len(CHARSET) + 1      # 14 classes (13 ký tự + 1 ô trống)

# --- Định dạng và số ô (slots) ---
# Chuỗi dài nhất thực tế trên màn hình là dạng '92.734%' (7 ký tự).
# Thiết lập 8 ô ('########') để căn chỉnh linh hoạt cho các chuỗi từ 1 đến 8 ký tự.
FORMAT = "########"
NUM_SLOTS = len(FORMAT)             # 8 slots

# --- Kích thước ảnh chuẩn đưa vào model ---
IMG_HEIGHT = 48
IMG_WIDTH = 192

# --- Đường dẫn thư mục ---
FONTS_DIR = "fonts"
SYNTH_DATA_DIR = "data/synthetic"
REAL_DATA_DIR = "data/real"
MODEL_DIR = "models"
