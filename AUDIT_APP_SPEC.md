# V Club Audit Scanner App — Spec

Ứng dụng web (PWA) cho nhân viên club dùng camera điện thoại (liveview) để audit hàng tuần 80 máy slot: tự động đọc RTP1, RTP2, machine number, meter Total/Periodic (từ màn hình Audit/Accounting Information) và ngày clear RAM (từ màn hình ngày). Toàn bộ xử lý ảnh chạy trên thiết bị (client-side), chỉ gửi giá trị số cuối cùng đã xác nhận lên Firebase.

## Bối cảnh nghiệp vụ

- Club vận hành 80 máy slot, audit định kỳ **1 lần/tuần/máy**.
- Nhân viên chụp bằng **camera liveview** trong app (không upload ảnh có sẵn).
- Thứ tự chụp **cố định**: Bước 1 = màn hình Audit/Accounting Information, Bước 2 = màn hình ngày (RAM clear date). Không cần tự động nhận diện loại màn hình.
- Chỉ 1-2 loại layout màn hình cố định trên toàn bộ 80 máy (cùng model/firmware).

## Phạm vi dữ liệu cần đọc

| Trường | Nguồn | Range hợp lệ |
|---|---|---|
| RTP1 | Màn Audit | 80–99 (%) |
| RTP2 | Màn Audit | 80–99 (%) |
| Machine No | Màn Audit | 0–900 (nguyên) |
| Total/Periodic meters | Màn Audit | số nguyên, không giới hạn cụ thể |
| Ngày clear RAM (ngày/tháng/năm) | Màn ngày | — |

Bỏ qua: header/label chữ, dòng range tham chiếu (vd ".505%-93.556%"), ký hiệu `¢`, thứ trong tuần, giờ:phút:giây. Ngày clear RAM là dữ kiện độc lập với ngày chụp — **bắt buộc đọc từ ảnh**, không dùng timestamp chụp.

## Model nhận diện

- `D:\Huy\final\number model\digit_model_64x64.onnx` — classifier 64×64, 13 lớp: `0-9, %, $, .`. Đủ cho toàn bộ phạm vi dữ liệu Giai đoạn 1 (không cần thêm `-` hay `¢`).
- Model tên tháng (chữ, cho màn ngày) — **chưa train, sẽ làm ở Giai đoạn 2**.

## Kiến trúc

### Client (PWA, React + Vite)
- Camera liveview (`getUserMedia`) với khung ngắm overlay theo từng bước chụp.
- Xử lý ảnh 100% tại thiết bị:
  1. De-skew cơ bản (không cần rectify tuyệt đối chính xác pixel).
  2. Adaptive threshold (`blockSize=21, C=12`) ép nền về trắng.
  3. Tẩy hạt dither bằng connected-components + overlap mask với nét chữ gốc mở rộng.
  4. Tách từng dòng bằng horizontal projection profile (không dùng ROI toạ độ cố định).
  5. Tách ký tự trong từng dòng, resize 64×64.
  6. Chạy `onnxruntime-web` + `digit_model_64x64.onnx` (Model 1.2 — bản "10-Segments Drop", chịu được segment mờ/rớt nét) để nhận diện từng ký tự, ghép chuỗi.
- **Field detection kiểu anchor-relative** (không dùng ROI toạ độ tuyệt đối):
  - Tìm dòng chứa ký tự `$` làm anchor (ký tự đặc trưng, khó nhầm).
  - `anchor-1` = Machine No, `anchor-2` = RTP2, `anchor-3` = RTP1.
  - Total/Periodic đọc theo cột ở phần trên màn Audit.
  - Không tìm thấy anchor `$` → toàn bộ audit đó confidence thấp → bắt buộc xác nhận tay.
- **Fallback mất dấu chấm** (RTP only): nếu không đọc được `.` trong chuỗi số, chèn dấu chấm sau đúng 2 chữ số đầu (`raw / 10^(len-2)`), đánh dấu "tự sửa – cần xác nhận".
- **Validate**: Machine No ∈[0,900], RTP1/RTP2∈[80,99] — sai luật → hạ confidence.
- **Ổn định phát hiện**: yêu cầu 2-3 frame liên tiếp cho cùng kết quả + confidence đạt ngưỡng → phát tiếng tít, đóng băng hình hiện tại, chuyển màn hình xác nhận (Machine No hiện nổi bật trước, các trường khác bên dưới).
- Màn hình ngày (Bước 2): ngày + năm tự đọc qua cùng pipeline; **tháng = dropdown chọn tay** (Giai đoạn 1), thay bằng model tự động ở Giai đoạn 2.
- Nhân viên xác nhận/sửa → chỉ gửi **giá trị số cuối cùng** lên Firebase, không gửi ảnh.
- PWA, cài lên màn hình chính điện thoại nhân viên.

### Backend — Firebase
- **Firebase Hosting**: serve PWA, tự có HTTPS (bắt buộc để trình duyệt cho phép mở camera).
- **Firebase Realtime Database** (`asia-southeast1`):
  - `/machines/{machineId}`
  - `/field_readings/{captureId}`: `machine_no`, `rtp1`, `rtp2`, `total_meters`, `periodic_meters`, `ram_clear_date`, `confidence` (theo từng field), `auto_corrected` (bool, đánh dấu case fallback dấu chấm), `confirmed_at`.
- **Firebase Auth**: 1 tài khoản chung cho cả club, Security Rules chỉ cho phép user đã đăng nhập ghi dữ liệu.
- Không lưu ảnh gốc ở bất kỳ đâu.

### Giao diện (Home page — 2 tab)
- **Tab 1 — Dữ liệu**: bảng kiểu Excel (Machine No | RTP1 | RTP2 | Clear RAM Date | ...), đọc từ Realtime Database, có thể lọc/sắp xếp theo máy hoặc theo tuần.
- **Tab 2 — Quét**: camera liveview auto-detect như mô tả ở trên.

## Roadmap

### Giai đoạn 1 (hiện tại — chỉ có model số)
1. Setup Firebase project (Hosting, Realtime DB schema, Auth 1 tài khoản chung, Security Rules).
2. Scaffold PWA (React + Vite), 2 tab (Dữ liệu / Quét).
3. Tab Dữ liệu: đọc + hiển thị bảng từ Realtime DB.
4. Tab Quét: camera liveview + khung ngắm overlay.
5. Pipeline xử lý ảnh client-side: de-skew, threshold, dedither, tách dòng/ký tự, chạy model số.
6. Anchor-relative field detection + validate + fallback dấu chấm.
7. UX ổn định-phát hiện: tít, đóng băng, màn xác nhận, ghi Firebase.
8. Bước ngày: ngày/năm tự đọc, tháng dropdown tay.

### Giai đoạn 2 (khi có model tháng)
1. Train + tích hợp model/template-matching nhận diện tháng.
2. Thay dropdown tay bằng auto-read tháng (giữ dropdown làm fallback khi confidence thấp).
3. Tinh chỉnh dựa trên dữ liệu thực tế thu thập từ Giai đoạn 1 trên 80 máy.
