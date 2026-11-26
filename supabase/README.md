# Supabase — chỉ dành cho tính năng CHIA SẺ

Supabase trong dự án này **chỉ** phục vụ các tính năng chia sẻ ra ngoài:

- Danh bạ nhà vận tải (Carriers) + hàng đợi duyệt/claim.
- Chat đặt hàng theo group (Orders) + realtime.
- Theo dõi đơn cho người đặt hàng và tài xế.
- Đơn vị vận tải.

**Tồn kho KHÔNG dùng Supabase.** Tồn kho chạy local tại từng kho
(SQLite trong trình duyệt ở chế độ standalone, hoặc Warehouse Server
localhost — xem `server/README.md`). Không tạo bảng tồn kho trên Supabase.

## Thư mục migrations/

Mọi thay đổi schema Supabase từ nay **bắt buộc** đi qua file trong
`supabase/migrations/`, đặt tên `YYYYMMDDHHMMSS_mo_ta_ngan.sql`, áp theo
thứ tự tên file, không sửa file đã áp (muốn đổi thì thêm file mới).

Hai file đầu tiên là **bản ghi-chép (recorded placeholder)** cho các
migration đã được áp trực tiếp trên Supabase Dashboard trước khi repo có
thư mục này. SQL gốc không còn trong repo nên các file đó **chỉ mô tả**
thay đổi suy ra từ code client — KHÔNG chứa SQL chạy được và KHÔNG được
áp lại. Khi cần SQL thật, export từ Supabase Dashboard
(Database → Migrations / `supabase db dump`) rồi thay nội dung file,
giữ nguyên tên file và đánh dấu đã thay trong đầu file.

File `_template.sql` là mẫu cho migration mới.
