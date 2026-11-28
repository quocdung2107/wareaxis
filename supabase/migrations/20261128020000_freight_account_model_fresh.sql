-- =====================================================================
-- MIGRATION GỘP BẢN SẠCH — Lớp trung gian giao tiếp Kho <-> Vận tải
-- Mô hình danh tính THEO TÀI KHOẢN (trạng thái cuối sau T1 + R1)
-- Tên file: 20261128020000_freight_account_model_fresh.sql
-- =====================================================================
-- ⚠️ BẢN CÀI SẠCH — chạy supabase/reset_freight.sql TRƯỚC.
--   File này THAY THẾ hai migration freight trước:
--     - 20261127000000_freight_t1_foundation.sql (đã xoá khỏi repo)
--     - 20261128000000_freight_r1_account_model.sql (đã xoá khỏi repo)
--   Quy trình phát triển hiện tại (người dùng chốt 2026-11-28): dữ liệu
--   freight chỉ là dữ liệu test, KHÔNG di trú nữa — mỗi đợt sửa freight
--   thì cập nhật file này, người dùng reset + chạy lại từ đầu.
--   File tạo TOÀN BỘ schema freight từ trạng thái trống: chỉ bộ RPC
--   freight_acct_* (mô hình tài khoản), KHÔNG còn RPC group của T1,
--   KHÔNG có khối di trú, KHÔNG có đánh dấu deprecated.
--
--   R2 (T2 — CHÀO GIÁ) đã gộp vào file này (mục 8): cột
--   freight_loads.open_for_bids, bảng freight_bids + freight_bid_history,
--   freight_bookings.bid_id, RPC freight_acct_place_bid / update_bid /
--   withdraw_bid / reject_bid / accept_bid (nguyên tử) /
--   expire_stale. Thiết kế: thiet-ke-lai-tai-khoan-va-t2-chao-gia.md
--   Phần 3. Máy trạng thái tải KHÔNG thêm trạng thái BIDDING — "đang có
--   chào giá" là trạng thái hiển thị suy ra từ bid PENDING.
--
-- Nội dung:
--   Mỗi tài khoản (auth.users) có MỘT hồ sơ đăng ký riêng
--   (freight_account_profiles, hai cờ độc lập is_shipper / is_carrier),
--   kho/xe/tài xế/tuyến thuộc tài khoản (freight_my_*), kết nối giữa hai
--   TÀI KHOẢN (freight_account_links), tải/chuyến lấy tài khoản làm hai
--   phía giao dịch. GROUP chỉ còn là không gian trao đổi: nguồn tạo tải
--   từ đơn (group_id/order_id trên freight_loads = tham chiếu nguồn tuỳ
--   chọn, nullable) và nơi chủ tải chủ động chia sẻ tải vào
--   (freight_load_groups). Không bảng freight nào có FK tới groups —
--   xoá group không xoá được hồ sơ/tải/chuyến của tài khoản.
--
-- Triết lý Bản A — BẮT BUỘC giữ khi sửa file này:
--   * KHÔNG xác thực/duyệt tổ chức, KHÔNG trạng thái "chờ duyệt".
--   * Ngày hết hạn giấy tờ (đăng kiểm / bảo hiểm / bằng lái) chỉ là cột
--     thông tin tự khai để HIỂN THỊ. Không RPC nào đọc *_expires_at để
--     chặn giao dịch (xem ghi chú NT-02 trong
--     freight_acct_assign_vehicle_driver).
--   * Chốt chuyến là xác nhận giữa HAI PHÍA; RPC chỉ bảo đảm toàn vẹn
--     dữ liệu (một load tối đa một booking đang sống, chuyển trạng thái
--     đúng máy trạng thái) — không có bước "sàn phê duyệt".
--
-- Ảnh hưởng: CHỈ tạo mới đối tượng tiền tố freight_. Bảng cũ của app
-- (groups, group_members, orders...) chỉ bị ĐỌC; duy nhất
-- freight_sync_order UPDATE orders.status theo ánh xạ một chiều kèm
-- INSERT order_events, trong khối EXCEPTION bảo vệ: lỗi đồng bộ đơn cũ
-- KHÔNG bao giờ chặn nghiệp vụ chuyến.
--
-- Giả định về schema cũ (đã đối chiếu export thật 2026-11-27):
--   groups(id uuid PK, name, created_by), group_members(group_id,
--   user_id, roles text[]), orders(id, group_id, code, status thuộc
--   CREATED/CONFIRMED/PICKING/IN_TRANSIT/DELIVERED/COMPLETED,
--   updated_at, ...) — bảng orders KHÔNG có completed_at (chỉ có ở
--   orders_view dạng tính toán); order_events(order_id, group_id
--   NOT NULL, actor_id, type, from_status, to_status, note).
--   RPC complete_order(p_order uuid, p_note text) tồn tại — chỉ gọi
--   khi kiểm tra thấy có trong pg_proc, lỗi thì fallback UPDATE.
--   auth.uid() dùng được trong RLS/RPC (Supabase Auth chuẩn).
--
-- Client phụ thuộc: src/shared/supabase/freightAccount.ts,
--   src/shared/supabase/freight.ts (phần nền dùng chung),
--   src/features/freight/*, src/domain/freight/* (máy trạng thái phía
--   client khớp 1-1 với freight_booking_transition_allowed ở đây).
--   Danh sách đối chiếu client <-> file này: xem cuối file.
--
-- Cách áp: Supabase Dashboard -> SQL Editor:
--   1) chạy supabase/reset_freight.sql (xoá sạch freight_* cũ);
--   2) dán toàn bộ file này -> Run;
--   3) chạy khối KIỂM CHỨNG ở cuối file.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. HÀM HỖ TRỢ NỀN (dùng trong RLS và RPC)
-- ---------------------------------------------------------------------

/** Người dùng hiện tại đã đăng nhập hay chưa; chưa thì ném mã lỗi chuẩn. */
CREATE OR REPLACE FUNCTION public.freight_require_uid()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  RETURN v_uid;
END;
$$;

/** auth.uid() có là thành viên của group không (group = không gian trao đổi). */
CREATE OR REPLACE FUNCTION public.freight_is_group_member(p_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.user_id = auth.uid()
  );
$$;

/** Tập group mà auth.uid() là thành viên (dùng trong view tra cứu). */
CREATE OR REPLACE FUNCTION public.freight_my_group_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT gm.group_id FROM public.group_members gm WHERE gm.user_id = auth.uid();
$$;

/** Thứ hạng trạng thái đơn cũ (khớp ORDER_FLOW phía client). */
CREATE OR REPLACE FUNCTION public.freight_order_rank(p_status text)
RETURNS int
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_status
    WHEN 'CREATED' THEN 0
    WHEN 'CONFIRMED' THEN 1
    WHEN 'PICKING' THEN 2
    WHEN 'IN_TRANSIT' THEN 3
    WHEN 'DELIVERED' THEN 4
    WHEN 'COMPLETED' THEN 5
    ELSE -1
  END;
$$;

/**
 * Máy trạng thái Booking — KHỚP 1-1 với src/domain/freight/booking.ts.
 * p_side: 'SHIPPER' | 'CARRIER' | 'DRIVER' (phía của người thực hiện).
 */
CREATE OR REPLACE FUNCTION public.freight_booking_transition_allowed(p_from text, p_to text, p_side text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_from = 'PENDING_CONFIRM' AND p_to = 'BOOKED'    AND p_side = 'CARRIER' THEN true
    WHEN p_from = 'PENDING_CONFIRM' AND p_to = 'DECLINED'  AND p_side = 'CARRIER' THEN true
    WHEN p_from = 'PENDING_CONFIRM' AND p_to = 'CANCELLED' AND p_side = 'SHIPPER' THEN true
    WHEN p_from = 'BOOKED' AND p_to = 'ARRIVED_PICKUP' AND p_side IN ('CARRIER', 'DRIVER') THEN true
    WHEN p_from = 'BOOKED' AND p_to = 'CANCELLED' THEN true
    WHEN p_from = 'ARRIVED_PICKUP' AND p_to = 'PICKED_UP' THEN true
    WHEN p_from = 'ARRIVED_PICKUP' AND p_to = 'CANCELLED' THEN true
    WHEN p_from = 'PICKED_UP' AND p_to = 'IN_TRANSIT' AND p_side IN ('CARRIER', 'DRIVER') THEN true
    WHEN p_from = 'IN_TRANSIT' AND p_to = 'ARRIVED_DELIVERY' AND p_side IN ('CARRIER', 'DRIVER') THEN true
    WHEN p_from = 'ARRIVED_DELIVERY' AND p_to = 'DELIVERED' AND p_side IN ('CARRIER', 'DRIVER') THEN true
    WHEN p_from = 'DELIVERED' AND p_to = 'POD_CONFIRMED' AND p_side = 'SHIPPER' THEN true
    WHEN p_from = 'DELIVERED' AND p_to = 'COMPLETED' AND p_side = 'SHIPPER' THEN true
    WHEN p_from = 'DELIVERED' AND p_to = 'DISPUTED' THEN true
    WHEN p_from = 'POD_CONFIRMED' AND p_to = 'COMPLETED' AND p_side = 'SHIPPER' THEN true
    WHEN p_from = 'POD_CONFIRMED' AND p_to = 'DISPUTED' THEN true
    WHEN p_from = 'DISPUTED' AND p_to = 'POD_CONFIRMED' AND p_side = 'SHIPPER' THEN true
    WHEN p_from = 'DISPUTED' AND p_to = 'COMPLETED' AND p_side = 'SHIPPER' THEN true
    ELSE false
  END;
$$;

/** Trigger giữ updated_at. */
CREATE OR REPLACE FUNCTION public.freight_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 2. BẢNG THEO TÀI KHOẢN
-- Mọi bảng sở hữu đều FK về auth.users ON DELETE CASCADE (xoá TÀI KHOẢN
-- thì dữ liệu của tài khoản đi theo — đúng nghĩa sở hữu). Không bảng nào
-- có FK tới groups: xoá group không chạm được vào dữ liệu tài khoản.
-- ---------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.freight_load_code_seq;
CREATE SEQUENCE IF NOT EXISTS public.freight_booking_code_seq;

-- Một tài khoản = MỘT dòng đăng ký duy nhất; hai vai trò là hai cờ độc
-- lập (vừa chủ kho vừa vận tải được).
CREATE TABLE IF NOT EXISTS public.freight_account_profiles (
  account_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  display_name text NOT NULL,
  legal_name text,
  tax_code text,
  contact_name text,
  contact_phone text,
  address text,
  province text,
  is_shipper boolean NOT NULL DEFAULT false,
  is_carrier boolean NOT NULL DEFAULT false,
  business_license_no text,
  capability_note text,
  self_declared_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (is_shipper OR is_carrier)
);

CREATE TABLE IF NOT EXISTS public.freight_my_warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name text NOT NULL,
  address text NOT NULL,
  province text,
  lat double precision,
  lng double precision,
  open_hours jsonb,
  dock_count int,
  arrival_requirements text,
  contact_name text,
  contact_phone text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freight_my_warehouses_account ON public.freight_my_warehouses (account_id);

-- inspection_expires_at / insurance_expires_at: TỰ KHAI, chỉ hiển thị —
-- không dùng để chặn bất kỳ thao tác nào.
CREATE TABLE IF NOT EXISTS public.freight_my_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  plate text NOT NULL,
  vehicle_type text NOT NULL,
  payload_kg numeric,
  box_length_m numeric,
  box_width_m numeric,
  box_height_m numeric,
  photo_path text,
  inspection_expires_at date,
  insurance_expires_at date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, plate)
);
CREATE INDEX IF NOT EXISTS idx_freight_my_vehicles_account ON public.freight_my_vehicles (account_id);

