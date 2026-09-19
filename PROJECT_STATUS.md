# Screen Digit OCR — Tóm tắt tiến độ (để tiếp tục ở máy khác)

> File này ghi lại toàn bộ quyết định thiết kế và tiến độ đã trao đổi, để khi mở lại
> project này (kể cả với 1 cuộc trò chuyện Claude mới, ở máy khác) có đủ ngữ cảnh
> tiếp tục ngay, không cần giải thích lại từ đầu. Dán nguyên file này vào đầu cuộc
> trò chuyện mới nếu cần Claude đọc lại.

## 1. Mục tiêu dự án

Xây 1 công cụ dùng camera điện thoại/webcam chụp lại các con số hiển thị trên màn
hình máy tính (màn hình audit/meters của máy slot trong casino), tự động đọc ra số
liệu — thay cho việc gõ tay hoặc dùng Tesseract.js (đang chậm, thiếu chính xác).
Giải pháp: train 1 model CNN nhỏ, gọn, chạy được ngay trong trình duyệt (TensorFlow.js)
trên cả iOS lẫn Android, không cần build app native, không cần đưa lên app store.

Toàn bộ code nằm trong project **`screen-digit-ocr`** (đã gửi dưới dạng file zip
trong cuộc trò chuyện trước, người dùng đã giải nén vào `D:\Huy\screen-digit-ocr`
trên máy Windows, đã cài `requirements.txt`, đã thêm font `arial.ttf`, `arialbd.ttf`,
`segoeui.ttf`, `segoeuib.ttf` vào thư mục `fonts/`).

## 2. Kiến trúc đã chọn

CNN dùng chung (backbone) + nhiều "đầu" (head) phân loại, mỗi đầu đoán đúng 1 ô
ký tự cố định — KHÔNG dùng CRNN/CTC (chỉ cần khi số dài ngắn tự do không theo khuôn
nào, hiện tại chưa cần). Model nhẹ (~1.7MB sau khi nén qua TensorFlow.js), chạy
real-time trên điện thoại.

Dữ liệu train không tự chụp/gán nhãn tay — dùng `generate_synthetic_data.py` để
TỰ VẼ hàng chục nghìn ảnh số bằng đúng font hiển thị thật + giả lập các kiểu méo
ảnh khi chụp qua camera (nghiêng, mờ, lóa sáng, nhiễu, nén JPEG...).

## 3. QUYẾT ĐỊNH QUAN TRỌNG NHẤT (mới chốt, đã sửa vào code): model chỉ đọc SỐ THÔ

Ban đầu thiết kế mỗi model gắn với 1 định dạng cụ thể (có dấu `.`, `%`, `$`...).
Sau khi xem ảnh thực tế màn hình audit (nhiều dòng số khác kiểu nhau: `92.734%`,
`93.63%`, `12`, `$0.01`...), đã đổi sang cách tiếp cận gọn hơn nhiều:

- **Model chỉ cần đọc đúng chuỗi CHỮ SỐ THÔ (0-9)**, không cần biết gì về `.`, `%`,
  `$`, dấu trừ. Điều này giúp DÙNG CHUNG 1 model cho mọi dòng số khác nhau trên màn
  hình (mỗi dòng vẫn crop ROI — vùng ảnh cắt — riêng theo đúng vị trí của nó trên
  màn hình, nhưng chỉ cần train 1 model duy nhất, áp dụng lại ở nhiều vị trí).
- Việc "hiểu" chuỗi số đó nghĩa là gì (chia 1000 ra %, chia 100 ra tiền, thêm dấu
  `$`, kiểm tra có nằm trong khoảng hợp lý không — ví dụ % phải trong khoảng 0-100)
  do 1 **lớp luật riêng ở phía ứng dụng** xử lý sau khi model đọc xong số thô. Lớp
  luật này KHÔNG PHẢI machine learning, chỉ là code thường (if/else, chia, nhân),
  và **CHƯA ĐƯỢC VIẾT** — đây là việc cần làm tiếp (xem mục 6).
- `config.py` đã sửa: `CHARSET = "0123456789"` (bỏ hẳn `.` và `-`),
  `FORMAT = "####D"` (5 ô: 4 ô đầu có thể trống dùng cho số ngắn, ô cuối luôn có số
  — đủ chứa số từ 1 đến 5 chữ số, khớp với dòng dài nhất hiện tại là `92734`, 5 số).
