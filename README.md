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

## GĐ2 — Xuất kho theo lô (Đơn xuất → Phân bổ → Wave → Đóng gói → Giao → Trả hàng)

Mục *Lấy hàng → Xuất kho* (chỉ áp cho hàng theo lô của sổ cái — hàng nhận qua PO;
lệnh lấy hàng cũ cho hàng nạp file không đổi):

1. **Đơn xuất** (số XH-xxxx): tạo tay tại kho hoặc từ đơn Supabase — trường hợp
   Supabase chỉ **lưu mã đơn tham chiếu + tên xe dạng text**, không đồng bộ hai
   chiều, không sửa luồng Orders/Carriers.
2. **Phân bổ (allocation)**: giữ chỗ tồn thật trên lô theo **FEFO** (hết hạn sớm
   xuất trước; hoà thì FIFO; chọn được FIFO thuần). Chỉ lấy từ lô AVAILABLE ở
   vị trí lấy hàng/hàng khối, trừ phần đã giữ cho đơn khác, đóng băng, hỏng,
   chờ QC. Thiếu hàng → đơn *Phân bổ một phần* và mỗi dòng hiện **backorder**.
   Huỷ đơn (khi chưa lấy) nhả toàn bộ giữ chỗ.
3. **Sóng lấy hàng (wave)**: tick chọn nhiều đơn đã phân bổ gộp thành 1 wave
   (số WV-xxxx, lưu thêm xe/giờ chốt để sau lọc tự động). Hệ thống gộp các phần
   cùng lô + vị trí thành **pick task** xếp theo lộ trình vị trí. Xác nhận lấy
   từng task: nhập số thực lấy — lấy thiếu thì phần thiếu tự nhả về backorder.
   Đơn lẻ không qua wave vẫn xác nhận lấy ngay trong chi tiết đơn.
4. **Đóng gói**: quét/nhập SKU + số lượng, app đối chiếu trực tiếp với số đã
   lấy của đơn (sai SKU hoặc vượt số đã lấy bị chặn ngay). Gói đủ → *Đã đóng gói*.
5. **Giao hàng**: tạo phiếu giao (số GH-xxxx) kèm **lô gốc của từng dòng** —
   móc truy vết cho hàng trả; ghi xe/đơn vị vận chuyển + mã vận đơn. Đơn hoàn
   tất ngay khi giao (tồn đã trừ ở bước lấy hàng).
6. **Trả hàng**: chọn phiếu giao → nhập số trả theo dòng (thấy rõ lô gốc) →
   hàng về **khu nhận chờ QC của đúng lô gốc**, QC đạt/hỏng và cất lại lên kệ
   bằng đúng quy trình GĐ1. Số phiếu trả TH-xxxx.

Warehouse Server có cùng bộ API (xem `server/README.md`): `GET/POST
/api/outbound-orders`, `POST /api/outbound-orders/:id/allocate|cancel|pack|ship`,
`GET/POST /api/waves`, `GET /api/waves/:id/tasks`, `POST
/api/pick-tasks/:id/confirm`, `GET /api/shipments`, `POST
/api/shipments/:id/returns`, `POST /api/returns/:id/qc|putaway`.

## GĐ3 — Vận hành kho (Kiểm kê quay vòng → Đóng băng → Chuyển kho → Gợi ý đặt hàng → Cảnh báo)

Mục *Kiểm đếm → Vận hành kho* (chỉ áp cho hàng theo lô của sổ cái; phiếu kiểm
mù cũ cho hàng nạp file ở mục Kiểm kho không đổi):

1. **Kiểm kê quay vòng** (số CC-xxxx): tạo phiên theo **vị trí / khu / SKU** —
   hệ thống chụp snapshot tồn sổ sách (chỉ đếm xô tồn vật lý; phần đang đóng
   băng / chờ QC ghi riêng để đối chiếu). Có **chế độ mù** (ẩn số sổ sách khi
   đếm). Đếm xong, người có quyền duyệt mới **áp chênh lệch** vào tồn bằng
   movement điều chỉnh kèm lý do *Chênh lệch kiểm kê*; đúng số thì không sinh
   biến động. Phiên có thể bị từ chối để đếm lại.
2. **Đóng băng (Freeze/Hold)**: khóa tồn theo lô + vị trí kèm lý do bắt buộc
   (chờ kiểm tra chất lượng, nghi hỏng…). Hàng đang băng **không được phân bổ**
   cho đơn xuất; mở băng từng phần khi xử lý xong.
