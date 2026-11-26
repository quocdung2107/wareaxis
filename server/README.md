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

Mỗi kho chạy server riêng, độc lập. Liên kho chỉ **đọc ở mức truy vấn** —
không có CSDL tồn trung tâm, không kho nào sửa được tồn của kho khác.

**Khoá liên kho (GĐ4 — cấp theo từng phía):**

- Cách chính: người có quyền `federation_manage` tạo khoá qua API
  `POST /api/federation/keys` (hoặc mục Liên kho trong app). Server trả
  khoá plaintext **đúng 1 lần** và chỉ lưu **băm SHA-256** — cấp khoá đó
  cho phía portal/kho kia để họ gọi vào. Mỗi khoá có chính sách riêng:
  `share_available` (tồn khả dụng), `share_low_stock` (tồn thấp),
  `share_cost_price` (giá vốn — **mặc định tắt**, chỉ bật khi thật cần).
  Thu hồi: `POST /api/federation/keys/:id/revoke`; sửa chính sách:
  `PUT /api/federation/keys/:id/policy`.
- Cách cũ vẫn chạy: đặt `WMS_FEDERATION_KEY=khoa-bi-mat-dai-va-kho-doan`
  thì khoá đó hoạt động như "khoá hệ thống" với chính sách mặc định
  (chỉ availability, không giá vốn, không tồn thấp).
- Chưa có khoá nào thì API trả `503 federation_not_configured` (tắt hẳn).
- Mọi truy vấn (kể cả bị chặn) đều ghi `federation_query_logs`: xem qua
  `GET /api/federation/query-log` (100 dòng mới nhất).

**API chỉ-đọc cho kho khác/portal** (header `x-federation-key`):

- `GET /federation/v1/ping` — kiểm tra sống (không cần khoá).
- `GET /federation/info` — mã kho, tên kho, giờ server, phiên bản.
- `GET /federation/v1/inventory/availability?sku=...` — tồn khả dụng:
  `rows` chuẩn hoá theo SKU/lô kèm hạn dùng (giá vốn chỉ có khi khoá bật
  `share_cost_price`) + `balances` chi tiết theo vị trí (tương thích cũ).
- `GET /federation/low-stock` — SKU dưới mức tối thiểu; khoá chưa bật
  `share_low_stock` thì trả `403 share_low_stock_disabled`.

**Cổng liên kho (Portal) — chạy ngay trong server này:**

1. Chọn 1 máy chạy portal (máy văn phòng hoặc máy trung tâm của 1 kho).
2. Thêm từng kho peer qua API (quyền `federation_manage`):
   `POST /api/portal/peers` với `{name, base_url, api_key}` — `base_url`
   là địa chỉ của kho đích **trong VPN** (ví dụ `http://100.64.0.2:8787`
   của Tailscale), `api_key` là khoá kho đích đã cấp cho portal này.
   Kiểm tra kết nối: `POST /api/portal/peers/:id/test`.
3. Mở trang portal: `http://<địa chỉ máy portal>:8787/portal` — dán token
   phiên đăng nhập 1 lần (trang lưu ở sessionStorage), tra SKU để xem tồn
   mọi kho + tổng toàn hệ thống, trạng thái online/offline và tồn thấp.
   Portal gọi từng kho với timeout 3 giây; kho không liên lạc được thì
   portal hiển thị **bản cache gần nhất kèm nhãn "số liệu cũ" và thời
   điểm** — cache chỉ để hiển thị minh bạch, không phải dữ liệu trung tâm.
4. API của portal: `GET /api/portal/availability?sku=`,
   `GET /api/portal/status`, `GET /api/portal/low-stock` (phiên đăng nhập
   thường + quyền `inventory_view`).

> **Bảo vệ file dữ liệu:** portal cần lưu khoá của các kho đích trong
> `server/data/warehouse.db` để gọi đi — hãy coi thư mục `server/data/`
> như mật khẩu: chỉ tài khoản máy đó đọc được, sao lưu có kiểm soát,
> không chia sẻ file DB ra ngoài.

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

## API xuất kho GĐ2 (Đơn xuất → Phân bổ → Wave → Pack → Ship → Trả hàng)

Chỉ áp cho hàng theo lô của sổ cái (hàng nhận qua PO ở GĐ1). Đơn Supabase chỉ
lưu tham chiếu (`external_ref`, tên xe dạng text) — không sửa luồng Orders.