- Đã test chạy `generate_synthetic_data.py --preview` trên máy người dùng, ra ảnh
  đúng như kỳ vọng (chỉ còn số thô, không còn ký hiệu), dùng đúng font Arial/Segoe UI.

## 4. Bối cảnh 2 tấm ảnh mẫu người dùng đã gửi (căn cứ để thiết kế)

**Ảnh 1** — màn hình audit/meters máy slot, các dòng giá trị cần đọc (từ dòng có `%`
đầu tiên xuống tới dòng cuối cùng có `$`, không có `N/A` trong dữ liệu thật của họ):
- 1 khoảng phần trăm dạng `xx.xxx%-xx.xxx%` (bị cắt số đầu trong ảnh mẫu)
- `0.000%` (3 số thập phân)
- `92.734%` (3 số thập phân)
- `93.63%` (2 số thập phân — khác kiểu với 2 dòng trên, CẦN người dùng xác nhận lại
  xem đúng là 2 số lẻ hay ảnh mờ đọc thiếu 1 số)
- `12` (số đếm trơn, không %)
- `$0.01` (tiền, luôn 2 số lẻ)

Các dòng này có nhiều kiểu định dạng khác nhau, chưa tìm được "mốc" (landmark) cố
định nào trên giao diện để tự động dò vị trí ROI — người dùng xác nhận HIỆN TẠI CHƯA
CÓ rule tự động cho các dòng này, nên tạm thời dùng cách **canh tay ROI cố định**
(kéo khung 1 lần, giữ nguyên vị trí camera/màn hình mỗi lần đọc sau này).

**Ảnh 2** — dòng ngày giờ dạng `Mon 23 Mar 2026 07:50:05`:
- Người dùng CHỈ cần đọc **ngày / tháng / năm**, xuất ra dưới dạng SỐ (vd tháng
  "Mar" → xuất ra số `3`). KHÔNG cần đọc thứ trong tuần ("Mon") — bỏ hẳn.
- Vì tháng hiển thị bằng CHỮ (Jan-Dec), không dùng chung được với model đọc số thô
  ở trên — cần 1 model/đầu phân loại RIÊNG, chọn đúng 1 trong 12 tên tháng, rồi
  tự quy đổi thành số (bảng tra đơn giản, không phức tạp). **CHƯA ĐƯỢC VIẾT.**
- Ngày và năm là số thuần, dùng chung được với model đọc số thô ở mục 3.
- Người dùng xác nhận: giao diện có thanh tab màu ĐEN cố định phía trên, phần nội
  dung màu TRẮNG bên dưới — dòng ngày-giờ luôn là dòng ĐẦU TIÊN của phần trắng, và
  chiều cao thanh đen này LUÔN CỐ ĐỊNH mỗi lần mở màn hình đó. → Có thể viết 1 rule
  tự động dò ranh giới đen-trắng để tự định vị ROI dòng ngày-giờ, KHÔNG cần canh tay
  (khác với các dòng ở ảnh 1). **RULE NÀY CHƯA ĐƯỢC VIẾT**, mới dừng ở mức ý tưởng
  đã thống nhất.

## 5. Trạng thái các file trong project (đã làm / chưa làm)

Đã có sẵn và HOẠT ĐỘNG ĐÚNG (đã test):
- `config.py` — đã cập nhật theo thiết kế mới (mục 3).
- `gen_utils.py`, `generate_synthetic_data.py` — sinh dữ liệu synthetic, đã test
  chạy `--preview` thành công trên máy người dùng với font thật.
- `model.py` — kiến trúc CNN multi-head, đã build & smoke-test thành công.
- `train.py` — script train, đã smoke-test end-to-end (chạy được, chưa train thật
  với dữ liệu lớn).
- `label_real_images.py` — đóng gói ảnh thật đã gán nhãn qua tên file thành dữ liệu
  fine-tune, đã test.
- `export_tfjs.sh` — export model sang TensorFlow.js, đã test chạy được (có script
  tự tạo venv riêng vì hay xung đột phiên bản).
- `web/predict.html` — demo web mở camera, đọc 1 ROI, chạy model, hiện kết quả —
  ĐÂY LÀ DEMO 1 ROI DUY NHẤT, CHƯA hỗ trợ nhiều ROI cho nhiều dòng số khác nhau.
