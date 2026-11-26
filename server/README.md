# Warehouse Server — máy chủ kho chạy tại chỗ (localhost)

Đây là "app chính" của một kho: chạy trên **một máy tính đặt tại kho**,
giữ toàn bộ dữ liệu tồn kho của kho đó. Điện thoại của thủ kho kết nối
vào máy này qua **Wi-Fi nội bộ của kho** và làm việc theo phân quyền.
Dữ liệu công ty **không đi ra ngoài kho** — không dùng Supabase cho tồn kho
(Supabase chỉ dùng cho danh bạ xe / chat đơn hàng / theo dõi đơn).

## Chuẩn bị (làm 1 lần trên máy tính tại kho)

1. Cài **Node.js** bản LTS từ https://nodejs.org (cài như phần mềm bình thường, cứ Next).
2. Tải/copy thư mục dự án về máy, mở thư mục dự án.
3. (Tuỳ chọn nhưng nên làm) Đặt mật khẩu quản trị riêng và mã kho — xem mục "Đổi mật khẩu" bên dưới.

## Chạy server

Trong thư mục dự án, chạy lệnh:

```
npm run server
```

Server mở ở cổng **8787**. Khi chạy, màn hình sẽ in ra:

- Địa chỉ mở trên chính máy tính này: `http://localhost:8787`
- Địa chỉ cho điện thoại, dạng `http://192.168.x.x:8787` — điện thoại phải
  **cùng mạng Wi-Fi với máy tính kho** mới mở được.

Để server tự chạy khi mở máy: tạo shortcut tới lệnh trên trong thư mục
Startup của Windows, hoặc dùng Task Scheduler (việc này làm sau, khi đã
chạy thử ổn định).

## Tài khoản quản trị mặc định — BẮT BUỘC ĐỔI

- Tên đăng nhập: `admin`
- Mật khẩu mặc định: `doi-mat-khau-ngay` — **chỉ để chạy thử lần đầu**.
  Khi dùng thật, đặt mật khẩu riêng bằng biến môi trường trước khi chạy:

```
# Windows (cmd), trong thư mục dự án:
set WMS_ADMIN_USER=admin
set WMS_ADMIN_PASS=mat-khau-rieng-cua-kho
set WMS_WAREHOUSE_CODE=KHO-01
npm run server
```

Lưu ý: mật khẩu quản trị chỉ được tạo **ở lần chạy đầu tiên** (khi chưa có
tài khoản nào). Đổi biến môi trường sau đó không tự đổi mật khẩu đã tạo.

## Điện thoại của thủ kho

1. Điện thoại nối Wi-Fi của kho, mở địa chỉ `http://192.168.x.x:8787`.
2. Đăng nhập bằng tài khoản được cấp, rồi **đăng ký thiết bị**
   (API `POST /api/devices/register`) — thiết bị ở trạng thái chờ duyệt.
3. Người quản trị trên máy tính trung tâm **duyệt thiết bị**
   (`POST /api/devices/:id/approve`). Chưa duyệt thì điện thoại không gọi
   được API nghiệp vụ. Mất điện thoại: thu hồi (`.../revoke`) là khoá ngay,
   các phiên đăng nhập của thiết bị đó cũng bị huỷ.
4. Mỗi thao tác tồn kho đều ghi tên người làm — không còn cảnh "không biết
   ai sửa tồn".

> Giao diện điện thoại đầy đủ (màn hình đăng nhập/đăng ký thiết bị trong app)
> thuộc phần UI của giai đoạn sau; bản GĐ-LAN này hoàn thiện phía server/API.

## Sao lưu — tuyến bảo vệ dữ liệu duy nhất

Vì dữ liệu không lên cloud, **phải sao lưu đều**:

- Gọi `POST /api/admin/backup` (tài khoản quản trị) để chép DB vào
  `server/data/backups/` kèm thời gian.
- Nên chép thêm thư mục `server/data/backups/` ra USB / ổ NAS trong kho
  theo lịch. Mất máy tính trung tâm mà không có sao lưu = mất dữ liệu kho.

## Liên kho (Federation) — khi có nhiều kho/đại lý

