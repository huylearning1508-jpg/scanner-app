# V Club Audit Scanner (Web)

Quét audit hàng tuần cho 80 máy slot: camera liveview trên điện thoại tự động đọc
RTP1, RTP2, Machine No, meter Total/Periodic (màn hình Audit) và ngày Clear RAM
(màn hình ngày), nhân viên xác nhận rồi lưu lên Firebase Realtime Database.

Xem chi tiết kiến trúc, quyết định thiết kế và roadmap ở
[`AUDIT_APP_SPEC.md`](AUDIT_APP_SPEC.md).

## Khác biệt so với các bản trước (`rtp app`, `rtp-web` cũ)

Các bản trước dùng OCR tổng quát (ML Kit / Tesseract.js) — đọc được chữ nhưng
chậm (Tesseract ~0.5-2s/frame trên web) nên phải đổi từ liveview sang "ngắm-chụp-đọc"
thủ công. Bản này dùng **model số tự train** (`models/digit_model_64x64.onnx`,
13 lớp: `0-9,%,$,.`) — nhẹ hơn nhiều, cho phép quay lại **liveview tự động**
(tít + đóng băng khi nhận diện ổn định), có nút "Chụp tay" dự phòng khi cần.

## Chạy thử cục bộ

```bash
npx serve . -l 8080
```

Mở `http://localhost:8080` — trình duyệt chặn camera nếu không phải `https://`
hoặc `http://localhost`, nên không mở trực tiếp bằng `file://`.

## Cấu trúc

```
├── index.html
├── css/style.css
├── models/                  # digit_model_64x64.onnx + labels.json
├── js/
│   ├── imageProcessing.js   # OpenCV.js: threshold + dedither + tách dòng/ký tự
│   ├── digitClassifier.js   # onnxruntime-web: batch inference model số
│   ├── ocrEngine.js         # điều phối pipeline nhận diện (thay Tesseract cũ)
│   ├── ocrParser.js         # anchor-"$" (Bước 1) + ngày/năm (Bước 2)
│   ├── cameraController.js  # camera, torch, freeze snapshot
│   ├── csvManager.js        # xuất CSV cục bộ theo phiên
│   ├── firebaseConfig.js    # config project "ocr-rtp"
│   ├── firebaseManager.js   # Realtime Database + Anonymous Auth
│   ├── dataView.js          # tab "Dữ liệu" — bảng đọc realtime từ Firebase
│   ├── util.js               # rung + tiếng bíp
│   └── main.js               # state machine + điều phối UI + 2 tab
├── database.rules.json      # dán vào Firebase Console → Realtime Database → Rules
└── .github/workflows/deploy-pages.yml
```

## Thiết lập Firebase (bắt buộc để đồng bộ dữ liệu)

Project "ocr-rtp" đã cấu hình sẵn trong `js/firebaseConfig.js`, nhưng cần bật tay
trong Firebase Console:

1. **Authentication → Sign-in method → bật Anonymous.** Chưa bật thì console sẽ
   báo lỗi `auth/configuration-not-found` — app vẫn dùng được CSV cục bộ bình
   thường, chỉ là không đồng bộ Firebase.
2. **Realtime Database → Rules** → dán nội dung [`database.rules.json`](database.rules.json)
   → Publish.

## Giới hạn đã biết (Giai đoạn 1)

- Model tháng (chữ, cho ngày Clear RAM) **chưa có** — tháng chọn tay bằng dropdown,
  ngày/năm tự đọc. Xem roadmap Giai đoạn 2 trong `AUDIT_APP_SPEC.md`.
- Chuẩn hoá pixel đầu vào model (chia 255 về [0,1]) là giả định hợp lý nhưng
  **chưa đối chiếu với code train gốc** — nếu độ chính xác thực tế lệch nhiều,
  kiểm tra lại `cropCharTo64()` trong `imageProcessing.js`.
- Chưa test trên điện thoại thật với camera + mạng thật (môi trường phát triển
  không có camera/internet để kiểm tra đầy đủ) — cần test thực địa trước khi
  dùng chính thức cho audit.