3. **Chuyển kho**: chuyển vị trí nhanh trong kho (movement MOVE) và **phiếu
   chuyển kho** (số CK-xxxx) 2 bước có chứng từ: xuất ở kho nguồn (hàng sang
   trạng thái đang chuyển) → nhận ở kho đích.
4. **Gợi ý đặt hàng**: đặt min/max (và điểm đặt lại) cho từng SKU; khi khả
   dụng chạm ngưỡng, hệ thống gợi ý số cần đặt = max − khả dụng − đang đặt,
   **gom theo nhà cung cấp mặc định của SKU** và tạo **PO nháp** một chạm
   (giá lấy theo giá nhập gần nhất). SKU chưa gán NCC mặc định được tách nhóm
   cảnh báo riêng, không tạo PO.
5. **Cảnh báo**: bấm *Quét cảnh báo* để quét từ dữ liệu lô/tồn thật — sắp hết
   hạn (30/15/7 ngày, đã hết hạn), tồn thấp / hết hàng theo min, hàng chờ QC,
   hàng đang đóng băng. Cảnh báo tự đóng khi hết điều kiện; người dùng xác
   nhận "Đã biết" cho cảnh báo đang theo dõi.

Warehouse Server có cùng bộ API (xem `server/README.md`): `GET/POST
/api/cycle-counts` + `count|approve|reject`, `POST /api/inventory/freeze|
unfreeze|move`, `GET /api/inventory/frozen`, `GET/POST /api/transfer-orders`
+ `ship|receive|cancel`, `GET/PUT /api/stock-policies`, `GET
/api/replenishment/suggestions`, `POST /api/replenishment/create-pos`,
`POST /api/alerts/scan`, `GET /api/alerts`, `POST /api/alerts/:id/ack`.

## GĐ4 — Liên kho (Federation Portal: cổng tra tồn của nhiều kho)

Mỗi kho vẫn tự quản lý độc lập; liên kho chỉ **đọc ở mức truy vấn** — không có
cơ sở dữ liệu tồn trung tâm, không kho nào sửa được tồn của kho khác.

- **Khoá theo từng phía được cấp:** mục **Liên kho** trong app (nhóm Hệ thống)
  tạo khoá cho từng portal/kho đối tác — khoá plaintext chỉ hiển thị đúng 1
  lần, hệ thống chỉ lưu băm SHA-256. Mỗi khoá có 3 công tắc chia sẻ: tồn khả
  dụng, tồn thấp, và giá vốn (**mặc định tắt**; giá chỉ đi kèm khi bật riêng
  cho đúng khoá đó). Thu hồi từng khoá độc lập. Khoá hệ thống cũ qua biến
  `WMS_FEDERATION_KEY` vẫn dùng được với chính sách mặc định. Mọi truy vấn
  đều ghi nhật ký (ai hỏi, SKU gì, kết quả) xem ngay trong mục Liên kho.
- **API chỉ-đọc của mỗi kho:** `GET /federation/info`,
  `GET /federation/v1/inventory/availability?sku=` (dòng chuẩn hoá theo
  SKU/lô kèm hạn dùng), `GET /federation/low-stock` (chỉ khi khoá bật chia
  sẻ tồn thấp, chưa bật trả 403 rõ ràng) — đều kèm header `x-federation-key`.
- **Cổng liên kho (Portal)** chạy ngay trong Warehouse Server tại
  `http://<máy chủ>:8787/portal`: cấu hình danh sách kho peer (địa chỉ +
  khoá), tra một SKU thấy tồn của mọi kho và tổng toàn hệ thống; kho nào
  offline thì cổng hiển thị **số liệu gần nhất kèm nhãn "số liệu cũ" + thời
  điểm**, không giả vờ là số trực tiếp. Có thêm bảng trạng thái các kho và
  mục tồn thấp liên kho (kho không chia sẻ được ghi chú rõ). Trang portal là
  HTML tĩnh, in được; đăng nhập bằng token phiên của server.
- Các kho nối nhau qua **VPN riêng (Tailscale/WireGuard)** — tuyệt đối không
  mở cổng server ra Internet. Điều chuyển hàng thật giữa các kho vẫn làm
  bằng phiếu chuyển kho của GĐ3 tại từng kho; portal chỉ gợi ý, không tự
  sửa tồn. Chi tiết vận hành: `server/README.md`.

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
