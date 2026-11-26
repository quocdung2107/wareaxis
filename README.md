# Warehouse Assistant (app)

Lệnh dev (chạy trong `app/`): `npm run dev`, `npm run build`, `npm run test`, `npm run lint`, `npm run preview`.

## GĐ1 — Nhập hàng theo đơn mua (PO → Nhận → QC → Cất hàng)

Từ v2 GĐ1, hàng mua vào đi theo quy trình có kiểm soát thay vì nhập tay tự do:

1. **Đơn mua hàng** (mục *Dữ liệu → Đơn mua hàng*): tạo PO chọn nhà cung cấp (tạo nhanh
   NCC ngay trong form), thêm dòng SKU / số lượng / giá dự kiến. PO đi qua các trạng
   thái Nháp → Đã gửi → Đã nhận một phần → Đã nhận đủ → Đã đóng (huỷ được khi còn
   Nháp/Đã gửi). Số PO-xxxx tự tăng, không tái dùng.
2. **Nhận hàng**: bấm *Nhận hàng* trong chi tiết PO, nhập số thực nhận, số hỏng, số lô,
   ngày sản xuất, hạn dùng, giá nhập cho từng dòng. Hệ thống tự tính thiếu/thừa so với
   đơn; mỗi dòng nhận sinh **một lô mới** và hàng vào **khu nhận chờ QC** (chưa bán/lấy được).
3. **QC**: trong phiếu nhận, nhập số đạt / số hỏng cho từng dòng — có hỏng bắt buộc chọn
   lý do; phần hỏng chuyển sang xô hàng hỏng.
4. **Cất hàng (putaway)**: nhập số cất và vị trí đích — app gợi ý sẵn vị trí (ưu tiên vị
   trí đang chứa cùng SKU, rồi vị trí lấy hàng trống theo thứ tự đi lấy, rồi khu hàng
   khối), chọn lại được. Cất xong hàng mới thành tồn khả dụng tại vị trí đó.

Quản lý vị trí ở mục *Dữ liệu → Kho & vị trí* (thêm vị trí, loại vị trí, thứ tự lấy,
bật/tắt). Lần chạy đầu app tự tạo kho chính với vị trí NHAN-01 (khu nhận), A01-01,
A01-02 (kệ lấy hàng).

**Ranh giới tồn kho:** hàng qua PO sống ở sổ cái theo lô (ledger/balances + lots),
tách khỏi tồn nạp file Excel ở các trang cũ — tồn hiển thị của hàng nạp file không
thay đổi, hai nguồn không trộn nhau. Warehouse Server (LAN) có cùng bộ API:
`GET/POST /api/purchase-orders`, `POST /api/purchase-orders/:id/receive`,
`POST /api/receipts/:id/qc`, `POST /api/receipts/:id/putaway`, `GET /api/lots`,
`GET /api/locations` (xem `server/README.md`).

## Triển khai lên GitHub Pages

Địa chỉ app: `https://quocdung2107.github.io/wms/`

Các bước làm một lần trên GitHub (repo `wms`):

1. Mở **Settings > Pages**. Ở mục **Build and deployment > Source**, chọn **GitHub Actions**.
2. Mở **Settings > Secrets and variables > Actions**, chuyển sang tab **Variables**, bấm **New repository variable** và thêm 2 biến:
   - `VITE_SUPABASE_URL` = `https://<project-ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = anon key (public) của project Supabase
   (Lấy ở Supabase: Project Settings > API. Không dùng service_role key.)
3. Mở tab **Actions**, chạy lại workflow deploy (hoặc push lên `main`). Chờ workflow xanh.
4. Mở `https://quocdung2107.github.io/wms/` kiểm tra app tải được.

## Cấu hình Supabase Auth (cho đăng nhập OTP của Order Chat)

Vào Supabase Dashboard > **Authentication > URL Configuration**:

1. **Site URL** = `https://quocdung2107.github.io/wms/`
2. **Redirect URLs** > Add URL = `https://quocdung2107.github.io/wms/`
3. Bấm Save. Thử đăng nhập OTP trên địa chỉ Pages, đảm bảo quay về đúng địa chỉ này.

(Khi dev cục bộ, có thể thêm thêm `http://localhost:5173/` vào Redirect URLs.)

## Cài vào màn hình chính (PWA)

- **iPhone (Safari)**: mở địa chỉ app > nút Chia sẻ > **Thêm vào Màn hình chính** > Thêm.
- **Android (Chrome)**: mở địa chỉ app > menu ba chấm > **Cài đặt ứng dụng** / **Thêm vào màn hình chính**.
- **Máy tính (Chrome/Edge)**: bấm biểu tượng cài đặt ở cuối thanh địa chỉ.

Lần đầu cần có mạng để tải app; sau đó công cụ kho chạy offline.