-- account_id = tài khoản NHÀ XE sở hữu dòng; user_id = tài khoản của
-- CHÍNH tài xế (nullable — tài xế chưa có tài khoản vẫn khai được).
CREATE TABLE IF NOT EXISTS public.freight_my_drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  user_id uuid,
  full_name text NOT NULL,
  phone text,
  license_class text,
  license_expires_at date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freight_my_drivers_account ON public.freight_my_drivers (account_id);
CREATE INDEX IF NOT EXISTS idx_freight_my_drivers_user ON public.freight_my_drivers (user_id);

CREATE TABLE IF NOT EXISTS public.freight_my_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  from_province text NOT NULL,
  to_province text NOT NULL,
  vehicle_type text,
  ref_price numeric,
  note text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freight_my_routes_account ON public.freight_my_routes (account_id);

-- Kết nối giữa hai TÀI KHOẢN: một phía mời (PENDING) -> phía kia chấp
-- nhận (ACCEPTED) -> một phía kết thúc (ENDED). Đồng ý hai bên giữa hai
-- tài khoản, không phải duyệt của sàn.
CREATE TABLE IF NOT EXISTS public.freight_account_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_account_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  addressee_account_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'PAST_DEAL')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'ENDED')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requester_account_id <> addressee_account_id)
);
-- Một cặp tài khoản chỉ có MỘT dòng kết nối, bất kể chiều mời.
CREATE UNIQUE INDEX IF NOT EXISTS uq_freight_account_links_pair
  ON public.freight_account_links
     (LEAST(requester_account_id, addressee_account_id),
      GREATEST(requester_account_id, addressee_account_id));
CREATE INDEX IF NOT EXISTS idx_freight_account_links_req ON public.freight_account_links (requester_account_id);
CREATE INDEX IF NOT EXISTS idx_freight_account_links_addr ON public.freight_account_links (addressee_account_id);

-- ---------------------------------------------------------------------
-- 3. BẢNG GIAO DỊCH: LOAD, BOOKING, SỰ KIỆN CHUYẾN, CHIA SẺ VÀO GROUP
-- Sinh ra đã ở trạng thái mô hình tài khoản: hai phía là account_id;
-- group_id / directed_group_id / pickup_warehouse_id chỉ là tham chiếu
-- nguồn tuỳ chọn (nullable, không FK) để tương thích dữ liệu hiển thị.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.freight_loads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  group_id uuid,
  order_id uuid,
  shipment_code text,
  goods_desc text NOT NULL,
  weight_kg numeric,
  packages int,
  volume_m3 numeric,
  vehicle_type_required text,
  pickup_warehouse_id uuid,
  pickup_point_id uuid REFERENCES public.freight_my_warehouses (id) ON DELETE SET NULL,
  pickup_address text,
  pickup_province text,
  delivery_address text,
  delivery_province text,
  delivery_contact_name text,
  delivery_contact_phone text,
  pickup_window_from timestamptz,
  pickup_window_to timestamptz,
  delivery_window_to timestamptz,
  visibility text NOT NULL DEFAULT 'NETWORK' CHECK (visibility IN ('DIRECT', 'NETWORK', 'PUBLIC')),
  directed_group_id uuid,
  directed_account_id uuid,
  asking_price numeric,
  -- T2: tải có nhận chào giá không. Mặc định theo mức hiển thị do RPC
  -- tạo tải quyết (DIRECT=false, NETWORK/PUBLIC=true), chủ tải đổi được.
  open_for_bids boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT', 'POSTED', 'ASSIGNED', 'BOOKED', 'EXPIRED', 'CANCELLED')),
  expires_at timestamptz,
  created_by uuid,
  poster_account_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freight_loads_group ON public.freight_loads (group_id);
CREATE INDEX IF NOT EXISTS idx_freight_loads_status ON public.freight_loads (status, visibility);
CREATE INDEX IF NOT EXISTS idx_freight_loads_order ON public.freight_loads (order_id);
CREATE INDEX IF NOT EXISTS idx_freight_loads_poster ON public.freight_loads (poster_account_id);
CREATE INDEX IF NOT EXISTS idx_freight_loads_directed ON public.freight_loads (directed_account_id);

CREATE TABLE IF NOT EXISTS public.freight_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  load_id uuid NOT NULL REFERENCES public.freight_loads (id),
  order_id uuid,
  shipper_group_id uuid,
  carrier_group_id uuid,
  shipper_account_id uuid,
  carrier_account_id uuid,
  vehicle_id uuid,
  driver_id uuid,
  my_vehicle_id uuid REFERENCES public.freight_my_vehicles (id) ON DELETE SET NULL,
  my_driver_id uuid REFERENCES public.freight_my_drivers (id) ON DELETE SET NULL,
  price_agreed numeric,
  status text NOT NULL DEFAULT 'PENDING_CONFIRM' CHECK (status IN (
    'PENDING_CONFIRM', 'BOOKED', 'ARRIVED_PICKUP', 'PICKED_UP', 'IN_TRANSIT',
    'ARRIVED_DELIVERY', 'DELIVERED', 'POD_CONFIRMED', 'COMPLETED',
    'DISPUTED', 'CANCELLED', 'DECLINED'
  )),
  pickup_at_actual timestamptz,
  delivered_at_actual timestamptz,
  cancel_reason text,
  cancelled_by_side text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freight_bookings_load ON public.freight_bookings (load_id);
CREATE INDEX IF NOT EXISTS idx_freight_bookings_shipper ON public.freight_bookings (shipper_group_id);
CREATE INDEX IF NOT EXISTS idx_freight_bookings_carrier ON public.freight_bookings (carrier_group_id);
CREATE INDEX IF NOT EXISTS idx_freight_bookings_shipper_acct ON public.freight_bookings (shipper_account_id);
CREATE INDEX IF NOT EXISTS idx_freight_bookings_carrier_acct ON public.freight_bookings (carrier_account_id);
-- Một load chỉ có tối đa MỘT booking đang sống (chưa CANCELLED/DECLINED).
CREATE UNIQUE INDEX IF NOT EXISTS uq_freight_bookings_live_per_load
  ON public.freight_bookings (load_id)
  WHERE status NOT IN ('CANCELLED', 'DECLINED');