- `README.md` — hướng dẫn tổng thể (viết theo thiết kế CŨ, có đoạn nhắc `.`/`%`/`-`
  trong FORMAT — cần cập nhật lại cho khớp thiết kế mới ở mục 3).

CHƯA LÀM (việc cần làm tiếp, xem mục 6):
- Lớp luật hậu xử lý (post-processing rules) cho từng dòng ở ảnh 1.
- Model/đầu phân loại 12 tháng riêng cho ảnh 2.
- Rule tự động dò ROI dòng ngày-giờ dựa vào ranh giới đen-trắng.
- Cập nhật `web/predict.html` để hỗ trợ NHIỀU ROI cùng lúc (hiện chỉ có 1).
- Cập nhật lại `README.md` cho khớp thiết kế mới.

## 6. Tiến độ thực hiện trên máy người dùng (Windows, `D:\Huy\screen-digit-ocr`)

- Đã cài xong `requirements.txt`.
- Đã thêm font thật (`arial.ttf`, `arialbd.ttf`, `segoeui.ttf`, `segoeuib.ttf`) vào
  `fonts/`.
- Đã sửa `config.py` theo thiết kế mới, đã test `--preview` thành công.
- Đang ở bước: chạy `generate_synthetic_data.py` để sinh tập `train.npz`/`val.npz`
  đầy đủ (30.000 / 3.000 mẫu), rồi chạy `train.py --epochs 30` — **CHƯA CÓ KẾT QUẢ
  TRAIN THẬT** (chưa biết full-string accuracy là bao nhiêu).
- Lưu ý: máy người dùng gặp lỗi cú pháp khi copy lệnh nhiều dòng vào PowerShell bị
  ngắt dòng giữa chừng (`--out` bị thiếu giá trị) — cần gõ nguyên 1 dòng lệnh, không
  ngắt giữa chừng.

## 7. Việc cần làm tiếp theo, theo đúng thứ tự ưu tiên

1. Người dùng chạy xong `generate_synthetic_data.py` (train + val) và `train.py`,
   báo lại kết quả full-string accuracy / per-slot accuracy.
2. Dựa vào kết quả đó, quyết định có cần chỉnh augmentation/dữ liệu gì thêm không.
3. Viết lớp luật hậu xử lý cho từng dòng ở ảnh 1 (chia tỉ lệ, thêm ký hiệu, kiểm
   tra khoảng hợp lệ).
4. Viết thêm model/đầu phân loại 12 tháng cho ảnh 2, cộng bảng quy đổi tên tháng
   → số.
5. Viết rule tự động dò ROI dòng ngày-giờ dựa vào ranh giới đen-trắng của giao diện.
6. Nâng cấp `web/predict.html` để đọc được nhiều ROI cùng lúc (không chỉ 1 như hiện
   tại), áp đúng luật hậu xử lý cho từng ROI.
7. (Tùy chọn, đã bàn trước đó) Thu thập ~100-300 ảnh chụp thật, dùng
   `label_real_images.py` để fine-tune model cho sát với điều kiện chụp thực tế
   (ánh sáng, góc camera...) — có thể nhờ Claude đọc số từ ảnh thật để hỗ trợ gán
   nhãn nhanh hơn, dùng `label_real_images.py` để đóng gói ngay sau đó.
8. Cập nhật lại `README.md` cho khớp thiết kế mới (mục 3).

## 8. Vài nguyên tắc/quyết định phụ đã thống nhất trong lúc trao đổi (đừng làm lại)

- KHÔNG dùng CTC/CRNN trừ khi sau này gặp trường hợp số dài ngắn hoàn toàn tự do,
  không theo khuôn nào — hiện tại multi-head vẫn đủ dùng.
- KHÔNG cần xử lý giá trị `N/A` trong model — dữ liệu thật của người dùng không có
  trường hợp này.
- Về việc hiệu chỉnh augmentation (độ mờ, lóa sáng, góc nghiêng...) cho sát thực tế:
  đã thống nhất cách làm là đo từ ảnh thật (Laplacian variance cho độ mờ, phân vị
  5%-95% cho khoảng "lõi", rồi nới thêm ~20% biên) thay vì đoán mò — nhưng PHẦN NÀY
  CHƯA LÀM, chỉ mới bàn ý tưởng, chưa có ảnh thật để đo.