| Endpoint | Quyền | Việc |
|---|---|---|
| `GET /api/outbound-orders` (`?status=`) | inventory_view | Danh sách đơn xuất |
| `POST /api/outbound-orders` | outbound_allocate | Tạo đơn xuất (body: `lines: [{sku, qty_ordered}]`, `source`, `external_ref?`, `customer_name?`, `carrier_text?`) |
| `GET /api/outbound-orders/:id` | inventory_view | Đơn + dòng + allocations (+ backorder từng dòng) |
| `POST /api/outbound-orders/:id/allocate` | outbound_allocate | Phân bổ FEFO/FIFO (`{policy?}`) — giữ chỗ ALLOCATE, thiếu → PARTIAL_ALLOCATED |
| `POST /api/outbound-orders/:id/cancel` | outbound_allocate | Huỷ đơn chưa lấy — nhả giữ chỗ (DEALLOCATE) |
| `GET /api/waves` | inventory_view | Danh sách wave |
| `POST /api/waves` | outbound_pick | Tạo wave từ các đơn đã phân bổ (`{order_ids, carrier_text?, cutoff?}`) — sinh pick task theo lộ trình |
| `GET /api/waves/:id/tasks` | inventory_view | Wave + danh sách pick task (kèm phần allocation của từng task) |
| `POST /api/pick-tasks/:id/confirm` | outbound_pick | Xác nhận lấy (`{qty}`) — lấy thiếu tự nhả giữ chỗ về backorder |
| `POST /api/outbound-orders/:id/pack` | outbound_pack | Ghi đóng gói kiểm chứng (`{scans: [{sku, qty}]}`) — sai SKU/vượt đã lấy bị chặn; đủ → PACKED |
| `POST /api/outbound-orders/:id/ship` | outbound_ship | Giao hàng (`{carrier_text?, tracking_text?}`) — tạo phiếu giao kèm lô gốc, đơn COMPLETED |
| `GET /api/shipments` / `GET /api/shipments/:id` | inventory_view | Phiếu giao (+ dòng kèm lot_id) |
| `POST /api/shipments/:id/returns` | returns_receive | Nhận hàng trả (`{lines: [{shipment_item_id, qty, reason?}]}`) — về xô chờ QC của lô gốc |
| `POST /api/returns/:id/qc` | inventory_receive | QC hàng trả (`{return_line_id, qty_pass, qty_fail, reason_code?}` — hỏng bắt buộc lý do) |
| `POST /api/returns/:id/putaway` | inventory_putaway | Cất hàng trả đã QC đạt (`{return_line_id, qty, to_location_id}`) |
| `GET /api/returns` | inventory_view | Phiếu trả + dòng |

## API vận hành kho GĐ3 (Kiểm kê quay vòng → Đóng băng → Chuyển kho → Gợi ý đặt hàng → Cảnh báo)

Chỉ áp cho hàng theo lô của sổ cái. Mọi thay đổi tồn đều qua movement kèm
lý do khi thuộc nhóm bắt buộc.

| Endpoint | Quyền | Việc |
|---|---|---|
| `GET /api/cycle-counts` / `GET /api/cycle-counts/:id` | inventory_view | Phiên kiểm kê (+ dòng kiểm) |
| `POST /api/cycle-counts` | inventory_count | Tạo phiên theo phạm vi (`{scope_type: LOCATION\|ZONE\|SKU, location_id?/zone_id?/sku?, blind?}`) — snapshot từ balances |
| `POST /api/cycle-counts/:id/count` | inventory_count | Nhập số đếm (`{entries: [{task_id, counted_qty}]}`) — đủ mọi dòng → COUNTED |
| `POST /api/cycle-counts/:id/approve` | inventory_adjust | Duyệt + áp chênh lệch (ADJUST_IN/OUT, lý do COUNT_VARIANCE) → APPLIED |
| `POST /api/cycle-counts/:id/reject` | inventory_adjust | Từ chối phiên (đếm lại) |
| `POST /api/inventory/freeze` | inventory_adjust | Đóng băng (`{sku, lot_id, location_id, warehouse_id?, qty, reason_code}` — lý do bắt buộc thuộc danh mục) |
| `POST /api/inventory/unfreeze` | inventory_adjust | Mở băng (`{sku, lot_id, location_id, warehouse_id?, qty}`) |
| `GET /api/inventory/frozen` | inventory_view | Danh sách đang đóng băng kèm lý do/người băng gần nhất |
| `POST /api/inventory/move` | inventory_transfer | Chuyển vị trí trong kho (`{sku, lot_id, warehouse_id?, from_location_id, to_location_id, qty}`) — chỉ chuyển phần khả dụng |
| `GET /api/transfer-orders` / `GET /api/transfer-orders/:id` | inventory_view | Phiếu chuyển kho (+ dòng) |
| `POST /api/transfer-orders` | inventory_transfer | Tạo phiếu (`{from_warehouse_id, to_warehouse_id, lines: [{sku, lot_id, from_location_id, to_location_id, qty}]}`) — số CK-xxxx |
| `POST /api/transfer-orders/:id/ship` | inventory_transfer | Xuất kho nguồn (TRANSFER_OUT → đang chuyển) |
| `POST /api/transfer-orders/:id/receive` | inventory_transfer | Nhận kho đích (TRANSFER_IN hai phía) → DONE |
| `POST /api/transfer-orders/:id/cancel` | inventory_transfer | Huỷ phiếu nháp |
| `GET /api/stock-policies` | inventory_view | Chính sách tồn min/max |
| `PUT /api/stock-policies` | inventory_view | Đặt/sửa chính sách (`{sku, warehouse_id?, min_qty, max_qty, reorder_point, reorder_qty}`) |
| `GET /api/replenishment/suggestions` | inventory_view | Gợi ý đặt hàng đã gom theo NCC mặc định |
| `POST /api/replenishment/create-pos` | purchase_create | Tạo PO nháp DRAFT từ gợi ý (nhóm chưa rõ NCC bị bỏ qua) |
| `PUT /api/products/default-supplier` | purchase_create | Gán NCC mặc định cho SKU (`{sku, supplier_id}`) |
| `GET /api/suppliers` / `POST /api/suppliers` | inventory_view / purchase_create | Danh sách / tạo nhà cung cấp |
| `POST /api/warehouses` / `POST /api/locations` | inventory_transfer | Tạo kho / vị trí (hỗ trợ dựng kho đích chuyển kho) |
| `POST /api/alerts/scan` | inventory_view | Quét cảnh báo từ lô/tồn hiện tại (upsert theo khoá, hết điều kiện tự RESOLVED) |
| `GET /api/alerts` (`?status=`) | inventory_view | Danh sách cảnh báo |
| `POST /api/alerts/:id/ack` | inventory_adjust | Xác nhận đã biết |

