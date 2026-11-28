-- =====================================================================
-- WIPE DỮ LIỆU TEST CŨ — xoá sạch DỮ LIỆU trong các bảng nghiệp vụ cũ
-- Vị trí: supabase/wipe_legacy_test_data.sql (NẰM NGOÀI thư mục
-- migrations — script vận hành chạy tay, tách hẳn khỏi
-- reset_freight.sql).
-- =====================================================================
-- ⚠️⚠️ CẢNH BÁO — ĐỌC KỸ TRƯỚC KHI CHẠY:
--   Chạy file này là XOÁ TOÀN BỘ dữ liệu hiện có trong các bảng:
--     messages, message_attachments, order_events, orders,
--     group_members, groups, carrier_claims, carrier_suggestions,
--     carrier_verifications, carriers, profiles
--   — tức toàn bộ đơn hàng, group, tin nhắn chat và danh bạ nhà xe
--   hiện tại trên project này. XOÁ LÀ KHÔNG KHÔI PHỤC ĐƯỢC (trừ khi
--   bạn có backup). Chỉ chạy khi chắc chắn các dữ liệu đó là dữ liệu
--   TEST do chính bạn tạo trong quá trình phát triển (người dùng đã
--   xác nhận điều này ngày 2026-11-28).
--
-- Phạm vi chính xác của script:
--   * CHỈ xoá DỮ LIỆU bằng TRUNCATE ... RESTART IDENTITY CASCADE.
--   * KHÔNG DROP bảng nào; KHÔNG đụng hàm/RPC; KHÔNG đụng view —
--     orders_view, carriers_public giữ nguyên cấu trúc (chỉ hết dữ
--     liệu vì bảng gốc đã trống).
--   * KHÔNG đụng auth.users: tài khoản đăng nhập (email/mật khẩu/mã
--     OTP) GIỮ NGUYÊN, vẫn đăng nhập được sau khi wipe.
--   * Bảng profiles BỊ truncate theo yêu cầu: cột display_name của
--     mọi người dùng sẽ mất — sau khi wipe, mỗi người tự đặt lại tên
--     hiển thị trong app (trang Tài khoản). Đây là chủ đích, không
--     phải lỗi.
--   * KHÔNG đụng bất kỳ bảng freight_* nào — freight có script riêng
--     (reset_freight.sql). Thứ tự khuyến nghị khi muốn bắt đầu lại
--     hoàn toàn sạch:
--       1) file này (tuỳ chọn — xoá dữ liệu test cũ)
--       2) supabase/reset_freight.sql (xoá đối tượng freight_*)
--       3) migration 20261128020000_freight_account_model_fresh.sql
--   * RESTART IDENTITY: các sequence bigint (id của messages,
--     message_attachments, order_events) quay về 1 — an toàn vì dữ
--     liệu cũ đã xoá hết.
-- =====================================================================

TRUNCATE TABLE
  public.messages,
  public.message_attachments,
  public.order_events,
  public.orders,
  public.group_members,
  public.groups,
  public.carrier_claims,
  public.carrier_suggestions,
  public.carrier_verifications,
  public.carriers,
  public.profiles
RESTART IDENTITY CASCADE;

-- =====================================================================
-- KIỂM CHỨNG SAU WIPE (các SELECT tự chạy kèm khi Run cả file):
--   - Mọi cột *_rows của các bảng vừa wipe PHẢI = 0.
--   - freight_tables_con_nguyen: số bảng/view freight_* hiện có —
--     file này KHÔNG đụng freight nên số này phải giữ nguyên như
--     trước khi chạy (chỉ về 0 sau khi bạn chạy reset_freight.sql).
-- =====================================================================
SELECT
  (SELECT COUNT(*) FROM public.messages) AS messages_rows,
  (SELECT COUNT(*) FROM public.message_attachments) AS message_attachments_rows,
  (SELECT COUNT(*) FROM public.order_events) AS order_events_rows,
  (SELECT COUNT(*) FROM public.orders) AS orders_rows,
  (SELECT COUNT(*) FROM public.group_members) AS group_members_rows,
  (SELECT COUNT(*) FROM public.groups) AS groups_rows,
  (SELECT COUNT(*) FROM public.carrier_claims) AS carrier_claims_rows,
  (SELECT COUNT(*) FROM public.carrier_suggestions) AS carrier_suggestions_rows,
  (SELECT COUNT(*) FROM public.carrier_verifications) AS carrier_verifications_rows,
  (SELECT COUNT(*) FROM public.carriers) AS carriers_rows,
  (SELECT COUNT(*) FROM public.profiles) AS profiles_rows,
  (SELECT COUNT(*) FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE 'freight\_%')
    AS freight_tables_con_nguyen;
