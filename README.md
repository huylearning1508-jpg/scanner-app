# Train model đọc số từ màn hình qua camera điện thoại (chạy trong trình duyệt)

Bộ project này giúp bạn train 1 model nhận diện số nhỏ gọn, có thể chạy **trong trình duyệt**
(TensorFlow.js) trên cả iOS lẫn Android — thay thế Tesseract.js đang chậm/kém chính xác,
mà không cần build app native.

## 1. Kiến trúc đã chọn: CNN nhiều "đầu" (multi-head), theo từng ô ký tự cố định

Vì bạn chỉ cần đọc **số từ 1 vùng cố định** (không phải OCR văn bản tự do), cách hiệu quả
và dễ train nhất là: quy định trước số ô ký tự tối đa (`FORMAT` trong `config.py`), rồi cho
model 1 nhánh CNN dùng chung + N "đầu" phân loại (mỗi đầu đoán đúng 1 ô, ví dụ ô số 1 là
số mấy, ô số 2 là số mấy...). Không cần CTC/segmentation phức tạp, train nhanh, model nhỏ
(~1.7MB sau khi nén), chạy real-time ngay cả trên điện thoại đời cũ.

**Cách này yêu cầu:** số hiển thị phải có khuôn dạng số ô ký tự tương đối ổn định (đa số
counter/đồng hồ đo trên thiết bị đều vậy — ví dụ luôn 8 chữ số có đệm 0, hoặc luôn dạng
`XXXX.XX`). Nếu màn hình của bạn hiển thị số dài ngắn tùy ý, không theo khuôn nào cả
(ví dụ khi thì "5", khi thì "184729"), xem mục 8 (hướng nâng cao — CRNN + CTC).

## 2. Cài đặt

```bash
python3 -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 3. Sửa `config.py` cho đúng màn hình của bạn

Quan trọng nhất là biến `FORMAT`. Ví dụ:

| Số hiển thị thực tế       | FORMAT      |
|----------------------------|-------------|
| `00012345` (luôn 8 số)     | `"DDDDDDDD"`|
| `123.45` / `12.30`         | `"###D.DD"` |
| `-42` / `4200`             | `"-DDDD"`   |

Quy ước: `D` = luôn có số, `#` = có thể trống (số ngắn hơn khung), `-` = có thể có dấu trừ,
ký tự khác (`.`, `:`...) = ký tự cố định luôn hiển thị. Chi tiết xem comment trong `config.py`.

**Bỏ đúng file font** (.ttf/.otf) của chữ số hiển thị trên màn hình vào thư mục `fonts/`.
Đây là bước ảnh hưởng độ chính xác nhiều nhất — model học đúng hình dạng chữ số thật thì
mới nhận ra chúng ngoài đời. Nếu là màn hình dạng đèn LED/LCD 7 đoạn, tìm font "7-segment"
kiểu `digital-7`, `DSEG7`... (có nhiều bản miễn phí trên mạng) rồi bỏ vào đây.

## 4. Sinh dữ liệu train (synthetic — không cần tự chụp/gán nhãn tay)

Xem thử trước:
```bash
python3 generate_synthetic_data.py --preview
```
Mở `data/synthetic/preview.png` lên kiểm tra: có giống ảnh chụp thật màn hình của bạn
không (font, màu nền/chữ, kiểu ánh sáng)? Nếu palette màu chưa đúng, sửa mảng `PALETTES`
trong `gen_utils.py`. Ổn rồi mới sinh dataset lớn:

```bash
python3 generate_synthetic_data.py --n 30000 --out data/synthetic/train.npz --seed 1
python3 generate_synthetic_data.py --n 3000  --out data/synthetic/val.npz   --seed 2
```
30.000 ảnh mất khoảng vài phút trên máy thường.

## 5. Train

```bash
python3 train.py --epochs 30
```
Kết thúc sẽ in ra 2 số:
- **full-string accuracy**: tỉ lệ đọc ĐÚNG TOÀN BỘ chuỗi số — số quan trọng nhất.
- **per-slot accuracy**: tỉ lệ đúng từng ô riêng lẻ — dùng để biết ô nào hay sai (vd
  hay nhầm dấu chấm, hay nhầm ô đầu) mà điều chỉnh augmentation/dữ liệu.

Chỉ dùng dữ liệu synthetic thường đạt full-string accuracy 90%+ nếu font/màu đã đúng.
Muốn chính xác hơn nữa với ảnh chụp thật ngoài đời → làm tiếp bước 6.

## 6. (Khuyến khích) Fine-tune bằng ảnh chụp thật

Ảnh synthetic dù augment kỹ vẫn không thể giống 100% ảnh chụp thật (moiré màn hình, độ
cong màn hình, phản chiếu thật...). Chụp khoảng 100–300 ảnh thật, đặt tên file = đúng số
hiển thị (xem hướng dẫn đầu file `label_real_images.py`), bỏ vào `data/real/`, rồi:

```bash
python3 label_real_images.py
python3 train.py --epochs 30 --real data/real/real.npz
```
`train.py` sẽ tự nhân bản ảnh thật lên vài lần khi trộn vào tập train (vì thường ít hơn
synthetic rất nhiều) để model "học" đặc điểm ảnh thật rõ hơn.

Mẹo: sau khi có bản demo web (bước 7), chụp lại đúng những trường hợp model đọc SAI ngoài
đời thật, gán nhãn, thêm vào `data/real/`, train lại — lặp lại vài vòng là độ chính xác
tăng rõ rệt (kiểu "active learning" đơn giản).

## 7. Export sang TensorFlow.js

```bash
bash export_tfjs.sh models/screen_digit_ocr.h5 models/tfjs_model
```
Script tự tạo 1 virtualenv riêng (`.venv_tfjs_export`) chỉ để export, vì gói `tensorflowjs`
hay xung đột phiên bản với TensorFlow mới — tách riêng cho khỏi rối. Kết quả nằm trong
`models/tfjs_model/` (model đã nén uint8, ~1/4 kích thước gốc).

## 8. Chạy thử trên trình duyệt / điện thoại

```bash
cp -r models/tfjs_model web/tfjs_model
cd web
python3 -m http.server 8080
```
Mở `http://localhost:8080/predict.html` trên máy tính để test nhanh. Kéo khung xanh vào
đúng vị trí số, kết quả hiện realtime bên dưới.

**Để test trên điện thoại thật**: trình duyệt di động CHỈ cho phép mở camera (`getUserMedia`)
qua HTTPS hoặc `localhost` — `http://<ip-lan>:8080` sẽ KHÔNG xin được quyền camera. Vài cách:
- Nhanh nhất: dùng `ngrok http 8080` (hoặc Cloudflare Tunnel) để có 1 URL HTTPS tạm thời.
- Dùng lâu dài nội bộ: deploy thư mục `web/` lên 1 static hosting miễn phí có HTTPS sẵn
  (GitHub Pages, Cloudflare Pages, Netlify...) — vì đây chỉ là công cụ nội bộ, không cần
  domain riêng, chỉ cần link HTTPS là dùng được trên mọi điện thoại.

`predict.html` là bản demo tối giản để bạn thấy đúng luồng: mở camera → crop ROI → tiền xử
lý ảnh (grayscale, resize) **giống hệt** lúc train → chạy model → giải mã kết quả. Khi tích
hợp vào app thật của bạn, giữ nguyên phần tiền xử lý này (đây là chỗ dễ gây lỗi "train thì
đúng, chạy thực tế thì sai" nhất nếu làm khác đi).

## 9. Vài mẹo tăng độ chính xác thêm

- **ROI phải ổn định**: model học vị trí từng ô ký tự tương đối cố định trong khung ảnh.
  Camera càng giữ đúng góc/khoảng cách mỗi lần đọc, độ chính xác càng cao. Nếu có thể, gắn
  cố định điện thoại/camera bằng giá đỡ thay vì cầm tay.
- Thêm nhiều **palette màu nền/chữ** đúng thực tế vào `PALETTES` (trong `gen_utils.py`) nếu
  màn hình bạn có chế độ sáng/tối khác nhau.
- Nếu hay đọc sai 1 ô cụ thể (xem per-slot accuracy), thường do augmentation chưa mô phỏng
  đúng điều kiện thật ở vùng đó (vd góc đó hay bị lóa) — tăng augmentation tương ứng
  (`glare`, `blur`...) trong `gen_utils.py`.
- Model càng nhỏ (ít tham số) chạy càng nhanh trên điện thoại yếu — nếu dư độ chính xác,
  có thể giảm số filter Conv2D trong `model.py` để tăng tốc độ.

## 10. Hướng nâng cao (nếu số KHÔNG có khuôn dạng cố định)

Nếu độ dài số thay đổi tự do, không theo khuôn nào, kiến trúc multi-head ở trên không phù
hợp (vị trí từng ký tự trong ảnh sẽ thay đổi liên tục). Khi đó cần đổi sang kiến trúc
**CRNN + CTC** (CNN trích đặc trưng theo cột ảnh → BiLSTM → CTC loss), là kiến trúc chuẩn
cho bài toán đọc 1 dòng chữ độ dài bất định (dùng nhiều trong đọc biển số xe). Ý tưởng
tổng quát:
- Input vẫn là ảnh grayscale ROI, nhưng output là 1 chuỗi phân bố xác suất theo từng
  "cột thời gian" thay vì N đầu cố định.
- Train bằng `tf.keras.backend.ctc_batch_cost` hoặc `tf.nn.ctc_loss`.
- Lúc suy luận: giải mã "CTC greedy decode" (gộp ký tự lặp liền nhau, bỏ ký tự "blank").
- Vẫn export sang TensorFlow.js được bình thường, chỉ khác phần code decode ở JS.

Đây là nâng cấp không nhỏ về độ phức tạp, nên chỉ cần khi thực sự gặp phải trường hợp độ
dài số thay đổi tự do — nếu chưa chắc, cứ thử kiến trúc multi-head trước.