## API liên kho GĐ4 (Federation + Portal)

| Endpoint | Quyền / khoá | Mô tả |
|---|---|---|
| `GET /federation/v1/ping` | công khai | Kiểm tra server sống: mã kho, tên kho, giờ, phiên bản |
| `GET /federation/info` | khoá federation | Mã kho + tên kho + giờ server + phiên bản |
| `GET /federation/v1/inventory/availability?sku=` | khoá federation (`share_available`) | Tồn khả dụng chuẩn hoá theo SKU/lô + HSD; giá vốn chỉ khi khoá bật `share_cost_price` |
| `GET /federation/low-stock` | khoá federation (`share_low_stock`) | SKU dưới mức tối thiểu; chưa bật chia sẻ trả 403 |
| `GET /api/federation/keys` / `POST /api/federation/keys` | federation_manage | Danh sách khoá (không lộ khoá) / tạo khoá — plaintext trả đúng 1 lần, server chỉ lưu băm SHA-256 |
| `POST /api/federation/keys/:id/revoke` | federation_manage | Thu hồi khoá |
| `GET/PUT /api/federation/keys/:id/policy` | federation_manage | Xem / sửa 3 công tắc chia sẻ của khoá |
| `GET /api/federation/query-log` | federation_manage | 100 truy vấn liên kho mới nhất (kể cả lần bị chặn) |
| `GET/POST /api/portal/peers`, `PUT/DELETE /api/portal/peers/:id` | federation_manage | Quản lý danh sách kho peer của cổng |
| `POST /api/portal/peers/:id/test` | federation_manage | Ping + info tới kho peer, cập nhật trạng thái |
| `GET /api/portal/availability?sku=` | inventory_view | Tra tồn song song mọi kho + tổng; kho offline trả cache kèm `stale: true` + `fetched_at` |
| `GET /api/portal/status` | inventory_view | Trạng thái online/offline + lần thấy cuối của từng kho |
| `GET /api/portal/low-stock` | inventory_view | Tồn thấp tổng hợp; kho không chia sẻ có ghi chú riêng |
| `GET /portal` | trang tĩnh | Trang cổng liên kho (HTML thuần, tự nhập token phiên) |

## Kiểm thử server (cho người kỹ thuật)

```
node server/test-smoke.mjs
```

Script tự mở server ở cổng test với DB tạm, chạy hết luồng
đăng nhập → duyệt thiết bị → biến động tồn → liên kho → GĐ1 (PO → nhận →
QC → cất hàng → kiểm balances) → GĐ2 (đơn xuất → phân bổ → wave → lấy →
đóng gói → giao → trả hàng về lô gốc → QC → cất lại) → GĐ3 (đóng băng →
phân bổ bị chặn một phần → chuyển vị trí → kiểm kê quay vòng đếm thiếu →
duyệt áp chênh lệch → chuyển kho 2 bước → gợi ý đặt hàng → PO nháp →
cảnh báo hết hạn/tồn thấp) → sao lưu → GĐ4 (tự mở thêm server B độc lập:
B cấp khoá qua API → B nhận hàng → portal ở server chính thêm peer B →
tra tồn chéo kho → chính sách tồn thấp → kill B kiểm tra cache "số liệu
cũ" + trạng thái offline),
xong tự dọn. Không nằm trong `npm test` chính vì cần mở cổng mạng.

## Các biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `WMS_PORT` | `8787` | Cổng server |
| `WMS_WAREHOUSE_CODE` | `KHO-01` | Mã kho này (hiện trong federation/health) |
| `WMS_ADMIN_USER` / `WMS_ADMIN_PASS` | `admin` / `doi-mat-khau-ngay` | Tài khoản quản trị tạo ở lần chạy đầu |
| `WMS_FEDERATION_KEY` | (trống) | Khoá hệ thống cho API liên kho chỉ-đọc (cách cũ; cách chính là cấp khoá qua API/mục Liên kho) |
| `WMS_DATA_DIR` | `server/data` | Thư mục chứa DB + backups |
| `WMS_DB_PATH` | `server/data/warehouse.db` | Đường dẫn file DB (chủ yếu cho test) |