-- Sự kiện chuyến: APPEND-ONLY. Không có policy INSERT/UPDATE/DELETE trực
-- tiếp — chỉ RPC (SECURITY DEFINER) được ghi; không ai sửa/xoá được dòng
-- đã ghi. Đây là "bộ nhớ chung" để hai bên đối chiếu khi cần.
CREATE TABLE IF NOT EXISTS public.freight_booking_events (
  id bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES public.freight_bookings (id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_id uuid,
  actor_side text CHECK (actor_side IN ('SHIPPER', 'CARRIER', 'DRIVER', 'SYSTEM')),
  from_status text,
  to_status text,
  lat double precision,
  lng double precision,
  note text,
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'GPS', 'SYSTEM')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freight_events_booking ON public.freight_booking_events (booking_id, id);

-- Chủ tải "chia sẻ tải vào group": group_id là uuid MỀM, không FK —
-- xoá group chỉ làm dòng chia sẻ vô nghĩa, không xoá được tải.
CREATE TABLE IF NOT EXISTS public.freight_load_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id uuid NOT NULL REFERENCES public.freight_loads (id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  shared_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (load_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_freight_load_groups_load ON public.freight_load_groups (load_id);
CREATE INDEX IF NOT EXISTS idx_freight_load_groups_group ON public.freight_load_groups (group_id);

-- Trigger updated_at cho các bảng có cột updated_at.
DROP TRIGGER IF EXISTS trg_freight_account_profiles_touch ON public.freight_account_profiles;
CREATE TRIGGER trg_freight_account_profiles_touch BEFORE UPDATE ON public.freight_account_profiles
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();
DROP TRIGGER IF EXISTS trg_freight_my_warehouses_touch ON public.freight_my_warehouses;
CREATE TRIGGER trg_freight_my_warehouses_touch BEFORE UPDATE ON public.freight_my_warehouses
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();
DROP TRIGGER IF EXISTS trg_freight_my_vehicles_touch ON public.freight_my_vehicles;
CREATE TRIGGER trg_freight_my_vehicles_touch BEFORE UPDATE ON public.freight_my_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();
DROP TRIGGER IF EXISTS trg_freight_my_drivers_touch ON public.freight_my_drivers;
CREATE TRIGGER trg_freight_my_drivers_touch BEFORE UPDATE ON public.freight_my_drivers
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();
DROP TRIGGER IF EXISTS trg_freight_account_links_touch ON public.freight_account_links;
CREATE TRIGGER trg_freight_account_links_touch BEFORE UPDATE ON public.freight_account_links
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();
DROP TRIGGER IF EXISTS trg_freight_loads_touch ON public.freight_loads;
CREATE TRIGGER trg_freight_loads_touch BEFORE UPDATE ON public.freight_loads
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();
DROP TRIGGER IF EXISTS trg_freight_bookings_touch ON public.freight_bookings;
CREATE TRIGGER trg_freight_bookings_touch BEFORE UPDATE ON public.freight_bookings
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();

-- ---------------------------------------------------------------------
-- 4. HELPER THEO TÀI KHOẢN + GHI SỰ KIỆN + ĐỒNG BỘ ĐƠN CŨ
-- ---------------------------------------------------------------------

/** Hai tài khoản đã kết nối ACCEPTED với nhau chưa (bất kể chiều mời). */
CREATE OR REPLACE FUNCTION public.freight_acct_is_linked(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_a IS NOT NULL AND p_b IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.freight_account_links lk
    WHERE lk.status = 'ACCEPTED'
      AND ((lk.requester_account_id = p_a AND lk.addressee_account_id = p_b)
        OR (lk.requester_account_id = p_b AND lk.addressee_account_id = p_a))
  );
$$;

/** Tập tài khoản đã kết nối ACCEPTED với auth.uid(). */
CREATE OR REPLACE FUNCTION public.freight_acct_my_linked_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT lk.addressee_account_id FROM public.freight_account_links lk
  WHERE lk.status = 'ACCEPTED' AND lk.requester_account_id = auth.uid()
  UNION
  SELECT lk.requester_account_id FROM public.freight_account_links lk
  WHERE lk.status = 'ACCEPTED' AND lk.addressee_account_id = auth.uid();
$$;

/** Hai tài khoản có cùng thuộc ít nhất một group trao đổi không. */
CREATE OR REPLACE FUNCTION public.freight_acct_shares_group(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_a IS NOT NULL AND p_b IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.group_members gm1
    JOIN public.group_members gm2 ON gm2.group_id = gm1.group_id
    WHERE gm1.user_id = p_a AND gm2.user_id = p_b
  );
$$;

/**
 * Phía của người gọi đối với một chuyến THEO TÀI KHOẢN — khớp
 * src/domain/freight/account.ts (accountActorSide):
 *   'SHIPPER' nếu auth.uid() = p_shipper_account_id;
 *   'DRIVER'  nếu có freight_my_drivers d: d.user_id = auth.uid()
 *             AND d.account_id = p_carrier_account_id AND d.active;
 *   'CARRIER' nếu auth.uid() = p_carrier_account_id;
 *   NULL nếu không liên quan.
 * Trường hợp tự vận chuyển (shipper = carrier = người gọi): trả SHIPPER;
 * freight_acct_advance_booking tự phân phía theo chuyển đổi khi cần.
 */
CREATE OR REPLACE FUNCTION public.freight_acct_actor_side(p_shipper_account_id uuid, p_carrier_account_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() = p_shipper_account_id THEN
    RETURN 'SHIPPER';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.freight_my_drivers d
    WHERE d.user_id = auth.uid() AND d.account_id = p_carrier_account_id AND d.active
  ) THEN
    RETURN 'DRIVER';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() = p_carrier_account_id THEN
    RETURN 'CARRIER';
  END IF;
  RETURN NULL;
END;
$$;

/** Ghi một dòng sự kiện chuyến (append-only). */
CREATE OR REPLACE FUNCTION public.freight_add_event(
  p_booking_id uuid, p_event_type text, p_actor_side text,
  p_from text, p_to text, p_note text, p_lat double precision, p_lng double precision
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.freight_booking_events
    (booking_id, event_type, actor_id, actor_side, from_status, to_status, note, lat, lng)
  VALUES
    (p_booking_id, p_event_type, auth.uid(), p_actor_side, p_from, p_to, p_note, p_lat, p_lng);
END;
$$;

/**
 * Đồng bộ ánh xạ Booking -> orders.status (Bản A mục 2.6, một chiều, chỉ
 * tiến). Toàn bộ khối nằm trong EXCEPTION: đồng bộ là PHỤ TRỢ — lỗi ở
 * đây không bao giờ được chặn nghiệp vụ chuyến (sự kiện freight là
 * nguồn sự thật của lớp giao tiếp). orders KHÔNG có completed_at nên
 * chỉ UPDATE status/updated_at; order_events.group_id là NOT NULL nên
 * INSERT phải kèm group_id của đơn (đã đối chiếu schema thật
 * 2026-11-27).
 */
CREATE OR REPLACE FUNCTION public.freight_sync_order(p_order_id uuid, p_booking_code text, p_to_booking_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target text := CASE p_to_booking_status
    WHEN 'BOOKED' THEN 'CONFIRMED'
    WHEN 'PICKED_UP' THEN 'PICKING'
    WHEN 'IN_TRANSIT' THEN 'IN_TRANSIT'
    WHEN 'DELIVERED' THEN 'DELIVERED'
    WHEN 'COMPLETED' THEN 'COMPLETED'
    ELSE NULL
  END;
  v_cur text;
  v_group uuid;
BEGIN
  IF p_order_id IS NULL OR v_target IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    SELECT o.status, o.group_id INTO v_cur, v_group FROM public.orders o WHERE o.id = p_order_id;
    IF v_cur IS NULL THEN
      RETURN;
    END IF;
    IF public.freight_order_rank(v_target) <= public.freight_order_rank(v_cur) THEN
      RETURN;
    END IF;
    IF v_target = 'COMPLETED' AND EXISTS (
      SELECT 1 FROM pg_proc pr
      JOIN pg_namespace ns ON ns.oid = pr.pronamespace
      WHERE ns.nspname = 'public' AND pr.proname = 'complete_order'
    ) THEN
      BEGIN
        PERFORM public.complete_order(p_order_id, 'Đồng bộ từ chuyến ' || p_booking_code);
      EXCEPTION WHEN OTHERS THEN
        UPDATE public.orders SET status = 'COMPLETED', updated_at = now()
        WHERE id = p_order_id AND status = v_cur;
      END;
    ELSE
      UPDATE public.orders SET status = v_target, updated_at = now() WHERE id = p_order_id AND status = v_cur;
      IF FOUND THEN
        INSERT INTO public.order_events (order_id, group_id, actor_id, type, from_status, to_status, note)
        VALUES (p_order_id, v_group, auth.uid(), 'freight_status', v_cur, v_target, 'Đồng bộ từ chuyến ' || p_booking_code);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

-- ---------------------------------------------------------------------
-- 5. RLS — đọc theo quan hệ giao dịch; ghi nhạy cảm chỉ qua RPC;
-- ghi danh mục của chính mình qua RLS.
--
-- QUY TẮC CHỐNG ĐỆ QUY RLS (bài học 2026-11-28): biểu thức policy
-- KHÔNG ĐƯỢC chứa subquery trần (EXISTS SELECT...) chạm sang bảng
-- freight_* khác — Postgres đánh giá policy của bảng bị chạm tới và
-- hai bảng tham chiếu lẫn nhau (bookings ⇄ drivers) sẽ gây lỗi
-- 42P17 "infinite recursion detected in policy" cho MỌI truy vấn
-- authenticated (anon không dính vì không có policy áp cho anon).
-- Mọi kiểm tra xuyên bảng PHẢI qua helper SECURITY DEFINER dưới đây
-- (chạy quyền owner, bỏ qua RLS của bảng bên trong → cắt vòng lặp).
-- ---------------------------------------------------------------------

ALTER TABLE public.freight_account_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_my_warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_my_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_my_drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_my_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_account_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_booking_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_load_groups ENABLE ROW LEVEL SECURITY;

-- ----- Helper SECURITY DEFINER cho policy (cắt đệ quy RLS) -----

/** auth.uid() có là tài xế ĐANG HOẠT ĐỘNG liên kết với nhà xe này không. */
CREATE OR REPLACE FUNCTION public.freight_acct_driver_linked_to(p_carrier_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.freight_my_drivers d
    WHERE d.user_id = auth.uid() AND d.account_id = p_carrier_account_id AND d.active
  );
$$;

/** auth.uid() thấy được booking này không (một phía hoặc tài xế liên kết). */
CREATE OR REPLACE FUNCTION public.freight_acct_booking_visible(p_booking_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.freight_bookings b
    WHERE b.id = p_booking_id
      AND (b.shipper_account_id = auth.uid() OR b.carrier_account_id = auth.uid()
        OR public.freight_acct_driver_linked_to(b.carrier_account_id))
  );
$$;

/** Trên tải này có booking mà auth.uid() là một phía không. */
CREATE OR REPLACE FUNCTION public.freight_acct_load_has_my_booking(p_load_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.freight_bookings b
    WHERE b.load_id = p_load_id
      AND (b.shipper_account_id = auth.uid() OR b.carrier_account_id = auth.uid())
  );
$$;

/** Xe này có nằm trong booking mà auth.uid() là chủ hàng không. */
CREATE OR REPLACE FUNCTION public.freight_acct_vehicle_in_my_booking(p_vehicle_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.freight_bookings b
    WHERE b.my_vehicle_id = p_vehicle_id AND b.shipper_account_id = auth.uid()
  );
$$;

/** Tài xế này có nằm trong booking mà auth.uid() là chủ hàng không. */
CREATE OR REPLACE FUNCTION public.freight_acct_driver_in_my_booking(p_driver_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.freight_bookings b
    WHERE b.my_driver_id = p_driver_id AND b.shipper_account_id = auth.uid()
  );
$$;

/** Kho này có là điểm lấy của một booking ĐANG SỐNG mà auth.uid() là nhà xe không. */
CREATE OR REPLACE FUNCTION public.freight_acct_warehouse_pickup_for_me(p_warehouse_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.freight_loads l
    JOIN public.freight_bookings b ON b.load_id = l.id
    WHERE l.pickup_point_id = p_warehouse_id
      AND b.carrier_account_id = auth.uid()
      AND b.status NOT IN ('CANCELLED', 'DECLINED')
  );
$$;

/** Xe này có được ĐỀ XUẤT trong bid cho một tải của auth.uid() không. */
CREATE OR REPLACE FUNCTION public.freight_acct_vehicle_proposed_to_me(p_vehicle_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.freight_bids b
    JOIN public.freight_loads l ON l.id = b.load_id
    WHERE b.proposed_vehicle_id = p_vehicle_id AND l.poster_account_id = auth.uid()
  );
$$;

/** Tài xế này có được ĐỀ XUẤT trong bid cho một tải của auth.uid() không. */
CREATE OR REPLACE FUNCTION public.freight_acct_driver_proposed_to_me(p_driver_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.freight_bids b
    JOIN public.freight_loads l ON l.id = b.load_id
    WHERE b.proposed_driver_id = p_driver_id AND l.poster_account_id = auth.uid()
  );
$$;

-- Hồ sơ tài khoản: mọi người đã đăng nhập đọc được (thư mục đối tác —
-- thông tin tự khai để hai bên liên lạc, luôn hiển thị kèm nhãn tự khai
-- phía client). Ghi chỉ qua RPC freight_acct_upsert_profile.
DROP POLICY IF EXISTS freight_account_profiles_select ON public.freight_account_profiles;
CREATE POLICY freight_account_profiles_select ON public.freight_account_profiles
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- Kho của tôi: chủ sở hữu đọc/ghi; nhà xe có booking ĐANG SỐNG gắn với
-- load lấy hàng tại kho này đọc được (biết điểm lấy sau khi chốt).
DROP POLICY IF EXISTS freight_my_warehouses_select ON public.freight_my_warehouses;
CREATE POLICY freight_my_warehouses_select ON public.freight_my_warehouses
  FOR SELECT TO authenticated USING (
    account_id = auth.uid()
    OR public.freight_acct_warehouse_pickup_for_me(freight_my_warehouses.id)
  );
DROP POLICY IF EXISTS freight_my_warehouses_insert ON public.freight_my_warehouses;
CREATE POLICY freight_my_warehouses_insert ON public.freight_my_warehouses
  FOR INSERT TO authenticated WITH CHECK (account_id = auth.uid());
DROP POLICY IF EXISTS freight_my_warehouses_update ON public.freight_my_warehouses;
CREATE POLICY freight_my_warehouses_update ON public.freight_my_warehouses
  FOR UPDATE TO authenticated USING (account_id = auth.uid()) WITH CHECK (account_id = auth.uid());
DROP POLICY IF EXISTS freight_my_warehouses_delete ON public.freight_my_warehouses;
CREATE POLICY freight_my_warehouses_delete ON public.freight_my_warehouses
  FOR DELETE TO authenticated USING (account_id = auth.uid());

-- Xe của tôi: chủ sở hữu đọc/ghi; chủ hàng của booking đã gán xe này
-- đọc được (hiển thị cho đối tác sau khi chốt).
DROP POLICY IF EXISTS freight_my_vehicles_select ON public.freight_my_vehicles;
CREATE POLICY freight_my_vehicles_select ON public.freight_my_vehicles
  FOR SELECT TO authenticated USING (
    account_id = auth.uid()
    OR public.freight_acct_vehicle_in_my_booking(freight_my_vehicles.id)
  );
DROP POLICY IF EXISTS freight_my_vehicles_insert ON public.freight_my_vehicles;
CREATE POLICY freight_my_vehicles_insert ON public.freight_my_vehicles
  FOR INSERT TO authenticated WITH CHECK (account_id = auth.uid());
DROP POLICY IF EXISTS freight_my_vehicles_update ON public.freight_my_vehicles;
CREATE POLICY freight_my_vehicles_update ON public.freight_my_vehicles
  FOR UPDATE TO authenticated USING (account_id = auth.uid()) WITH CHECK (account_id = auth.uid());
DROP POLICY IF EXISTS freight_my_vehicles_delete ON public.freight_my_vehicles;
CREATE POLICY freight_my_vehicles_delete ON public.freight_my_vehicles
  FOR DELETE TO authenticated USING (account_id = auth.uid());

-- Tài xế của tôi: chủ sở hữu đọc/ghi; chính tài xế (user_id) đọc được;
-- chủ hàng của booking đã gán tài xế này đọc được.
DROP POLICY IF EXISTS freight_my_drivers_select ON public.freight_my_drivers;
CREATE POLICY freight_my_drivers_select ON public.freight_my_drivers
  FOR SELECT TO authenticated USING (
    account_id = auth.uid()
    OR user_id = auth.uid()
    OR public.freight_acct_driver_in_my_booking(freight_my_drivers.id)
  );
DROP POLICY IF EXISTS freight_my_drivers_insert ON public.freight_my_drivers;
CREATE POLICY freight_my_drivers_insert ON public.freight_my_drivers
  FOR INSERT TO authenticated WITH CHECK (account_id = auth.uid());
DROP POLICY IF EXISTS freight_my_drivers_update ON public.freight_my_drivers;
CREATE POLICY freight_my_drivers_update ON public.freight_my_drivers
  FOR UPDATE TO authenticated USING (account_id = auth.uid()) WITH CHECK (account_id = auth.uid());
DROP POLICY IF EXISTS freight_my_drivers_delete ON public.freight_my_drivers;
CREATE POLICY freight_my_drivers_delete ON public.freight_my_drivers
  FOR DELETE TO authenticated USING (account_id = auth.uid());

-- Tuyến của tôi: thông tin nhà xe TỰ CÔNG BỐ — mọi người đã đăng nhập
-- đọc được; ghi chỉ chủ sở hữu.
DROP POLICY IF EXISTS freight_my_routes_select ON public.freight_my_routes;
CREATE POLICY freight_my_routes_select ON public.freight_my_routes
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS freight_my_routes_insert ON public.freight_my_routes;
CREATE POLICY freight_my_routes_insert ON public.freight_my_routes
  FOR INSERT TO authenticated WITH CHECK (account_id = auth.uid());
DROP POLICY IF EXISTS freight_my_routes_update ON public.freight_my_routes;
CREATE POLICY freight_my_routes_update ON public.freight_my_routes
  FOR UPDATE TO authenticated USING (account_id = auth.uid()) WITH CHECK (account_id = auth.uid());
DROP POLICY IF EXISTS freight_my_routes_delete ON public.freight_my_routes;
CREATE POLICY freight_my_routes_delete ON public.freight_my_routes
  FOR DELETE TO authenticated USING (account_id = auth.uid());

-- Kết nối tài khoản: một trong hai phía đọc được; tạo PENDING chỉ với
-- requester = chính mình (RPC là đường chính, policy là lớp bảo hiểm);
-- cập nhật bởi một trong hai phía (RPC guard trạng thái chặt hơn).
DROP POLICY IF EXISTS freight_account_links_select ON public.freight_account_links;
CREATE POLICY freight_account_links_select ON public.freight_account_links
  FOR SELECT TO authenticated USING (
    requester_account_id = auth.uid() OR addressee_account_id = auth.uid()
  );
DROP POLICY IF EXISTS freight_account_links_insert ON public.freight_account_links;
CREATE POLICY freight_account_links_insert ON public.freight_account_links
  FOR INSERT TO authenticated WITH CHECK (
    requester_account_id = auth.uid() AND status = 'PENDING'
  );
DROP POLICY IF EXISTS freight_account_links_update ON public.freight_account_links;
CREATE POLICY freight_account_links_update ON public.freight_account_links
  FOR UPDATE TO authenticated
  USING (requester_account_id = auth.uid() OR addressee_account_id = auth.uid())
  WITH CHECK (requester_account_id = auth.uid() OR addressee_account_id = auth.uid());

-- Tải: chủ tải, tài khoản được chỉ định, hai phía của một booking trên
-- tải, và thành viên group được chủ tải chia sẻ tải vào — đọc được.
-- Ghi chỉ qua RPC.
DROP POLICY IF EXISTS freight_loads_select_acct ON public.freight_loads;
CREATE POLICY freight_loads_select_acct ON public.freight_loads
  FOR SELECT TO authenticated USING (
    poster_account_id = auth.uid()
    OR directed_account_id = auth.uid()
    OR public.freight_acct_load_has_my_booking(freight_loads.id)
    OR EXISTS (
      SELECT 1 FROM public.freight_load_groups lg
      WHERE lg.load_id = freight_loads.id AND public.freight_is_group_member(lg.group_id)
    )
  );

-- Booking: hai phía giao dịch + tài xế liên kết của nhà xe đọc được.
-- Ghi chỉ qua RPC.
DROP POLICY IF EXISTS freight_bookings_select_acct ON public.freight_bookings;
CREATE POLICY freight_bookings_select_acct ON public.freight_bookings
  FOR SELECT TO authenticated USING (
    shipper_account_id = auth.uid()
    OR carrier_account_id = auth.uid()
    OR public.freight_acct_driver_linked_to(freight_bookings.carrier_account_id)
  );

-- Sự kiện: hai phía của booking + tài xế liên kết đọc được; append-only
-- (không policy ghi).
DROP POLICY IF EXISTS freight_events_select_acct ON public.freight_booking_events;
CREATE POLICY freight_events_select_acct ON public.freight_booking_events
  FOR SELECT TO authenticated USING (
    public.freight_acct_booking_visible(freight_booking_events.booking_id)
  );

-- Chia sẻ tải vào group: chủ tải và thành viên group đích đọc được.
-- Ghi chỉ qua RPC share/unshare.
DROP POLICY IF EXISTS freight_load_groups_select ON public.freight_load_groups;
CREATE POLICY freight_load_groups_select ON public.freight_load_groups
  FOR SELECT TO authenticated USING (
    shared_by = auth.uid() OR public.freight_is_group_member(group_id)
  );

GRANT SELECT ON public.freight_account_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.freight_my_warehouses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.freight_my_vehicles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.freight_my_drivers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.freight_my_routes TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.freight_account_links TO authenticated;
GRANT SELECT ON public.freight_loads, public.freight_bookings, public.freight_booking_events TO authenticated;
GRANT SELECT ON public.freight_load_groups TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_is_group_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_my_group_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_is_linked(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_actor_side(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_my_linked_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_shares_group(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_driver_linked_to(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_booking_visible(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_load_has_my_booking(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_vehicle_in_my_booking(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_driver_in_my_booking(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_warehouse_pickup_for_me(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_vehicle_proposed_to_me(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_driver_proposed_to_me(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 6. VIEW TRA CỨU freight_loads_discover (bản rút gọn theo tài khoản)
-- Chỉ tỉnh đi/đến, loại hàng, khối lượng/kiện, cửa sổ giờ, giá mong
-- muốn — KHÔNG địa chỉ chi tiết/SĐT. Điều kiện thấy:
--   - tải của chính mình;
--   - PUBLIC: mọi tài khoản đã đăng nhập;
--   - DIRECT: đúng tài khoản được chỉ định;
--   - NETWORK: đã kết nối ACCEPTED với chủ tải, HOẶC cùng thuộc một
--     group trao đổi với chủ tải (group là nơi gặp nhau);
--   - tải được chủ tải chia sẻ vào một group mà mình là thành viên.
-- View chạy với quyền owner (bỏ qua RLS bảng gốc) như carriers_public —
-- điều kiện lọc nằm trong WHERE.
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW public.freight_loads_discover AS
SELECT
  l.id,
  l.code,
  l.poster_account_id,
  ap.display_name AS poster_display_name,
  l.goods_desc,
  l.weight_kg,
  l.packages,
  l.volume_m3,
  l.vehicle_type_required,
  l.pickup_province,
  l.delivery_province,
  l.pickup_window_from,
  l.pickup_window_to,
  l.delivery_window_to,
  l.visibility,
  l.asking_price,
  l.status,
  l.expires_at,
  l.created_at,
  l.open_for_bids
FROM public.freight_loads l
LEFT JOIN public.freight_account_profiles ap ON ap.account_id = l.poster_account_id
WHERE l.status = 'POSTED'
  AND (
    l.poster_account_id = auth.uid()
    OR l.visibility = 'PUBLIC'
    OR (l.visibility = 'DIRECT' AND l.directed_account_id = auth.uid())
    OR (l.visibility = 'NETWORK' AND (
      public.freight_acct_is_linked(l.poster_account_id, auth.uid())
      OR public.freight_acct_shares_group(l.poster_account_id, auth.uid())
    ))
    OR EXISTS (
      SELECT 1 FROM public.freight_load_groups lg
      WHERE lg.load_id = l.id AND lg.group_id IN (SELECT public.freight_my_group_ids())
    )
  );
GRANT SELECT ON public.freight_loads_discover TO authenticated;

-- ---------------------------------------------------------------------
-- 7. RPC freight_acct_* (SECURITY DEFINER — cổng ghi nhạy cảm)
-- Mã lỗi là chuỗi cấu trúc, client map sang tiếng Việt
-- (src/shared/supabase/freight.ts + freightAccount.ts):
-- not_authenticated, not_member, forbidden, not_party, not_poster,
-- not_carrier, invalid_transition, note_required, reason_required,
-- load_not_found, load_not_open, booking_not_found, carrier_not_found,
-- invalid_visibility, directed_required, not_linked,
-- order_not_in_group, warehouse_not_found, vehicle_not_found,
-- driver_not_found, has_active_booking, already_booked, invalid_role,
-- account_not_found, already_linked, link_not_found, cannot_link_self.
-- Mã lỗi T2 (mục 8): own_load, bidding_closed, not_visible,
-- invalid_price, invalid_expiry, bid_not_found, bid_expired,
-- not_bid_owner.
-- ---------------------------------------------------------------------

-- ----- Hồ sơ tài khoản (tự khai) -----

CREATE OR REPLACE FUNCTION public.freight_acct_upsert_profile(
  p_display_name text, p_legal_name text, p_tax_code text,
  p_contact_name text, p_contact_phone text, p_address text, p_province text,
  p_is_shipper boolean, p_is_carrier boolean,
  p_business_license_no text, p_capability_note text
)
RETURNS public.freight_account_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_row public.freight_account_profiles;
BEGIN
  IF COALESCE(btrim(p_display_name), '') = '' THEN
    RAISE EXCEPTION 'note_required';
  END IF;
  IF NOT COALESCE(p_is_shipper, false) AND NOT COALESCE(p_is_carrier, false) THEN
    RAISE EXCEPTION 'invalid_role';
  END IF;
  INSERT INTO public.freight_account_profiles
    (account_id, display_name, legal_name, tax_code, contact_name, contact_phone,
     address, province, is_shipper, is_carrier, business_license_no, capability_note)
  VALUES
    (v_uid, btrim(p_display_name), p_legal_name, p_tax_code, p_contact_name, p_contact_phone,
     p_address, p_province, COALESCE(p_is_shipper, false), COALESCE(p_is_carrier, false),
     p_business_license_no, p_capability_note)
  ON CONFLICT (account_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    legal_name = EXCLUDED.legal_name,
    tax_code = EXCLUDED.tax_code,
    contact_name = EXCLUDED.contact_name,
    contact_phone = EXCLUDED.contact_phone,
    address = EXCLUDED.address,
    province = EXCLUDED.province,
    is_shipper = EXCLUDED.is_shipper,
    is_carrier = EXCLUDED.is_carrier,
    business_license_no = EXCLUDED.business_license_no,
    capability_note = EXCLUDED.capability_note
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- ----- Tải đăng theo tài khoản -----

CREATE OR REPLACE FUNCTION public.freight_acct_create_load(
  p_source_group_id uuid, p_order_id uuid, p_shipment_code text, p_goods_desc text,
  p_weight_kg numeric, p_packages int, p_volume_m3 numeric, p_vehicle_type_required text,
  p_pickup_point_id uuid, p_pickup_address text, p_pickup_province text,
  p_delivery_address text, p_delivery_province text,
  p_delivery_contact_name text, p_delivery_contact_phone text,
  p_pickup_window_from timestamptz, p_pickup_window_to timestamptz, p_delivery_window_to timestamptz,
  p_visibility text, p_directed_account_id uuid, p_asking_price numeric, p_expires_at timestamptz,
  p_open_for_bids boolean
)
RETURNS public.freight_loads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_group uuid := p_source_group_id;
  -- T2 (thiết kế 3.4): DIRECT mặc định KHÔNG nhận bid (chỉ bật khi chủ
  -- tải chủ động chọn — khi đó chỉ tài khoản được chỉ định chào được);
  -- NETWORK/PUBLIC mặc định MỞ chào giá, chủ tải tắt được.
  v_open boolean := COALESCE(p_open_for_bids, p_visibility <> 'DIRECT');
  v_row public.freight_loads;
BEGIN
  IF COALESCE(btrim(p_goods_desc), '') = '' THEN
    RAISE EXCEPTION 'note_required';
  END IF;
  IF p_visibility NOT IN ('DIRECT', 'NETWORK', 'PUBLIC') THEN
    RAISE EXCEPTION 'invalid_visibility';
  END IF;
  IF p_visibility = 'DIRECT' THEN
    IF p_directed_account_id IS NULL THEN
      RAISE EXCEPTION 'directed_required';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.freight_account_profiles ap WHERE ap.account_id = p_directed_account_id
    ) THEN
      RAISE EXCEPTION 'carrier_not_found';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.freight_account_profiles ap
      WHERE ap.account_id = p_directed_account_id AND ap.is_carrier
    ) THEN
      RAISE EXCEPTION 'not_carrier';
    END IF;
  END IF;
  -- Nguồn tuỳ chọn: gắn đơn thì đơn phải thuộc một group mà người gọi là
  -- thành viên (kiểm tra NGUỒN DỮ LIỆU, không phải quyền sở hữu tải).
  IF p_order_id IS NOT NULL THEN
    SELECT o.group_id INTO v_group FROM public.orders o WHERE o.id = p_order_id;
    IF v_group IS NULL OR NOT public.freight_is_group_member(v_group) THEN
      RAISE EXCEPTION 'order_not_in_group';
    END IF;
  ELSIF v_group IS NOT NULL AND NOT public.freight_is_group_member(v_group) THEN
    RAISE EXCEPTION 'not_member';
  END IF;
  IF p_pickup_point_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.freight_my_warehouses w
    WHERE w.id = p_pickup_point_id AND w.account_id = v_uid
  ) THEN
    RAISE EXCEPTION 'warehouse_not_found';
  END IF;
  INSERT INTO public.freight_loads (
    code, group_id, order_id, shipment_code, goods_desc, weight_kg, packages, volume_m3,
    vehicle_type_required, pickup_point_id, pickup_address, pickup_province,
    delivery_address, delivery_province, delivery_contact_name, delivery_contact_phone,
    pickup_window_from, pickup_window_to, delivery_window_to,
    visibility, directed_account_id, asking_price, open_for_bids, status, expires_at, created_by,
    poster_account_id
  ) VALUES (
    'TAI-' || lpad(nextval('public.freight_load_code_seq')::text, 6, '0'),
    v_group, p_order_id, p_shipment_code, btrim(p_goods_desc), p_weight_kg, p_packages, p_volume_m3,
    p_vehicle_type_required, p_pickup_point_id, p_pickup_address, p_pickup_province,
    p_delivery_address, p_delivery_province, p_delivery_contact_name, p_delivery_contact_phone,
    p_pickup_window_from, p_pickup_window_to, p_delivery_window_to,
    p_visibility, p_directed_account_id, p_asking_price, v_open, 'POSTED', p_expires_at, v_uid,
    v_uid
  )
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.freight_acct_cancel_load(p_load_id uuid, p_reason text)
RETURNS public.freight_loads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_load public.freight_loads;
  v_booking public.freight_bookings;
  v_row public.freight_loads;
BEGIN
  SELECT * INTO v_load FROM public.freight_loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'load_not_found';
  END IF;
  IF v_load.poster_account_id IS DISTINCT FROM v_uid AND v_load.created_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not_poster';
  END IF;
  IF v_load.status NOT IN ('DRAFT', 'POSTED', 'ASSIGNED') THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;
  SELECT * INTO v_booking FROM public.freight_bookings
  WHERE load_id = v_load.id AND status NOT IN ('CANCELLED', 'DECLINED')
  LIMIT 1;
  IF FOUND THEN
    IF v_booking.status <> 'PENDING_CONFIRM' THEN
      RAISE EXCEPTION 'has_active_booking';
    END IF;
    UPDATE public.freight_bookings
    SET status = 'CANCELLED', cancel_reason = p_reason, cancelled_by_side = 'SHIPPER'
    WHERE id = v_booking.id;
    PERFORM public.freight_add_event(v_booking.id, 'CANCELLED', 'SHIPPER', v_booking.status, 'CANCELLED', p_reason, NULL, NULL);
  END IF;
  UPDATE public.freight_loads SET status = 'CANCELLED' WHERE id = v_load.id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- ----- Chia sẻ tải vào group (group = nơi trao đổi, không phải sở hữu) -----

CREATE OR REPLACE FUNCTION public.freight_acct_share_load_to_group(p_load_id uuid, p_group_id uuid)
RETURNS public.freight_load_groups
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_load public.freight_loads;
  v_row public.freight_load_groups;
BEGIN
  SELECT * INTO v_load FROM public.freight_loads WHERE id = p_load_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'load_not_found';
  END IF;
  IF v_load.poster_account_id IS DISTINCT FROM v_uid AND v_load.created_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not_poster';
  END IF;
  IF NOT public.freight_is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'not_member';
  END IF;
  INSERT INTO public.freight_load_groups (load_id, group_id, shared_by)
  VALUES (p_load_id, p_group_id, v_uid)
  ON CONFLICT (load_id, group_id) DO UPDATE SET shared_by = EXCLUDED.shared_by
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.freight_acct_unshare_load(p_load_id uuid, p_group_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_load public.freight_loads;
BEGIN
  SELECT * INTO v_load FROM public.freight_loads WHERE id = p_load_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'load_not_found';
  END IF;
  IF v_load.poster_account_id IS DISTINCT FROM v_uid AND v_load.created_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not_poster';
  END IF;
  DELETE FROM public.freight_load_groups WHERE load_id = p_load_id AND group_id = p_group_id;
END;
$$;

-- ----- Chốt chuyến theo tài khoản -----

CREATE OR REPLACE FUNCTION public.freight_acct_assign_booking(
  p_load_id uuid, p_carrier_account_id uuid, p_price_agreed numeric
)
RETURNS public.freight_bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_load public.freight_loads;
  v_booking public.freight_bookings;
BEGIN
  SELECT * INTO v_load FROM public.freight_loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'load_not_found';
  END IF;
  IF v_load.poster_account_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not_poster';
  END IF;
  IF v_load.status <> 'POSTED' THEN
    RAISE EXCEPTION 'load_not_open';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.freight_account_profiles ap WHERE ap.account_id = p_carrier_account_id
  ) THEN
    RAISE EXCEPTION 'carrier_not_found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.freight_account_profiles ap
    WHERE ap.account_id = p_carrier_account_id AND ap.is_carrier
  ) THEN
    RAISE EXCEPTION 'not_carrier';
  END IF;
  -- Tự chỉ định CHÍNH MÌNH được phép (tự vận chuyển bằng đội xe riêng):
  -- không có guard carrier <> poster ở đây.
  IF v_load.visibility = 'DIRECT' AND v_load.directed_account_id IS DISTINCT FROM p_carrier_account_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_load.visibility = 'NETWORK'
     AND v_load.directed_account_id IS DISTINCT FROM p_carrier_account_id
     AND p_carrier_account_id IS DISTINCT FROM v_uid
     AND NOT public.freight_acct_is_linked(v_uid, p_carrier_account_id)
     AND NOT public.freight_acct_shares_group(v_uid, p_carrier_account_id) THEN
    RAISE EXCEPTION 'not_linked';
  END IF;
  BEGIN
    INSERT INTO public.freight_bookings
      (code, load_id, order_id, shipper_group_id, carrier_group_id,
       shipper_account_id, carrier_account_id, price_agreed, status)
    VALUES
      ('CH-' || lpad(nextval('public.freight_booking_code_seq')::text, 6, '0'),
       v_load.id, v_load.order_id, v_load.group_id, NULL,
       v_uid, p_carrier_account_id,
       COALESCE(p_price_agreed, v_load.asking_price), 'PENDING_CONFIRM')
    RETURNING * INTO v_booking;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'already_booked';
  END;
  UPDATE public.freight_loads SET status = 'ASSIGNED' WHERE id = v_load.id;
  PERFORM public.freight_add_event(v_booking.id, 'ASSIGNED', 'SHIPPER', NULL, 'PENDING_CONFIRM', NULL, NULL, NULL);
  RETURN v_booking;
END;
$$;

CREATE OR REPLACE FUNCTION public.freight_acct_respond_booking(
  p_booking_id uuid, p_accept boolean, p_note text
)
RETURNS public.freight_bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_b public.freight_bookings;
  v_row public.freight_bookings;
BEGIN
  SELECT * INTO v_b FROM public.freight_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_not_found';
  END IF;
  IF v_b.carrier_account_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not_party';
  END IF;
  IF v_b.status <> 'PENDING_CONFIRM' THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;
  IF p_accept THEN
    UPDATE public.freight_bookings SET status = 'BOOKED' WHERE id = v_b.id
    RETURNING * INTO v_row;
    UPDATE public.freight_loads SET status = 'BOOKED' WHERE id = v_b.load_id AND status = 'ASSIGNED';
    PERFORM public.freight_add_event(v_b.id, 'BOOKED', 'CARRIER', 'PENDING_CONFIRM', 'BOOKED', p_note, NULL, NULL);
    PERFORM public.freight_sync_order(v_b.order_id, v_b.code, 'BOOKED');
  ELSE
    UPDATE public.freight_bookings SET status = 'DECLINED' WHERE id = v_b.id
    RETURNING * INTO v_row;
    UPDATE public.freight_loads SET status = 'POSTED' WHERE id = v_b.load_id AND status = 'ASSIGNED';
    PERFORM public.freight_add_event(v_b.id, 'DECLINED', 'CARRIER', 'PENDING_CONFIRM', 'DECLINED', p_note, NULL, NULL);
  END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.freight_acct_assign_vehicle_driver(
  p_booking_id uuid, p_my_vehicle_id uuid, p_my_driver_id uuid
)
RETURNS public.freight_bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_b public.freight_bookings;
  v_row public.freight_bookings;
BEGIN
  SELECT * INTO v_b FROM public.freight_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_not_found';
  END IF;
  IF v_b.carrier_account_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not_party';
  END IF;
  IF v_b.status NOT IN ('BOOKED', 'ARRIVED_PICKUP') THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;
  IF p_my_vehicle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.freight_my_vehicles v
    WHERE v.id = p_my_vehicle_id AND v.account_id = v_b.carrier_account_id
  ) THEN
    RAISE EXCEPTION 'vehicle_not_found';
  END IF;
  IF p_my_driver_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.freight_my_drivers d
    WHERE d.id = p_my_driver_id AND d.account_id = v_b.carrier_account_id
  ) THEN
    RAISE EXCEPTION 'driver_not_found';
  END IF;
  -- LƯU Ý BẢN A (cố ý, không phải thiếu sót): RPC này KHÔNG kiểm tra
  -- inspection_expires_at / insurance_expires_at của xe và
  -- license_expires_at của tài xế. Hạn giấy tờ là thông tin tự khai chỉ
  -- để hiển thị cho đối tác tự đánh giá; tính hợp lệ là cam kết của
  -- chính nhà xe. Cơ chế chặn theo hạn giấy tờ là khoản nợ NT-02 (Bản B).
  UPDATE public.freight_bookings
  SET my_vehicle_id = COALESCE(p_my_vehicle_id, my_vehicle_id),
      my_driver_id = COALESCE(p_my_driver_id, my_driver_id)
  WHERE id = v_b.id
  RETURNING * INTO v_row;
  PERFORM public.freight_add_event(v_b.id, 'VEHICLE_DRIVER_ASSIGNED', 'CARRIER', v_b.status, v_b.status, NULL, NULL, NULL);
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.freight_acct_advance_booking(
  p_booking_id uuid, p_to_status text, p_note text, p_lat double precision, p_lng double precision
)
RETURNS public.freight_bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_b public.freight_bookings;
  v_row public.freight_bookings;
  v_side text;
BEGIN
  SELECT * INTO v_b FROM public.freight_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_not_found';
  END IF;
  v_side := public.freight_acct_actor_side(v_b.shipper_account_id, v_b.carrier_account_id);
  IF v_side IS NULL THEN
    RAISE EXCEPTION 'not_party';
  END IF;
  IF p_to_status = 'CANCELLED' AND COALESCE(btrim(p_note), '') = '' THEN
    RAISE EXCEPTION 'reason_required';
  END IF;
  IF NOT public.freight_booking_transition_allowed(v_b.status, p_to_status, v_side) THEN
    -- Tự vận chuyển (shipper = carrier = người gọi): phân phía theo
    -- chuyển đổi — thử phía CARRIER/DRIVER khi phía SHIPPER không được.
    IF v_b.shipper_account_id = v_uid AND v_b.carrier_account_id = v_uid
       AND public.freight_booking_transition_allowed(v_b.status, p_to_status, 'CARRIER') THEN
      v_side := 'CARRIER';
    ELSIF v_b.shipper_account_id = v_uid AND v_b.carrier_account_id = v_uid
       AND public.freight_booking_transition_allowed(v_b.status, p_to_status, 'DRIVER') THEN
      v_side := 'DRIVER';
    ELSE
      RAISE EXCEPTION 'invalid_transition';
    END IF;
  END IF;
  UPDATE public.freight_bookings
  SET status = p_to_status,
      pickup_at_actual = CASE WHEN p_to_status = 'PICKED_UP' THEN now() ELSE pickup_at_actual END,
      delivered_at_actual = CASE WHEN p_to_status = 'DELIVERED' THEN now() ELSE delivered_at_actual END,
      cancel_reason = CASE WHEN p_to_status = 'CANCELLED' THEN p_note ELSE cancel_reason END,
      cancelled_by_side = CASE WHEN p_to_status = 'CANCELLED' THEN v_side ELSE cancelled_by_side END
  WHERE id = v_b.id
  RETURNING * INTO v_row;
  IF p_to_status = 'CANCELLED' THEN
    UPDATE public.freight_loads SET status = 'POSTED'
    WHERE id = v_b.load_id AND status IN ('ASSIGNED', 'BOOKED');
  END IF;
  IF p_to_status = 'COMPLETED'
     AND v_b.shipper_account_id IS NOT NULL AND v_b.carrier_account_id IS NOT NULL
     AND v_b.shipper_account_id <> v_b.carrier_account_id THEN
    -- Hai phía đã hoàn thành một chuyến cùng nhau -> tự kết nối
    -- PAST_DEAL (ACCEPTED). Lỗi ở đây không chặn việc hoàn thành chuyến.
    BEGIN
      INSERT INTO public.freight_account_links
        (requester_account_id, addressee_account_id, source, status, created_by)
      VALUES
        (v_b.shipper_account_id, v_b.carrier_account_id, 'PAST_DEAL', 'ACCEPTED', NULL)
      ON CONFLICT (LEAST(requester_account_id, addressee_account_id),
                   GREATEST(requester_account_id, addressee_account_id))
      DO UPDATE SET status = 'ACCEPTED';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Khong tu tao duoc ket noi PAST_DEAL cho chuyen %: %', v_b.code, SQLERRM;
    END;
  END IF;
  PERFORM public.freight_add_event(v_b.id, p_to_status, v_side, v_b.status, p_to_status, p_note, p_lat, p_lng);
  PERFORM public.freight_sync_order(v_b.order_id, v_b.code, p_to_status);
  RETURN v_row;
END;
$$;

/** Huỷ chuyến (bắt buộc lý do) — vỏ mỏng trên advance theo tài khoản. */
CREATE OR REPLACE FUNCTION public.freight_acct_cancel_booking(p_booking_id uuid, p_reason text)
RETURNS public.freight_bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'reason_required';
  END IF;
  RETURN public.freight_acct_advance_booking(p_booking_id, 'CANCELLED', p_reason, NULL, NULL);
END;
$$;

-- ----- Kết nối giữa hai tài khoản -----

CREATE OR REPLACE FUNCTION public.freight_acct_invite_link(p_other_account_id uuid)
RETURNS public.freight_account_links
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_row public.freight_account_links;
BEGIN
  IF p_other_account_id = v_uid THEN
    RAISE EXCEPTION 'cannot_link_self';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.freight_account_profiles ap WHERE ap.account_id = p_other_account_id
  ) THEN
    RAISE EXCEPTION 'account_not_found';
  END IF;
  SELECT * INTO v_row FROM public.freight_account_links lk
  WHERE (LEAST(lk.requester_account_id, lk.addressee_account_id),
         GREATEST(lk.requester_account_id, lk.addressee_account_id))
      = (LEAST(v_uid, p_other_account_id), GREATEST(v_uid, p_other_account_id));
  IF FOUND THEN
    IF v_row.status = 'ACCEPTED' THEN
      RAISE EXCEPTION 'already_linked';
    END IF;
    IF v_row.status = 'PENDING' THEN
      -- Đã có lời mời đang chờ (một trong hai chiều) — trả lại để UI xử lý.
      RETURN v_row;
    END IF;
    -- ENDED -> mời lại bằng cách cập nhật dòng cũ.
    UPDATE public.freight_account_links
    SET requester_account_id = v_uid, addressee_account_id = p_other_account_id,
        source = 'MANUAL', status = 'PENDING', created_by = v_uid
    WHERE id = v_row.id
    RETURNING * INTO v_row;
    RETURN v_row;
  END IF;
  INSERT INTO public.freight_account_links
    (requester_account_id, addressee_account_id, source, status, created_by)
  VALUES (v_uid, p_other_account_id, 'MANUAL', 'PENDING', v_uid)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.freight_acct_respond_link(p_link_id uuid, p_accept boolean)
RETURNS public.freight_account_links
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_row public.freight_account_links;
BEGIN
  SELECT * INTO v_row FROM public.freight_account_links WHERE id = p_link_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'link_not_found';
  END IF;
  IF v_row.requester_account_id <> v_uid AND v_row.addressee_account_id <> v_uid THEN
    RAISE EXCEPTION 'not_party';
  END IF;
  IF p_accept THEN
    -- Chấp nhận chỉ phía NHẬN lời mời, khi đang PENDING.
    IF v_row.status <> 'PENDING' OR v_row.addressee_account_id <> v_uid THEN
      RAISE EXCEPTION 'invalid_transition';
    END IF;
    UPDATE public.freight_account_links SET status = 'ACCEPTED' WHERE id = v_row.id
    RETURNING * INTO v_row;
    RETURN v_row;
  END IF;
  IF v_row.status = 'PENDING' THEN
    -- Từ chối lời mời (phía nhận) hoặc rút lời mời (phía gửi): XOÁ dòng
    -- cho danh sách sạch.
    DELETE FROM public.freight_account_links WHERE id = v_row.id
    RETURNING * INTO v_row;
    RETURN v_row;
  END IF;
  IF v_row.status = 'ACCEPTED' THEN
    -- Kết thúc một kết nối đang có hiệu lực: một trong hai phía đều được.
    UPDATE public.freight_account_links SET status = 'ENDED' WHERE id = v_row.id
    RETURNING * INTO v_row;
    RETURN v_row;
  END IF;
  RAISE EXCEPTION 'invalid_transition';
END;
$$;

GRANT EXECUTE ON FUNCTION public.freight_acct_upsert_profile(text, text, text, text, text, text, text, boolean, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_create_load(uuid, uuid, text, text, numeric, int, numeric, text, uuid, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz, text, uuid, numeric, timestamptz, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_cancel_load(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_share_load_to_group(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_unshare_load(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_assign_booking(uuid, uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_respond_booking(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_assign_vehicle_driver(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_advance_booking(uuid, text, text, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_cancel_booking(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_invite_link(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_respond_link(uuid, boolean) TO authenticated;

-- ---------------------------------------------------------------------
-- 8. T2 — CHÀO GIÁ (R2)
-- Thiết kế: thiet-ke-lai-tai-khoan-va-t2-chao-gia.md Phần 3.
--   * Bid là ĐỀ NGHỊ chủ động của nhà xe (giá + xe/tài xế dự kiến + giờ
--     lấy + hạn hiệu lực). Sửa giá = cập nhật chính bid đó + ghi
--     freight_bid_history. Một (tải, tài khoản) tối đa MỘT bid PENDING.
--   * freight_acct_accept_bid NGUYÊN TỬ: RPC không quyết định chọn ai —
--     quyết định là của chủ tải; RPC chỉ bảo đảm toàn vẹn dữ liệu trong
--     khoảnh khắc chốt (một tải tối đa một booking sống, giá chốt đóng
--     băng = giá bid, bid hết hạn/rút không chốt được). Booking thắng
--     bid vào thẳng BOOKED (không qua PENDING_CONFIRM) vì hai phía đã
--     xác nhận lẫn nhau qua chào/chấp nhận.
--   * Hết hạn theo cơ chế LƯỜI: các RPC liên quan tự đóng bid quá hạn
--     khi chạm vào; freight_acct_expire_stale() để client gọi cơ hội
--     (không phụ thuộc pg_cron).
--   * Xe/tài xế dự kiến trong bid cũng KHÔNG kiểm tra hạn giấy tờ
--     (NT-02, nhất quán toàn hệ).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.freight_bids (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id             uuid NOT NULL REFERENCES public.freight_loads (id) ON DELETE CASCADE,
  -- Tài khoản nhà xe chào giá (tên theo thiết kế Phần 3.1).
  carrier_account_id  uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  bid_price           numeric NOT NULL CHECK (bid_price > 0),
  currency            text NOT NULL DEFAULT 'VND',
  proposed_vehicle_id uuid REFERENCES public.freight_my_vehicles (id) ON DELETE SET NULL,
  proposed_driver_id  uuid REFERENCES public.freight_my_drivers (id) ON DELETE SET NULL,
  eta_pickup_at       timestamptz,
  note                text,
  status              text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED')),
  -- 'lost' (thua bid thắng) | 'load_cancelled' | 'expired' | lý do chủ tải từ chối.
  closed_reason       text,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freight_bids_load ON public.freight_bids (load_id, status);
CREATE INDEX IF NOT EXISTS idx_freight_bids_carrier ON public.freight_bids (carrier_account_id, status);
-- Một tài khoản chỉ có TỐI ĐA MỘT bid đang hiệu lực cho một tải.
CREATE UNIQUE INDEX IF NOT EXISTS uq_freight_bids_live_per_load_carrier
  ON public.freight_bids (load_id, carrier_account_id) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS public.freight_bid_history (
  id          bigserial PRIMARY KEY,
  bid_id      uuid NOT NULL REFERENCES public.freight_bids (id) ON DELETE CASCADE,
  old_price   numeric,
  new_price   numeric,
  old_eta_pickup_at timestamptz,
  new_eta_pickup_at timestamptz,
  changed_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freight_bid_history_bid ON public.freight_bid_history (bid_id, id);

-- Booking thắng bid ghi lại bid nguồn — giá chốt đã đóng băng ở
-- price_agreed = bid_price tại thời điểm accept.
ALTER TABLE public.freight_bookings
  ADD COLUMN IF NOT EXISTS bid_id uuid REFERENCES public.freight_bids (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_freight_bookings_bid ON public.freight_bookings (bid_id);

DROP TRIGGER IF EXISTS trg_freight_bids_touch ON public.freight_bids;
CREATE TRIGGER trg_freight_bids_touch BEFORE UPDATE ON public.freight_bids
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();

-- ----- Helper T2 -----

/**
 * Tài khoản p_uid có THẤY ĐƯỢC tải p_load_id không — cùng quy tắc với
 * view freight_loads_discover (Phần 1.5): của mình / PUBLIC / DIRECT
 * được chỉ định / NETWORK đã kết nối hoặc cùng group / được chia sẻ
 * vào group mình là thành viên.
 */
CREATE OR REPLACE FUNCTION public.freight_acct_load_visible_to(p_load_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.freight_loads l
    WHERE l.id = p_load_id AND (
      l.poster_account_id = p_uid
      OR l.visibility = 'PUBLIC'
      OR (l.visibility = 'DIRECT' AND l.directed_account_id = p_uid)
      OR (l.visibility = 'NETWORK' AND (
        public.freight_acct_is_linked(l.poster_account_id, p_uid)
        OR public.freight_acct_shares_group(l.poster_account_id, p_uid)))
      OR EXISTS (
        SELECT 1 FROM public.freight_load_groups lg
        JOIN public.group_members gm ON gm.group_id = lg.group_id
        WHERE lg.load_id = l.id AND gm.user_id = p_uid
      )
    )
  );
$$;

/**
 * auth.uid() có quyền ĐỌC bid này không: chính bên chào, chủ tải của
 * tải chứa bid, hoặc một phía của booking sinh ra từ bid. Dùng trong
 * RLS của freight_bids / freight_bid_history (SECURITY DEFINER để
 * tránh đệ quy RLS).
 */
CREATE OR REPLACE FUNCTION public.freight_acct_can_see_bid(p_bid_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.freight_bids b
    WHERE b.id = p_bid_id AND (
      b.carrier_account_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.freight_loads l
        WHERE l.id = b.load_id AND l.poster_account_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.freight_bookings bk
        WHERE bk.bid_id = b.id
          AND (bk.shipper_account_id = auth.uid() OR bk.carrier_account_id = auth.uid())
      )
    )
  );
$$;

/** Đóng (EXPIRED) các bid PENDING đã quá hạn của MỘT tải. Trả số dòng. */
CREATE OR REPLACE FUNCTION public.freight_acct_expire_bids(p_load_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.freight_bids
  SET status = 'EXPIRED', closed_reason = 'expired'
  WHERE load_id = p_load_id AND status = 'PENDING' AND expires_at <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

/**
 * Quét hết hạn cơ hội (client gọi khi mở tab Tìm xe / Chuyến, lỗi được
 * bỏ qua phía client): đóng mọi bid PENDING quá hạn + tải POSTED quá
 * hạn đăng mà chưa có booking sống. Trả tổng số dòng đã đóng.
 */
CREATE OR REPLACE FUNCTION public.freight_acct_expire_stale()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bids int;
  v_loads int;
BEGIN
  PERFORM public.freight_require_uid();
  UPDATE public.freight_bids
  SET status = 'EXPIRED', closed_reason = 'expired'
  WHERE status = 'PENDING' AND expires_at <= now();
  GET DIAGNOSTICS v_bids = ROW_COUNT;
  UPDATE public.freight_loads
  SET status = 'EXPIRED'
  WHERE status = 'POSTED' AND expires_at IS NOT NULL AND expires_at <= now()
    AND NOT EXISTS (
      SELECT 1 FROM public.freight_bookings b
      WHERE b.load_id = freight_loads.id AND b.status NOT IN ('CANCELLED', 'DECLINED')
    );
  GET DIAGNOSTICS v_loads = ROW_COUNT;
  RETURN v_bids + v_loads;
END;
$$;

-- ----- RLS T2: bid/history CHỈ ĐỌC qua RLS; mọi thao tác ghi qua RPC -----

ALTER TABLE public.freight_bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_bid_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS freight_bids_select ON public.freight_bids;
CREATE POLICY freight_bids_select ON public.freight_bids
  FOR SELECT TO authenticated USING (public.freight_acct_can_see_bid(id));
DROP POLICY IF EXISTS freight_bid_history_select ON public.freight_bid_history;
CREATE POLICY freight_bid_history_select ON public.freight_bid_history
  FOR SELECT TO authenticated USING (public.freight_acct_can_see_bid(bid_id));

-- Chủ tải đọc được xe/tài xế ĐƯỢC ĐỀ XUẤT trong bid cho tải của mình
-- (hiển thị biển số/loại xe trong bảng chào giá trước khi chốt).
DROP POLICY IF EXISTS freight_my_vehicles_select_bid ON public.freight_my_vehicles;
CREATE POLICY freight_my_vehicles_select_bid ON public.freight_my_vehicles
  FOR SELECT TO authenticated USING (
    public.freight_acct_vehicle_proposed_to_me(freight_my_vehicles.id)
  );
DROP POLICY IF EXISTS freight_my_drivers_select_bid ON public.freight_my_drivers;
CREATE POLICY freight_my_drivers_select_bid ON public.freight_my_drivers
  FOR SELECT TO authenticated USING (
    public.freight_acct_driver_proposed_to_me(freight_my_drivers.id)
  );

GRANT SELECT ON public.freight_bids, public.freight_bid_history TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_load_visible_to(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_can_see_bid(uuid) TO authenticated;

-- ----- RPC chào giá -----

/**
 * Đặt chào giá cho một tải. Điều kiện (thiết kế 3.2): tải còn POSTED +
 * chưa có booking sống + chưa hết hạn đăng (load_not_open); tải bật
 * chào giá (bidding_closed); người gọi THẤY ĐƯỢC tải (not_visible);
 * người gọi có vai trò vận tải (not_carrier) và KHÔNG phải chủ tải
 * (own_load — tự vận chuyển đi đường chỉ định, không qua bid).
 * Nếu đã có bid PENDING của chính mình cho tải này: CẬP NHẬT bid đó
 * (giá/ghi chú/hạn/xe/tài xế dự kiến) + ghi history khi giá/ETA đổi —
 * không tạo bid mới (giữ bất biến 1 bid hiệu lực/tài khoản/tải).
 * Hạn hiệu lực mặc định nếu không khai: LEAST(now()+72h, hạn đăng tải).
 */
CREATE OR REPLACE FUNCTION public.freight_acct_place_bid(
  p_load_id uuid, p_bid_price numeric, p_proposed_vehicle_id uuid, p_proposed_driver_id uuid,
  p_eta_pickup_at timestamptz, p_note text, p_expires_at timestamptz
)
RETURNS public.freight_bids
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_load public.freight_loads;
  v_bid public.freight_bids;
  v_expires timestamptz;
BEGIN
  SELECT * INTO v_load FROM public.freight_loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'load_not_found';
  END IF;
  IF v_load.poster_account_id = v_uid THEN
    RAISE EXCEPTION 'own_load';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.freight_account_profiles ap
    WHERE ap.account_id = v_uid AND ap.is_carrier
  ) THEN
    RAISE EXCEPTION 'not_carrier';
  END IF;
  -- Hết hạn lười cho tải này trước khi xét điều kiện mở.
  PERFORM public.freight_acct_expire_bids(v_load.id);
  IF v_load.status = 'POSTED' AND v_load.expires_at IS NOT NULL AND v_load.expires_at <= now() THEN
    UPDATE public.freight_loads SET status = 'EXPIRED' WHERE id = v_load.id;
    v_load.status := 'EXPIRED';
  END IF;
  IF v_load.status <> 'POSTED' THEN
    RAISE EXCEPTION 'load_not_open';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.freight_bookings b
    WHERE b.load_id = v_load.id AND b.status NOT IN ('CANCELLED', 'DECLINED')
  ) THEN
    RAISE EXCEPTION 'load_not_open';
  END IF;
  IF NOT v_load.open_for_bids THEN
    RAISE EXCEPTION 'bidding_closed';
  END IF;
  IF NOT public.freight_acct_load_visible_to(v_load.id, v_uid) THEN
    RAISE EXCEPTION 'not_visible';
  END IF;
  IF p_bid_price IS NULL OR p_bid_price <= 0 THEN
    RAISE EXCEPTION 'invalid_price';
  END IF;
  IF p_proposed_vehicle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.freight_my_vehicles v
    WHERE v.id = p_proposed_vehicle_id AND v.account_id = v_uid
  ) THEN
    RAISE EXCEPTION 'vehicle_not_found';
  END IF;
  IF p_proposed_driver_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.freight_my_drivers d
    WHERE d.id = p_proposed_driver_id AND d.account_id = v_uid
  ) THEN
    RAISE EXCEPTION 'driver_not_found';
  END IF;
  -- Hạn hiệu lực là hạn của một ĐỀ NGHỊ do chính người chào tự đặt:
  -- chặn giá trị đã ở quá khứ là toàn vẹn dữ liệu, không phải kiểm
  -- soát giấy tờ bên thứ ba.
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'invalid_expiry';
  END IF;
  v_expires := COALESCE(
    p_expires_at,
    LEAST(now() + interval '72 hours', COALESCE(v_load.expires_at, now() + interval '72 hours'))
  );

  SELECT * INTO v_bid FROM public.freight_bids
  WHERE load_id = v_load.id AND carrier_account_id = v_uid AND status = 'PENDING';
  IF FOUND THEN
    IF v_bid.bid_price <> p_bid_price OR v_bid.eta_pickup_at IS DISTINCT FROM p_eta_pickup_at THEN
      INSERT INTO public.freight_bid_history
        (bid_id, old_price, new_price, old_eta_pickup_at, new_eta_pickup_at, changed_by)
      VALUES
        (v_bid.id, v_bid.bid_price, p_bid_price, v_bid.eta_pickup_at, p_eta_pickup_at, v_uid);
    END IF;
    UPDATE public.freight_bids
    SET bid_price = p_bid_price,
        proposed_vehicle_id = p_proposed_vehicle_id,
        proposed_driver_id = p_proposed_driver_id,
        eta_pickup_at = p_eta_pickup_at,
        note = p_note,
        expires_at = v_expires
    WHERE id = v_bid.id
    RETURNING * INTO v_bid;
    RETURN v_bid;
  END IF;

  INSERT INTO public.freight_bids
    (load_id, carrier_account_id, bid_price, proposed_vehicle_id, proposed_driver_id,
     eta_pickup_at, note, expires_at)
  VALUES
    (v_load.id, v_uid, p_bid_price, p_proposed_vehicle_id, p_proposed_driver_id,
     p_eta_pickup_at, p_note, v_expires)
  RETURNING * INTO v_bid;
  RETURN v_bid;
END;
$$;

/**
 * Sửa bid của chính mình (chỉ khi PENDING và chưa hết hạn). Ghi
 * freight_bid_history nếu giá hoặc ETA thay đổi rồi mới cập nhật.
 */
CREATE OR REPLACE FUNCTION public.freight_acct_update_bid(
  p_bid_id uuid, p_bid_price numeric, p_proposed_vehicle_id uuid, p_proposed_driver_id uuid,
  p_eta_pickup_at timestamptz, p_note text, p_expires_at timestamptz
)
RETURNS public.freight_bids
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_bid public.freight_bids;
  v_load public.freight_loads;
BEGIN
  SELECT * INTO v_bid FROM public.freight_bids WHERE id = p_bid_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bid_not_found';
  END IF;
  IF v_bid.carrier_account_id <> v_uid THEN
    RAISE EXCEPTION 'not_bid_owner';
  END IF;
  IF v_bid.status <> 'PENDING' THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;
  IF v_bid.expires_at <= now() THEN
    UPDATE public.freight_bids SET status = 'EXPIRED', closed_reason = 'expired' WHERE id = v_bid.id;
    RAISE EXCEPTION 'bid_expired';
  END IF;
  SELECT * INTO v_load FROM public.freight_loads WHERE id = v_bid.load_id;
  IF v_load.status <> 'POSTED' THEN
    RAISE EXCEPTION 'load_not_open';
  END IF;
  IF p_bid_price IS NULL OR p_bid_price <= 0 THEN
    RAISE EXCEPTION 'invalid_price';
  END IF;
  IF p_proposed_vehicle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.freight_my_vehicles v
    WHERE v.id = p_proposed_vehicle_id AND v.account_id = v_uid
  ) THEN
    RAISE EXCEPTION 'vehicle_not_found';
  END IF;
  IF p_proposed_driver_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.freight_my_drivers d
    WHERE d.id = p_proposed_driver_id AND d.account_id = v_uid
  ) THEN
    RAISE EXCEPTION 'driver_not_found';
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'invalid_expiry';
  END IF;
  IF v_bid.bid_price <> p_bid_price OR v_bid.eta_pickup_at IS DISTINCT FROM p_eta_pickup_at THEN
    INSERT INTO public.freight_bid_history
      (bid_id, old_price, new_price, old_eta_pickup_at, new_eta_pickup_at, changed_by)
    VALUES
      (v_bid.id, v_bid.bid_price, p_bid_price, v_bid.eta_pickup_at, p_eta_pickup_at, v_uid);
  END IF;
  UPDATE public.freight_bids
  SET bid_price = p_bid_price,
      proposed_vehicle_id = p_proposed_vehicle_id,
      proposed_driver_id = p_proposed_driver_id,
      eta_pickup_at = p_eta_pickup_at,
      note = p_note,
      expires_at = COALESCE(p_expires_at, v_bid.expires_at)
  WHERE id = v_bid.id
  RETURNING * INTO v_bid;
  RETURN v_bid;
END;
$$;

/** Rút chào giá của chính mình (PENDING -> WITHDRAWN, không cần lý do). */
CREATE OR REPLACE FUNCTION public.freight_acct_withdraw_bid(p_bid_id uuid)
RETURNS public.freight_bids
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_bid public.freight_bids;
BEGIN
  SELECT * INTO v_bid FROM public.freight_bids WHERE id = p_bid_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bid_not_found';
  END IF;
  IF v_bid.carrier_account_id <> v_uid THEN
    RAISE EXCEPTION 'not_bid_owner';
  END IF;
  IF v_bid.status <> 'PENDING' THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;
  IF v_bid.expires_at <= now() THEN
    UPDATE public.freight_bids SET status = 'EXPIRED', closed_reason = 'expired' WHERE id = v_bid.id;
    RAISE EXCEPTION 'bid_expired';
  END IF;
  UPDATE public.freight_bids SET status = 'WITHDRAWN' WHERE id = v_bid.id
  RETURNING * INTO v_bid;
  RETURN v_bid;
END;
$$;

/** Chủ tải từ chối MỘT bid (PENDING -> REJECTED, lý do tuỳ chọn). */
CREATE OR REPLACE FUNCTION public.freight_acct_reject_bid(p_bid_id uuid, p_reason text)
RETURNS public.freight_bids
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_bid public.freight_bids;
  v_load public.freight_loads;
BEGIN
  SELECT * INTO v_bid FROM public.freight_bids WHERE id = p_bid_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bid_not_found';
  END IF;
  SELECT * INTO v_load FROM public.freight_loads WHERE id = v_bid.load_id;
  IF v_load.poster_account_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not_poster';
  END IF;
  IF v_bid.status <> 'PENDING' THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;
  IF v_bid.expires_at <= now() THEN
    UPDATE public.freight_bids SET status = 'EXPIRED', closed_reason = 'expired' WHERE id = v_bid.id;
    RAISE EXCEPTION 'bid_expired';
  END IF;
  UPDATE public.freight_bids
  SET status = 'REJECTED',
      closed_reason = COALESCE(NULLIF(btrim(p_reason), ''), 'rejected_by_shipper')
  WHERE id = v_bid.id
  RETURNING * INTO v_bid;
  RETURN v_bid;
END;
$$;

/**
 * Chấp nhận MỘT bid — NGUYÊN TỬ trong một transaction (thiết kế 3.3.1):
 * khoá bid + khoá tải, kiểm tra còn chốt được, tạo booking BOOKED với
 * giá đóng băng = giá bid và xe/tài xế dự kiến đã gán sẵn, bid thắng ->
 * ACCEPTED, các bid PENDING còn lại -> REJECTED (closed_reason='lost'),
 * tải -> BOOKED, ghi sự kiện, đồng bộ đơn cũ (lỗi đồng bộ không chặn).
 * accept_bid KHÔNG tạo liên kết PAST_DEAL — việc đó chỉ ở một chỗ duy
 * nhất: khi chuyến sang COMPLETED trong freight_acct_advance_booking.
 */
CREATE OR REPLACE FUNCTION public.freight_acct_accept_bid(p_bid_id uuid)
RETURNS public.freight_bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_bid public.freight_bids;
  v_load public.freight_loads;
  v_booking public.freight_bookings;
BEGIN
  -- 1. Khoá dòng bid.
  SELECT * INTO v_bid FROM public.freight_bids WHERE id = p_bid_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bid_not_found';
  END IF;
  -- 2. Khoá dòng tải; chỉ chủ tải mới chốt được bid cho tải của mình.
  SELECT * INTO v_load FROM public.freight_loads WHERE id = v_bid.load_id FOR UPDATE;
  IF v_load.poster_account_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'not_party';
  END IF;
  -- Hết hạn lười: đóng các bid quá hạn của tải (kể cả bid đang xét) rồi
  -- đọc lại trạng thái bid trước khi kiểm tra.
  PERFORM public.freight_acct_expire_bids(v_load.id);
  SELECT * INTO v_bid FROM public.freight_bids WHERE id = p_bid_id;
  -- 3. Kiểm tra còn chốt được không.
  IF v_bid.status = 'EXPIRED' THEN
    RAISE EXCEPTION 'bid_expired';
  END IF;
  IF v_bid.status <> 'PENDING' THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;
  IF v_load.status <> 'POSTED' THEN
    RAISE EXCEPTION 'load_not_open';
  END IF;
  -- 4. Tạo booking ở trạng thái BOOKED ngay, giá đóng băng theo bid.
  BEGIN
    INSERT INTO public.freight_bookings
      (code, load_id, order_id, shipper_group_id, carrier_group_id,
       shipper_account_id, carrier_account_id, bid_id, price_agreed,
       my_vehicle_id, my_driver_id, status)
    VALUES
      ('CH-' || lpad(nextval('public.freight_booking_code_seq')::text, 6, '0'),
       v_load.id, v_load.order_id, v_load.group_id, NULL,
       v_load.poster_account_id, v_bid.carrier_account_id, v_bid.id, v_bid.bid_price,
       v_bid.proposed_vehicle_id, v_bid.proposed_driver_id, 'BOOKED')
    RETURNING * INTO v_booking;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'already_booked';
  END;
  -- 5-7. Đóng bid thắng / bid thua / tải.
  UPDATE public.freight_bids SET status = 'ACCEPTED' WHERE id = v_bid.id;
  UPDATE public.freight_bids
  SET status = 'REJECTED', closed_reason = 'lost'
  WHERE load_id = v_load.id AND status = 'PENDING' AND id <> v_bid.id;
  UPDATE public.freight_loads SET status = 'BOOKED' WHERE id = v_load.id;
  -- 8-9. Sự kiện chuyến + đồng bộ ánh xạ sang đơn cũ (phụ trợ).
  PERFORM public.freight_add_event(
    v_booking.id, 'BOOKED', 'SHIPPER', NULL, 'BOOKED',
    'Chốt qua chào giá ' || v_bid.bid_price::text || ' ' || v_bid.currency, NULL, NULL
  );
  PERFORM public.freight_sync_order(v_load.order_id, v_booking.code, 'BOOKED');
  RETURN v_booking;
END;
$$;

GRANT EXECUTE ON FUNCTION public.freight_acct_place_bid(uuid, numeric, uuid, uuid, timestamptz, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_update_bid(uuid, numeric, uuid, uuid, timestamptz, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_withdraw_bid(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_reject_bid(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_accept_bid(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_expire_stale() TO authenticated;

-- Realtime cho các bảng giao dịch (guarded: đã có trong publication thì bỏ qua).
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE
    public.freight_loads, public.freight_bookings, public.freight_booking_events, public.freight_bids;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Khong them duoc bang freight vao publication supabase_realtime (%). Kiem tra thu cong neu can Realtime.', SQLERRM;
END;
$$;

-- =====================================================================
-- KIỂM CHỨNG SAU KHI ÁP (chạy tay trong SQL Editor):
--
-- 1) Các bảng/view freight_* đã tồn tại (kỳ vọng 12 bảng + 1 view,
--    gồm freight_bids + freight_bid_history của T2):
--    SELECT table_name, table_type FROM information_schema.tables
--    WHERE table_schema = 'public' AND table_name LIKE 'freight%'
--    ORDER BY table_name;
--
-- 2) RLS đã bật cho mọi bảng freight_:
--    SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname LIKE 'freight%' AND relkind = 'r' ORDER BY relname;
--
-- 3) RPC freight_acct_* đã có (12 RPC nghiệp vụ R1 + 6 RPC/helper T2:
--    place_bid, update_bid, withdraw_bid, reject_bid, accept_bid,
--    expire_stale — chưa kể các helper freight_acct_is_linked,
--    freight_acct_my_linked_ids, freight_acct_shares_group,
--    freight_acct_actor_side, freight_acct_load_visible_to,
--    freight_acct_can_see_bid, freight_acct_expire_bids):
--    SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND proname LIKE 'freight_acct%' ORDER BY proname;
--
-- 3b) Cột T2 đã có: freight_loads.open_for_bids + freight_bookings.bid_id:
--    SELECT table_name, column_name FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND (table_name, column_name) IN (('freight_loads','open_for_bids'),
--                                        ('freight_bookings','bid_id'));
--
-- 4) Thử luồng bằng 2 tài khoản test thật (khớp kịch bản nghiệm thu
--    trong huong-dan-reset-va-cai-lai-freight.md):
--    - Tài khoản A: mở app -> Tìm xe & chuyến -> đăng ký hồ sơ (chủ kho
--      + vận tải), thêm kho, thêm xe/tài xế.
--    - Tài khoản B: đăng ký hồ sơ vận tải; A và B kết nối (mời -> chấp
--      nhận) ở tab Kết nối.
--    - A đăng tải (PUBLIC hoặc NETWORK) -> B thấy ở "Tìm xe / Tải";
--      A chỉ định B -> B xác nhận -> BOOKED; B bấm các mốc tới DELIVERED;
--      A xác nhận hoàn thành -> COMPLETED. Nếu tải gắn order_id, kiểm
--      tra orders.status đã tiến tương ứng và order_events có dòng
--      type 'freight_status'.
--
-- ---------------------------------------------------------------------
-- ĐỐI CHIẾU CLIENT <-> MIGRATION (grep src/ tại thời điểm viết file):
--   Bảng/view client đọc-ghi qua PostgREST (freightAccount.ts,
--   freight.ts, features/freight/*):
--     freight_account_profiles  -> mục 2 + RLS mục 5          [CO]
--     freight_my_warehouses     -> mục 2 + RLS mục 5          [CO]
--     freight_my_vehicles       -> mục 2 + RLS mục 5          [CO]
--     freight_my_drivers        -> mục 2 + RLS mục 5          [CO]
--     freight_my_routes         -> mục 2 + RLS mục 5          [CO]
--     freight_account_links     -> mục 2 + RLS mục 5          [CO]
--     freight_loads             -> mục 3 + RLS mục 5          [CO]
--     freight_bookings          -> mục 3 + RLS mục 5          [CO]
--     freight_booking_events    -> mục 3 + RLS mục 5          [CO]
--     freight_load_groups       -> mục 3 + RLS mục 5          [CO]
--     freight_loads_discover    -> view mục 6 (có open_for_bids) [CO]
--     freight_bids              -> mục 8 + RLS mục 8 (T2)     [CO]
--     freight_bid_history       -> mục 8 + RLS mục 8 (T2)     [CO]
--   RPC client gọi (freightAccount.ts):
--     freight_acct_upsert_profile, freight_acct_invite_link,
--     freight_acct_respond_link, freight_acct_create_load,
--     freight_acct_cancel_load, freight_acct_share_load_to_group,
--     freight_acct_unshare_load, freight_acct_assign_booking,
--     freight_acct_respond_booking, freight_acct_assign_vehicle_driver,
--     freight_acct_advance_booking, freight_acct_cancel_booking
--       -> tất cả có ở mục 7 kèm GRANT EXECUTE.            [DU 12/12]
--     freight_acct_place_bid, freight_acct_update_bid,
--     freight_acct_withdraw_bid, freight_acct_reject_bid,
--     freight_acct_accept_bid, freight_acct_expire_stale
--       -> tất cả có ở mục 8 kèm GRANT EXECUTE.             [DU 6/6]
--   Client KHÔNG còn tham chiếu: freight_org_profiles,
--   freight_carrier_profiles, freight_warehouse_profiles,
--   freight_vehicles, freight_drivers, freight_service_routes,
--   freight_org_links, freight_loads_public và mọi RPC group
--   freight_* của T1 (freight_create_load, freight_assign_booking...)
--   -> các đối tượng đó KHÔNG được tạo trong bản sạch này.
--
-- ROLLBACK: chạy supabase/reset_freight.sql (xoá sạch freight_*, không
-- đụng dữ liệu app) — freight quay về trạng thái chưa cài.
-- =====================================================================