Mỗi kho chạy server riêng, độc lập. Khi cần tra tồn của kho khác:

- Đặt khoá liên kho giống nhau ở các kho cần tra nhau:
  `set WMS_FEDERATION_KEY=khoa-bi-mat-dai-va-kho-doan`
- Kho khác tra qua `GET /federation/v1/inventory/availability?sku=...`
  kèm header `x-federation-key`. Chỉ xem được **số lượng tồn khả dụng** —
  không xem được giá vốn, nhà cung cấp, lịch sử biến động.
- Chưa đặt khoá thì API trả `503 federation_not_configured` (tắt hẳn).

## CẢNH BÁO AN TOÀN

- **KHÔNG mở cổng 8787 ra Internet** (không port-forward trên router).
  Server này chỉ dành cho mạng nội bộ của kho.
- Muốn liên kho qua Internet: dùng **VPN riêng như Tailscale/WireGuard**
  nối các kho lại, API liên kho đi trong VPN — không phơi server ra ngoài.
- Tắt Internet thì kho vẫn làm việc bình thường (trừ tính năng liên kho
  và các tính năng chia sẻ trên Supabase của app chính).

## API nhập hàng GĐ1 (PO → Nhận → QC → Cất hàng)

Cùng quy trình như trên app, cho điện thoại/tích hợp qua LAN (đều cần đăng nhập +
thiết bị đã duyệt; quyền ghi trong ngoặc):

| Endpoint | Quyền | Việc |
|---|---|---|
| `GET /api/purchase-orders` (`?status=`) | inventory_view | Danh sách PO |
| `POST /api/purchase-orders` | purchase_create | Tạo PO (body: `lines: [{sku, qty_ordered, unit_price?}]`) |
| `GET /api/purchase-orders/:id` | inventory_view | PO + dòng + các phiếu nhận |
| `POST /api/purchase-orders/:id/transition` | purchase_create | Chuyển trạng thái thủ công (`{to: 'SENT' \| 'CANCELLED' \| 'CLOSED'}`) |
| `POST /api/purchase-orders/:id/receive` | purchase_receive | Nhận hàng: sinh phiếu nhận + lô mới, tồn vào xô chờ QC tại vị trí nhận |
| `POST /api/receipts/:id/qc` | inventory_receive | QC đạt/hỏng (`{receipt_line_id, qty_pass, qty_fail, reason_code?}` — hỏng bắt buộc lý do) |
| `POST /api/receipts/:id/putaway` | inventory_putaway | Cất phần đạt lên vị trí đích (`{receipt_line_id, qty, to_location_id}`) |
| `GET /api/lots` (`?sku=`) | inventory_view | Danh sách lô |
| `GET /api/locations` | inventory_view | Kho + khu + vị trí |

Lần chạy đầu server tự seed kho chính (MAIN) với vị trí NHAN-01 (nhận hàng),
A01-01, A01-02 (lấy hàng) nếu chưa có kho nào.

## Kiểm thử server (cho người kỹ thuật)

```
node server/test-smoke.mjs
```

Script tự mở server ở cổng test với DB tạm, chạy hết luồng
đăng nhập → duyệt thiết bị → biến động tồn → liên kho → GĐ1 (PO → nhận →
QC → cất hàng → kiểm balances) → sao lưu,
xong tự dọn. Không nằm trong `npm test` chính vì cần mở cổng mạng.

## Các biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `WMS_PORT` | `8787` | Cổng server |
| `WMS_WAREHOUSE_CODE` | `KHO-01` | Mã kho này (hiện trong federation/health) |
| `WMS_ADMIN_USER` / `WMS_ADMIN_PASS` | `admin` / `doi-mat-khau-ngay` | Tài khoản quản trị tạo ở lần chạy đầu |
| `WMS_FEDERATION_KEY` | (trống = tắt) | Khoá cho API liên kho chỉ-đọc |
| `WMS_DATA_DIR` | `server/data` | Thư mục chứa DB + backups |
| `WMS_DB_PATH` | `server/data/warehouse.db` | Đường dẫn file DB (chủ yếu cho test) |
