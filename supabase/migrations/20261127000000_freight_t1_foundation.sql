-- =====================================================================
-- MIGRATION MỚI — Lớp trung gian giao tiếp Kho <-> Vận tải (Bản A, T0+T1)
-- Tên file: 20261127000000_freight_t1_foundation.sql
-- =====================================================================
-- Mục đích:
--   Nền dữ liệu T1 của "Lớp trung gian giao tiếp Kho <-> Vận tải" (Bản A):
--   hồ sơ tổ chức TỰ KHAI, hồ sơ kho, xe, tài xế, tuyến năng lực, kết nối
--   mạng lưới, tải đăng tìm xe (Load), chuyến đã chốt (Booking) theo hình
--   thức CHỈ ĐỊNH TRỰC TIẾP, và dòng sự kiện chuyến (append-only).
--   Thiết kế nguồn: ~/workspace/your_files/wms-nang-cap/
--     thiet-ke-lop-trung-gian-giao-tiep-v1.md (mục 2.2, 2.4, 2.6, 3.2, 3.3).
--
-- Triết lý Bản A — BẮT BUỘC giữ khi sửa file này:
--   * KHÔNG có xác thực/duyệt tổ chức, KHÔNG có trạng thái "chờ duyệt".
--   * Ngày hết hạn giấy tờ (đăng kiểm / bảo hiểm / bằng lái) chỉ là cột
--     thông tin tự khai để HIỂN THỊ. Không RPC nào trong file này đọc các
--     cột *_expires_at để chặn giao dịch.
--   * Chốt chuyến là xác nhận giữa HAI PHÍA; RPC chỉ bảo đảm toàn vẹn dữ
--     liệu (một load tối đa một booking đang sống, chuyển trạng thái đúng
--     máy trạng thái) — không có bước "sàn phê duyệt".
--
-- Ảnh hưởng: CHỈ tạo mới các đối tượng có tiền tố freight_ (bảng, view,
--   hàm, sequence, trigger). KHÔNG ALTER/DROP bất kỳ bảng sẵn có nào.
--   Bảng cũ chỉ bị ĐỌC (groups, group_members, orders) và — duy nhất ở
--   freight_sync_order — UPDATE orders.status theo ánh xạ một chiều của
--   Bản A mục 2.6 kèm INSERT order_events, trong khối EXCEPTION bảo vệ:
--   lỗi đồng bộ đơn cũ KHÔNG bao giờ chặn nghiệp vụ chuyến.
-- Client phụ thuộc: src/shared/supabase/freight.ts,
--   src/features/freight/*, src/domain/freight/* (máy trạng thái phía
--   client khớp 1-1 với freight_booking_transition_allowed trong file này).
--
-- ---------------------------------------------------------------------
-- GIẢ ĐỊNH VỀ SCHEMA CŨ (chưa export được schema thật — xem hướng dẫn
-- T0; nếu export cho kết quả khác, cần hiệu chỉnh các điểm đánh dấu [*]):
--   [*] groups(id uuid PK, name text, created_at timestamptz).
--   [*] group_members(group_id uuid, user_id uuid, roles text[]) —
--       client đọc cột `roles` dạng mảng (features/orders/GroupView.tsx,
--       types.ts Member{roles: string[]}); mã vai trò: 'admin',
--       'coordinator', 'operator', 'driver', 'viewer'.
--   [✓ ĐÃ ĐỐI CHIẾU export schema thật 2026-11-27] orders(id uuid PK,
--       group_id uuid, code text, goods text, status text,
--       assignee_id uuid NULL, issue_open boolean, created_by uuid,
--       created_at, updated_at, last_activity_at) với status thuộc vòng
--       đời CREATED/CONFIRMED/PICKING/IN_TRANSIT/DELIVERED/COMPLETED.
--       LƯU Ý: bảng orders KHÔNG có cột completed_at (completed_at chỉ
--       có ở orders_view, dạng tính toán) — khối đồng bộ bên dưới chỉ
--       UPDATE status/updated_at, tuyệt đối không set completed_at.
--   [✓ ĐÃ ĐỐI CHIẾU] order_events(id bigint PK, order_id uuid,
--       group_id uuid NOT NULL, actor_id uuid, type text,
--       from_status text, to_status text, note text, created_at) —
--       group_id là NOT NULL nên mọi INSERT phải kèm group_id của đơn.
--   [*] RPC complete_order(p_order uuid, p_note text) tồn tại — chỉ gọi
--       khi kiểm tra thấy có trong pg_proc, lỗi thì fallback UPDATE.
--   [*] auth.uid() dùng được trong RLS/RPC (Supabase Auth chuẩn).
--   Tên bảng trong tài liệu thiết kế (org_profiles, vehicles, bookings…)
--   được ánh xạ sang tiền tố freight_ để tránh đụng schema cũ:
--     org_profiles -> freight_org_profiles, warehouse_profiles ->
--     freight_warehouse_profiles, carrier_profiles ->
--     freight_carrier_profiles, vehicles -> freight_vehicles,
--     driver_profiles -> freight_drivers, service_lanes ->
--     freight_service_routes, org_links -> freight_org_links,
--     transport_loads -> freight_loads, bookings -> freight_bookings,
--     trip_events -> freight_booking_events.
--   "Nhà xe" trong lớp giao tiếp là một GROUP có org_type CARRIER/BOTH;
--   freight_bookings.carrier_group_id là phía nhà xe. Cột carrier_id
--   (nullable, tham chiếu mềm tới danh bạ carriers cũ) chỉ để dành cho
--   liên kết danh bạ ở giai đoạn sau — T1 chưa dùng.
-- ---------------------------------------------------------------------
-- Cách áp: Supabase Dashboard -> SQL Editor -> dán toàn bộ file -> Run.
-- Kiểm chứng sau áp + rollback: xem cuối file (khối comment).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. HÀM HỖ TRỢ (helper) — dùng trong RLS và RPC
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

/** auth.uid() có là thành viên của group không. */
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

/** auth.uid() có thuộc group với ít nhất một vai trò trong danh sách không. [*] phụ thuộc group_members.roles text[] */
CREATE OR REPLACE FUNCTION public.freight_group_has_role(p_group_id uuid, p_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.user_id = auth.uid()
      AND gm.roles && p_roles
  );
$$;

/** Tập group mà auth.uid() là thành viên (dùng trong view rút gọn). */
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
-- 2. BẢNG HỒ SƠ (tự khai — không có cột trạng thái xác thực/duyệt nào)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.freight_org_profiles (
  group_id uuid PRIMARY KEY,
  org_type text NOT NULL DEFAULT 'SHIPPER' CHECK (org_type IN ('SHIPPER', 'CARRIER', 'BOTH')),
  display_name text NOT NULL,
  legal_name text,
  tax_code text,
  contact_name text,
  contact_phone text,
  address text,
  province text,
  self_declared_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.freight_carrier_profiles (
  group_id uuid PRIMARY KEY,
  business_license_no text,
  capability_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.freight_warehouse_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_freight_warehouses_group ON public.freight_warehouse_profiles (group_id);

-- Xe: inspection_expires_at / insurance_expires_at là thông tin TỰ KHAI,
-- chỉ hiển thị kèm mốc ngày cho đối tác tự đánh giá (Bản A mục 3.5).
-- TUYỆT ĐỐI không dùng các cột này để chặn bất kỳ thao tác nào.
CREATE TABLE IF NOT EXISTS public.freight_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL,
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
  UNIQUE (group_id, plate)
);
CREATE INDEX IF NOT EXISTS idx_freight_vehicles_group ON public.freight_vehicles (group_id);

-- Tài xế: license_expires_at cũng chỉ là thông tin tự khai để hiển thị.
CREATE TABLE IF NOT EXISTS public.freight_drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL,
  user_id uuid,
  full_name text NOT NULL,
  phone text,
  license_class text,
  license_expires_at date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freight_drivers_group ON public.freight_drivers (group_id);

CREATE TABLE IF NOT EXISTS public.freight_service_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL,
  from_province text NOT NULL,
  to_province text NOT NULL,
  vehicle_type text,
  ref_price numeric,
  note text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freight_routes_group ON public.freight_service_routes (group_id);

-- Kết nối mạng lưới (mức hiển thị NETWORK): hai phía TỰ kết nối với nhau
-- (một phía mời -> PENDING, phía kia chấp nhận -> ACCEPTED). Đây là đồng ý
-- hai bên, không phải duyệt của sàn. PAST_DEAL dành cho giai đoạn sau.
CREATE TABLE IF NOT EXISTS public.freight_org_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipper_group_id uuid NOT NULL,
  carrier_group_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'PAST_DEAL')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'ENDED')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shipper_group_id, carrier_group_id),
  CHECK (shipper_group_id <> carrier_group_id)
);
CREATE INDEX IF NOT EXISTS idx_freight_links_shipper ON public.freight_org_links (shipper_group_id);
CREATE INDEX IF NOT EXISTS idx_freight_links_carrier ON public.freight_org_links (carrier_group_id);

-- ---------------------------------------------------------------------
-- 3. BẢNG GIAO DỊCH: LOAD, BOOKING, SỰ KIỆN CHUYẾN
-- ---------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.freight_load_code_seq;
CREATE SEQUENCE IF NOT EXISTS public.freight_booking_code_seq;

CREATE TABLE IF NOT EXISTS public.freight_loads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  group_id uuid NOT NULL,
  order_id uuid,
  shipment_code text,
  goods_desc text NOT NULL,
  weight_kg numeric,
  packages int,
  volume_m3 numeric,
  vehicle_type_required text,
  pickup_warehouse_id uuid,
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
  asking_price numeric,
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT', 'POSTED', 'ASSIGNED', 'BOOKED', 'EXPIRED', 'CANCELLED')),
  expires_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freight_loads_group ON public.freight_loads (group_id);
CREATE INDEX IF NOT EXISTS idx_freight_loads_status ON public.freight_loads (status, visibility);
CREATE INDEX IF NOT EXISTS idx_freight_loads_order ON public.freight_loads (order_id);

CREATE TABLE IF NOT EXISTS public.freight_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  load_id uuid NOT NULL REFERENCES public.freight_loads (id),
  order_id uuid,
  shipper_group_id uuid NOT NULL,
  carrier_group_id uuid NOT NULL,
  carrier_id uuid,
  bid_id uuid,
  vehicle_id uuid REFERENCES public.freight_vehicles (id) ON DELETE SET NULL,
  driver_id uuid REFERENCES public.freight_drivers (id) ON DELETE SET NULL,
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

-- Trigger updated_at cho các bảng có cột updated_at.
DROP TRIGGER IF EXISTS trg_freight_org_profiles_touch ON public.freight_org_profiles;
CREATE TRIGGER trg_freight_org_profiles_touch BEFORE UPDATE ON public.freight_org_profiles
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();
DROP TRIGGER IF EXISTS trg_freight_carrier_profiles_touch ON public.freight_carrier_profiles;
CREATE TRIGGER trg_freight_carrier_profiles_touch BEFORE UPDATE ON public.freight_carrier_profiles
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();
DROP TRIGGER IF EXISTS trg_freight_warehouses_touch ON public.freight_warehouse_profiles;
CREATE TRIGGER trg_freight_warehouses_touch BEFORE UPDATE ON public.freight_warehouse_profiles
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();
DROP TRIGGER IF EXISTS trg_freight_vehicles_touch ON public.freight_vehicles;
CREATE TRIGGER trg_freight_vehicles_touch BEFORE UPDATE ON public.freight_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();
DROP TRIGGER IF EXISTS trg_freight_drivers_touch ON public.freight_drivers;
CREATE TRIGGER trg_freight_drivers_touch BEFORE UPDATE ON public.freight_drivers
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();
DROP TRIGGER IF EXISTS trg_freight_loads_touch ON public.freight_loads;
CREATE TRIGGER trg_freight_loads_touch BEFORE UPDATE ON public.freight_loads
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();
DROP TRIGGER IF EXISTS trg_freight_bookings_touch ON public.freight_bookings;
CREATE TRIGGER trg_freight_bookings_touch BEFORE UPDATE ON public.freight_bookings
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();
DROP TRIGGER IF EXISTS trg_freight_links_touch ON public.freight_org_links;
CREATE TRIGGER trg_freight_links_touch BEFORE UPDATE ON public.freight_org_links
  FOR EACH ROW EXECUTE FUNCTION public.freight_touch_updated_at();

-- T0: nhóm hiện có mặc định là phía chủ hàng (SHIPPER) — người dùng tự đổi
-- loại cho nhóm nhà xe của mình trong app (tự khai, không duyệt). [*]
DO $$
BEGIN
  INSERT INTO public.freight_org_profiles (group_id, org_type, display_name)
  SELECT g.id, 'SHIPPER', g.name FROM public.groups g
  ON CONFLICT (group_id) DO NOTHING;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Bo qua buoc tao ho so mac dinh cho groups hien co: %', SQLERRM;
END;
$$;

-- ---------------------------------------------------------------------
-- 4. RLS — đọc theo quan hệ giao dịch; ghi nhạy cảm chỉ qua RPC.
-- Vai trò làm việc trong nhóm: admin/coordinator/operator (+driver cho
-- mốc chuyến, kiểm tra trong RPC advance_booking).
-- ---------------------------------------------------------------------

ALTER TABLE public.freight_org_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_carrier_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_warehouse_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_service_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_org_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_booking_events ENABLE ROW LEVEL SECURITY;

-- Hồ sơ tổ chức: mọi người dùng ĐÃ ĐĂNG NHẬP đọc được (thư mục đối tác,
-- cùng khuôn carriers sau đăng nhập). Ghi chỉ qua RPC upsert.
DROP POLICY IF EXISTS freight_org_profiles_select ON public.freight_org_profiles;
CREATE POLICY freight_org_profiles_select ON public.freight_org_profiles
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS freight_carrier_profiles_select ON public.freight_carrier_profiles;
CREATE POLICY freight_carrier_profiles_select ON public.freight_carrier_profiles
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- Hồ sơ kho: nhóm sở hữu đọc/ghi; phía nhà xe có booking gắn với load lấy
-- tại kho này thì đọc được (để biết điểm lấy sau khi đã chốt).
DROP POLICY IF EXISTS freight_warehouses_select ON public.freight_warehouse_profiles;
CREATE POLICY freight_warehouses_select ON public.freight_warehouse_profiles
  FOR SELECT TO authenticated USING (
    public.freight_is_group_member(group_id)
    OR EXISTS (
      SELECT 1 FROM public.freight_loads l
      JOIN public.freight_bookings b ON b.load_id = l.id
      WHERE l.pickup_warehouse_id = freight_warehouse_profiles.id
        AND public.freight_is_group_member(b.carrier_group_id)
    )
  );
DROP POLICY IF EXISTS freight_warehouses_insert ON public.freight_warehouse_profiles;
CREATE POLICY freight_warehouses_insert ON public.freight_warehouse_profiles
  FOR INSERT TO authenticated WITH CHECK (
    public.freight_group_has_role(group_id, ARRAY['admin', 'coordinator', 'operator'])
  );
DROP POLICY IF EXISTS freight_warehouses_update ON public.freight_warehouse_profiles;
CREATE POLICY freight_warehouses_update ON public.freight_warehouse_profiles
  FOR UPDATE TO authenticated
  USING (public.freight_group_has_role(group_id, ARRAY['admin', 'coordinator', 'operator']))
  WITH CHECK (public.freight_group_has_role(group_id, ARRAY['admin', 'coordinator', 'operator']));
DROP POLICY IF EXISTS freight_warehouses_delete ON public.freight_warehouse_profiles;
CREATE POLICY freight_warehouses_delete ON public.freight_warehouse_profiles
  FOR DELETE TO authenticated USING (public.freight_group_has_role(group_id, ARRAY['admin']));

-- Xe / tài xế: nhóm sở hữu đọc/ghi; chủ hàng của booking đã gán xe/tài xế
-- này đọc được (thông tin hiển thị cho phía đối tác sau khi chốt).
DROP POLICY IF EXISTS freight_vehicles_select ON public.freight_vehicles;
CREATE POLICY freight_vehicles_select ON public.freight_vehicles
  FOR SELECT TO authenticated USING (
    public.freight_is_group_member(group_id)
    OR EXISTS (
      SELECT 1 FROM public.freight_bookings b
      WHERE b.vehicle_id = freight_vehicles.id
        AND public.freight_is_group_member(b.shipper_group_id)
    )
  );
DROP POLICY IF EXISTS freight_vehicles_insert ON public.freight_vehicles;
CREATE POLICY freight_vehicles_insert ON public.freight_vehicles
  FOR INSERT TO authenticated WITH CHECK (
    public.freight_group_has_role(group_id, ARRAY['admin', 'coordinator', 'operator'])
  );
DROP POLICY IF EXISTS freight_vehicles_update ON public.freight_vehicles;
CREATE POLICY freight_vehicles_update ON public.freight_vehicles
  FOR UPDATE TO authenticated
  USING (public.freight_group_has_role(group_id, ARRAY['admin', 'coordinator', 'operator']))
  WITH CHECK (public.freight_group_has_role(group_id, ARRAY['admin', 'coordinator', 'operator']));
DROP POLICY IF EXISTS freight_vehicles_delete ON public.freight_vehicles;
CREATE POLICY freight_vehicles_delete ON public.freight_vehicles
  FOR DELETE TO authenticated USING (public.freight_group_has_role(group_id, ARRAY['admin']));

DROP POLICY IF EXISTS freight_drivers_select ON public.freight_drivers;
CREATE POLICY freight_drivers_select ON public.freight_drivers
  FOR SELECT TO authenticated USING (
    public.freight_is_group_member(group_id)
    OR EXISTS (
      SELECT 1 FROM public.freight_bookings b
      WHERE b.driver_id = freight_drivers.id
        AND public.freight_is_group_member(b.shipper_group_id)
    )
  );
DROP POLICY IF EXISTS freight_drivers_insert ON public.freight_drivers;
CREATE POLICY freight_drivers_insert ON public.freight_drivers
  FOR INSERT TO authenticated WITH CHECK (
    public.freight_group_has_role(group_id, ARRAY['admin', 'coordinator', 'operator'])
  );
DROP POLICY IF EXISTS freight_drivers_update ON public.freight_drivers;
CREATE POLICY freight_drivers_update ON public.freight_drivers
  FOR UPDATE TO authenticated
  USING (public.freight_group_has_role(group_id, ARRAY['admin', 'coordinator', 'operator']))
  WITH CHECK (public.freight_group_has_role(group_id, ARRAY['admin', 'coordinator', 'operator']));
DROP POLICY IF EXISTS freight_drivers_delete ON public.freight_drivers;
CREATE POLICY freight_drivers_delete ON public.freight_drivers
  FOR DELETE TO authenticated USING (public.freight_group_has_role(group_id, ARRAY['admin']));

-- Tuyến năng lực: thông tin nhà xe TỰ CÔNG BỐ — mọi người đã đăng nhập đọc
-- được (như carriers_public); ghi chỉ nhóm sở hữu.
DROP POLICY IF EXISTS freight_routes_select ON public.freight_service_routes;
CREATE POLICY freight_routes_select ON public.freight_service_routes
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS freight_routes_insert ON public.freight_service_routes;
CREATE POLICY freight_routes_insert ON public.freight_service_routes
  FOR INSERT TO authenticated WITH CHECK (
    public.freight_group_has_role(group_id, ARRAY['admin', 'coordinator', 'operator'])
  );
DROP POLICY IF EXISTS freight_routes_update ON public.freight_service_routes;
CREATE POLICY freight_routes_update ON public.freight_service_routes
  FOR UPDATE TO authenticated
  USING (public.freight_group_has_role(group_id, ARRAY['admin', 'coordinator', 'operator']))
  WITH CHECK (public.freight_group_has_role(group_id, ARRAY['admin', 'coordinator', 'operator']));
DROP POLICY IF EXISTS freight_routes_delete ON public.freight_service_routes;
CREATE POLICY freight_routes_delete ON public.freight_service_routes
  FOR DELETE TO authenticated USING (public.freight_group_has_role(group_id, ARRAY['admin']));

-- Kết nối mạng lưới: thành viên một trong hai phía đọc được; tạo mới ở
-- trạng thái PENDING bởi thành viên một trong hai phía; cập nhật (chấp
-- nhận/kết thúc) bởi thành viên một trong hai phía.
DROP POLICY IF EXISTS freight_links_select ON public.freight_org_links;
CREATE POLICY freight_links_select ON public.freight_org_links
  FOR SELECT TO authenticated USING (
    public.freight_is_group_member(shipper_group_id) OR public.freight_is_group_member(carrier_group_id)
  );
DROP POLICY IF EXISTS freight_links_insert ON public.freight_org_links;
CREATE POLICY freight_links_insert ON public.freight_org_links
  FOR INSERT TO authenticated WITH CHECK (
    status = 'PENDING'
    AND (public.freight_is_group_member(shipper_group_id) OR public.freight_is_group_member(carrier_group_id))
  );
DROP POLICY IF EXISTS freight_links_update ON public.freight_org_links;
CREATE POLICY freight_links_update ON public.freight_org_links
  FOR UPDATE TO authenticated
  USING (public.freight_is_group_member(shipper_group_id) OR public.freight_is_group_member(carrier_group_id))
  WITH CHECK (public.freight_is_group_member(shipper_group_id) OR public.freight_is_group_member(carrier_group_id));

-- Load: nhóm chủ hàng đọc đủ; các phía của một booking trên load đọc đủ.
-- Nhà xe chưa có booking chỉ thấy bản rút gọn qua view freight_loads_public.
-- Ghi chỉ qua RPC.
DROP POLICY IF EXISTS freight_loads_select ON public.freight_loads;
CREATE POLICY freight_loads_select ON public.freight_loads
  FOR SELECT TO authenticated USING (
    public.freight_is_group_member(group_id)
    OR EXISTS (
      SELECT 1 FROM public.freight_bookings b
      WHERE b.load_id = freight_loads.id
        AND (public.freight_is_group_member(b.shipper_group_id) OR public.freight_is_group_member(b.carrier_group_id))
    )
  );

-- Booking: hai phía giao dịch đọc được. Ghi chỉ qua RPC.
DROP POLICY IF EXISTS freight_bookings_select ON public.freight_bookings;
CREATE POLICY freight_bookings_select ON public.freight_bookings
  FOR SELECT TO authenticated USING (
    public.freight_is_group_member(shipper_group_id) OR public.freight_is_group_member(carrier_group_id)
  );

-- Sự kiện: hai phía của booking đọc được; append-only (không policy ghi).
DROP POLICY IF EXISTS freight_events_select ON public.freight_booking_events;
CREATE POLICY freight_events_select ON public.freight_booking_events
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.freight_bookings b
      WHERE b.id = freight_booking_events.booking_id
        AND (public.freight_is_group_member(b.shipper_group_id) OR public.freight_is_group_member(b.carrier_group_id))
    )
  );

-- View rút gọn cho nhà xe duyệt tải TRƯỚC khi chốt (Bản A mục 2.4): chỉ
-- tỉnh/thành, loại hàng, khoảng khối lượng/kiện, cửa sổ giờ, giá mong muốn.
-- KHÔNG có địa chỉ chi tiết, SĐT, tên kho. View chạy với quyền owner
-- (bỏ qua RLS bảng gốc) như carriers_public hiện tại — điều kiện lọc nằm
-- trong WHERE: PUBLIC ai đăng nhập cũng thấy; NETWORK chỉ tổ chức đã kết
-- nối ACCEPTED với chủ hàng; DIRECT chỉ tổ chức được chỉ định; chủ hàng
-- luôn thấy tải của mình.
CREATE OR REPLACE VIEW public.freight_loads_public AS
SELECT
  l.id,
  l.code,
  l.group_id AS shipper_group_id,
  op.display_name AS shipper_display_name,
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
  l.created_at
FROM public.freight_loads l
LEFT JOIN public.freight_org_profiles op ON op.group_id = l.group_id
WHERE l.status = 'POSTED'
  AND (
    public.freight_is_group_member(l.group_id)
    OR l.visibility = 'PUBLIC'
    OR (l.visibility = 'DIRECT' AND l.directed_group_id IN (SELECT public.freight_my_group_ids()))
    OR (l.visibility = 'NETWORK' AND EXISTS (
      SELECT 1 FROM public.freight_org_links lk
      WHERE lk.status = 'ACCEPTED'
        AND lk.shipper_group_id = l.group_id
        AND lk.carrier_group_id IN (SELECT public.freight_my_group_ids())
    ))
  );

-- Grants (RLS vẫn là cổng thật; RPC SECURITY DEFINER không cần grant ghi).
GRANT SELECT ON public.freight_org_profiles, public.freight_carrier_profiles TO authenticated;
GRANT SELECT ON public.freight_loads, public.freight_bookings, public.freight_booking_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.freight_warehouse_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.freight_vehicles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.freight_drivers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.freight_service_routes TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.freight_org_links TO authenticated;
GRANT SELECT ON public.freight_loads_public TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_is_group_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_group_has_role(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_my_group_ids() TO authenticated;

-- ---------------------------------------------------------------------
-- 5. HÀM NỘI BỘ + RPC (cổng ghi nhạy cảm — SECURITY DEFINER)
-- Mã lỗi là chuỗi cấu trúc, client map sang tiếng Việt
-- (src/shared/supabase/freight.ts): not_authenticated, not_member,
-- forbidden, not_party, invalid_transition, note_required,
-- reason_required, load_not_found, load_not_open, booking_not_found,
-- carrier_not_found, not_carrier_org, invalid_org_type,
-- invalid_visibility, directed_required, not_linked, order_not_in_group,
-- warehouse_not_found, vehicle_not_found, driver_not_found,
-- has_active_booking, already_booked.
-- ---------------------------------------------------------------------

/** Phía của người gọi đối với một chuyến: SHIPPER / CARRIER / DRIVER / NULL. */
CREATE OR REPLACE FUNCTION public.freight_actor_side(p_shipper_group uuid, p_carrier_group uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.freight_is_group_member(p_shipper_group) THEN
    RETURN 'SHIPPER';
  END IF;
  IF public.freight_is_group_member(p_carrier_group) THEN
    IF public.freight_group_has_role(p_carrier_group, ARRAY['driver'])
       AND NOT public.freight_group_has_role(p_carrier_group, ARRAY['admin', 'coordinator', 'operator']) THEN
      RETURN 'DRIVER';
    END IF;
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
 * tiến). [*] Giả định orders/order_events/complete_order như ghi ở đầu
 * file. Toàn bộ khối nằm trong EXCEPTION: đồng bộ là PHỤ TRỢ — lỗi ở đây
 * không bao giờ được chặn nghiệp vụ chuyến (sự kiện freight là nguồn sự
 * thật của lớp giao tiếp).
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
        -- orders KHÔNG có completed_at (đã đối chiếu schema thật
        -- 2026-11-27) — chỉ set status + updated_at.
        UPDATE public.orders SET status = 'COMPLETED', updated_at = now()
        WHERE id = p_order_id AND status = v_cur;
      END;
    ELSE
      UPDATE public.orders SET status = v_target, updated_at = now() WHERE id = p_order_id AND status = v_cur;
      IF FOUND THEN
        -- order_events.group_id là NOT NULL trong schema thật.
        INSERT INTO public.order_events (order_id, group_id, actor_id, type, from_status, to_status, note)
        VALUES (p_order_id, v_group, auth.uid(), 'freight_status', v_cur, v_target, 'Đồng bộ từ chuyến ' || p_booking_code);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

-- ----- Hồ sơ tổ chức (tự khai) -----

CREATE OR REPLACE FUNCTION public.freight_upsert_org_profile(
  p_group_id uuid, p_org_type text, p_display_name text, p_legal_name text,
  p_tax_code text, p_contact_name text, p_contact_phone text, p_address text, p_province text
)
RETURNS public.freight_org_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.freight_org_profiles;
BEGIN
  PERFORM public.freight_require_uid();
  IF NOT public.freight_is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'not_member';
  END IF;
  IF NOT public.freight_group_has_role(p_group_id, ARRAY['admin', 'coordinator']) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_org_type NOT IN ('SHIPPER', 'CARRIER', 'BOTH') THEN
    RAISE EXCEPTION 'invalid_org_type';
  END IF;
  IF COALESCE(btrim(p_display_name), '') = '' THEN
    RAISE EXCEPTION 'note_required';
  END IF;
  INSERT INTO public.freight_org_profiles
    (group_id, org_type, display_name, legal_name, tax_code, contact_name, contact_phone, address, province)
  VALUES
    (p_group_id, p_org_type, btrim(p_display_name), p_legal_name, p_tax_code, p_contact_name, p_contact_phone, p_address, p_province)
  ON CONFLICT (group_id) DO UPDATE SET
    org_type = EXCLUDED.org_type,
    display_name = EXCLUDED.display_name,
    legal_name = EXCLUDED.legal_name,
    tax_code = EXCLUDED.tax_code,
    contact_name = EXCLUDED.contact_name,
    contact_phone = EXCLUDED.contact_phone,
    address = EXCLUDED.address,
    province = EXCLUDED.province
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.freight_upsert_carrier_profile(
  p_group_id uuid, p_business_license_no text, p_capability_note text
)
RETURNS public.freight_carrier_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.freight_carrier_profiles;
BEGIN
  PERFORM public.freight_require_uid();
  IF NOT public.freight_is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'not_member';
  END IF;
  IF NOT public.freight_group_has_role(p_group_id, ARRAY['admin', 'coordinator']) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.freight_org_profiles op
    WHERE op.group_id = p_group_id AND op.org_type IN ('CARRIER', 'BOTH')
  ) THEN
    RAISE EXCEPTION 'not_carrier_org';
  END IF;
  INSERT INTO public.freight_carrier_profiles (group_id, business_license_no, capability_note)
  VALUES (p_group_id, p_business_license_no, p_capability_note)
  ON CONFLICT (group_id) DO UPDATE SET
    business_license_no = EXCLUDED.business_license_no,
    capability_note = EXCLUDED.capability_note
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- ----- Tải đăng tìm xe -----

CREATE OR REPLACE FUNCTION public.freight_create_load(
  p_group_id uuid, p_order_id uuid, p_shipment_code text, p_goods_desc text,
  p_weight_kg numeric, p_packages int, p_volume_m3 numeric, p_vehicle_type_required text,
  p_pickup_warehouse_id uuid, p_pickup_address text, p_pickup_province text,
  p_delivery_address text, p_delivery_province text,
  p_delivery_contact_name text, p_delivery_contact_phone text,
  p_pickup_window_from timestamptz, p_pickup_window_to timestamptz, p_delivery_window_to timestamptz,
  p_visibility text, p_directed_group_id uuid, p_asking_price numeric, p_expires_at timestamptz
)
RETURNS public.freight_loads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.freight_loads;
BEGIN
  PERFORM public.freight_require_uid();
  IF NOT public.freight_is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'not_member';
  END IF;
  IF NOT public.freight_group_has_role(p_group_id, ARRAY['admin', 'coordinator', 'operator']) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF COALESCE(btrim(p_goods_desc), '') = '' THEN
    RAISE EXCEPTION 'note_required';
  END IF;
  IF p_visibility NOT IN ('DIRECT', 'NETWORK', 'PUBLIC') THEN
    RAISE EXCEPTION 'invalid_visibility';
  END IF;
  IF p_visibility = 'DIRECT' AND p_directed_group_id IS NULL THEN
    RAISE EXCEPTION 'directed_required';
  END IF;
  IF p_order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.orders o WHERE o.id = p_order_id AND o.group_id = p_group_id
  ) THEN
    RAISE EXCEPTION 'order_not_in_group';
  END IF;
  IF p_pickup_warehouse_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.freight_warehouse_profiles w
    WHERE w.id = p_pickup_warehouse_id AND w.group_id = p_group_id
  ) THEN
    RAISE EXCEPTION 'warehouse_not_found';
  END IF;
  INSERT INTO public.freight_loads (
    code, group_id, order_id, shipment_code, goods_desc, weight_kg, packages, volume_m3,
    vehicle_type_required, pickup_warehouse_id, pickup_address, pickup_province,
    delivery_address, delivery_province, delivery_contact_name, delivery_contact_phone,
    pickup_window_from, pickup_window_to, delivery_window_to,
    visibility, directed_group_id, asking_price, status, expires_at, created_by
  ) VALUES (
    'TAI-' || lpad(nextval('public.freight_load_code_seq')::text, 6, '0'),
    p_group_id, p_order_id, p_shipment_code, btrim(p_goods_desc), p_weight_kg, p_packages, p_volume_m3,
    p_vehicle_type_required, p_pickup_warehouse_id, p_pickup_address, p_pickup_province,
    p_delivery_address, p_delivery_province, p_delivery_contact_name, p_delivery_contact_phone,
    p_pickup_window_from, p_pickup_window_to, p_delivery_window_to,
    p_visibility, p_directed_group_id, p_asking_price, 'POSTED', p_expires_at, auth.uid()
  )
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.freight_cancel_load(p_load_id uuid, p_reason text)
RETURNS public.freight_loads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_load public.freight_loads;
  v_booking public.freight_bookings;
  v_row public.freight_loads;
BEGIN
  PERFORM public.freight_require_uid();
  SELECT * INTO v_load FROM public.freight_loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'load_not_found';
  END IF;
  IF NOT public.freight_is_group_member(v_load.group_id) THEN
    RAISE EXCEPTION 'not_member';
  END IF;
  IF NOT public.freight_group_has_role(v_load.group_id, ARRAY['admin', 'coordinator', 'operator']) THEN
    RAISE EXCEPTION 'forbidden';
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

-- ----- Chốt chuyến bằng chỉ định trực tiếp (T1) -----

CREATE OR REPLACE FUNCTION public.freight_assign_booking(
  p_load_id uuid, p_carrier_group_id uuid, p_price_agreed numeric
)
RETURNS public.freight_bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_load public.freight_loads;
  v_booking public.freight_bookings;
BEGIN
  PERFORM public.freight_require_uid();
  SELECT * INTO v_load FROM public.freight_loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'load_not_found';
  END IF;
  IF NOT public.freight_is_group_member(v_load.group_id) THEN
    RAISE EXCEPTION 'not_member';
  END IF;
  IF NOT public.freight_group_has_role(v_load.group_id, ARRAY['admin', 'coordinator', 'operator']) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_carrier_group_id = v_load.group_id THEN
    RAISE EXCEPTION 'not_carrier_org';
  END IF;
  IF v_load.status <> 'POSTED' THEN
    RAISE EXCEPTION 'load_not_open';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.freight_org_profiles op
    WHERE op.group_id = p_carrier_group_id AND op.org_type IN ('CARRIER', 'BOTH')
  ) THEN
    RAISE EXCEPTION 'carrier_not_found';
  END IF;
  IF v_load.visibility = 'DIRECT' AND v_load.directed_group_id IS DISTINCT FROM p_carrier_group_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_load.visibility = 'NETWORK'
     AND v_load.directed_group_id IS DISTINCT FROM p_carrier_group_id
     AND NOT EXISTS (
       SELECT 1 FROM public.freight_org_links lk
       WHERE lk.status = 'ACCEPTED' AND lk.shipper_group_id = v_load.group_id
         AND lk.carrier_group_id = p_carrier_group_id
     ) THEN
    RAISE EXCEPTION 'not_linked';
  END IF;
  BEGIN
    INSERT INTO public.freight_bookings
      (code, load_id, order_id, shipper_group_id, carrier_group_id, price_agreed, status)
    VALUES
      ('CH-' || lpad(nextval('public.freight_booking_code_seq')::text, 6, '0'),
       v_load.id, v_load.order_id, v_load.group_id, p_carrier_group_id,
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

CREATE OR REPLACE FUNCTION public.freight_respond_booking(
  p_booking_id uuid, p_accept boolean, p_note text
)
RETURNS public.freight_bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_b public.freight_bookings;
  v_row public.freight_bookings;
BEGIN
  PERFORM public.freight_require_uid();
  SELECT * INTO v_b FROM public.freight_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_not_found';
  END IF;
  IF NOT public.freight_is_group_member(v_b.carrier_group_id) THEN
    RAISE EXCEPTION 'not_member';
  END IF;
  IF NOT public.freight_group_has_role(v_b.carrier_group_id, ARRAY['admin', 'coordinator', 'operator']) THEN
    RAISE EXCEPTION 'forbidden';
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

CREATE OR REPLACE FUNCTION public.freight_assign_vehicle_driver(
  p_booking_id uuid, p_vehicle_id uuid, p_driver_id uuid
)
RETURNS public.freight_bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_b public.freight_bookings;
  v_row public.freight_bookings;
BEGIN
  PERFORM public.freight_require_uid();
  SELECT * INTO v_b FROM public.freight_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_not_found';
  END IF;
  IF NOT public.freight_is_group_member(v_b.carrier_group_id) THEN
    RAISE EXCEPTION 'not_member';
  END IF;
  IF NOT public.freight_group_has_role(v_b.carrier_group_id, ARRAY['admin', 'coordinator', 'operator']) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_b.status NOT IN ('BOOKED', 'ARRIVED_PICKUP') THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;
  IF p_vehicle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.freight_vehicles v
    WHERE v.id = p_vehicle_id AND v.group_id = v_b.carrier_group_id
  ) THEN
    RAISE EXCEPTION 'vehicle_not_found';
  END IF;
  IF p_driver_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.freight_drivers d
    WHERE d.id = p_driver_id AND d.group_id = v_b.carrier_group_id
  ) THEN
    RAISE EXCEPTION 'driver_not_found';
  END IF;
  -- LƯU Ý BẢN A (cố ý, không phải thiếu sót): RPC này KHÔNG kiểm tra
  -- inspection_expires_at / insurance_expires_at của xe và
  -- license_expires_at của tài xế. Hạn giấy tờ là thông tin tự khai chỉ
  -- để hiển thị cho đối tác tự đánh giá; tính hợp lệ là cam kết của
  -- chính nhà xe. Cơ chế chặn theo hạn giấy tờ là khoản nợ NT-02 (Bản B).
  UPDATE public.freight_bookings
  SET vehicle_id = COALESCE(p_vehicle_id, vehicle_id),
      driver_id = COALESCE(p_driver_id, driver_id)
  WHERE id = v_b.id
  RETURNING * INTO v_row;
  PERFORM public.freight_add_event(v_b.id, 'VEHICLE_DRIVER_ASSIGNED', 'CARRIER', v_b.status, v_b.status, NULL, NULL, NULL);
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.freight_advance_booking(
  p_booking_id uuid, p_to_status text, p_note text, p_lat double precision, p_lng double precision
)
RETURNS public.freight_bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_b public.freight_bookings;
  v_row public.freight_bookings;
  v_side text;
BEGIN
  PERFORM public.freight_require_uid();
  SELECT * INTO v_b FROM public.freight_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_not_found';
  END IF;
  v_side := public.freight_actor_side(v_b.shipper_group_id, v_b.carrier_group_id);
  IF v_side IS NULL THEN
    RAISE EXCEPTION 'not_party';
  END IF;
  IF v_side = 'SHIPPER' THEN
    IF NOT public.freight_group_has_role(v_b.shipper_group_id, ARRAY['admin', 'coordinator', 'operator']) THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
  ELSE
    IF NOT public.freight_group_has_role(v_b.carrier_group_id, ARRAY['admin', 'coordinator', 'operator', 'driver']) THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
  END IF;
  IF p_to_status = 'CANCELLED' AND COALESCE(btrim(p_note), '') = '' THEN
    RAISE EXCEPTION 'reason_required';
  END IF;
  IF NOT public.freight_booking_transition_allowed(v_b.status, p_to_status, v_side) THEN
    RAISE EXCEPTION 'invalid_transition';
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
    -- Chuyến huỷ trước khi lấy hàng -> tải mở lại cho chủ hàng tìm xe khác.
    UPDATE public.freight_loads SET status = 'POSTED'
    WHERE id = v_b.load_id AND status IN ('ASSIGNED', 'BOOKED');
  END IF;
  PERFORM public.freight_add_event(v_b.id, p_to_status, v_side, v_b.status, p_to_status, p_note, p_lat, p_lng);
  PERFORM public.freight_sync_order(v_b.order_id, v_b.code, p_to_status);
  RETURN v_row;
END;
$$;

/** Huỷ chuyến (bắt buộc lý do) — vỏ mỏng trên advance_booking. */
CREATE OR REPLACE FUNCTION public.freight_cancel_booking(p_booking_id uuid, p_reason text)
RETURNS public.freight_bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'reason_required';
  END IF;
  RETURN public.freight_advance_booking(p_booking_id, 'CANCELLED', p_reason, NULL, NULL);
END;
$$;

GRANT EXECUTE ON FUNCTION public.freight_upsert_org_profile(uuid, text, text, text, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_upsert_carrier_profile(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_create_load(uuid, uuid, text, text, numeric, int, numeric, text, uuid, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz, text, uuid, numeric, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_cancel_load(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_assign_booking(uuid, uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_respond_booking(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_assign_vehicle_driver(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_advance_booking(uuid, text, text, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_cancel_booking(uuid, text) TO authenticated;

-- Realtime cho các bảng giao dịch (guarded: đã có trong publication thì bỏ qua).
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE
    public.freight_loads, public.freight_bookings, public.freight_booking_events;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Khong them duoc bang freight vao publication supabase_realtime (%). Kiem tra thu cong neu can Realtime.', SQLERRM;
END;
$$;

-- =====================================================================
-- KIỂM CHỨNG SAU KHI ÁP (chạy tay trong SQL Editor, không bắt buộc):
--
-- 1) Các bảng/view freight_* đã tồn tại:
--    SELECT table_name, table_type FROM information_schema.tables
--    WHERE table_schema = 'public' AND table_name LIKE 'freight%'
--    ORDER BY table_name;
--
-- 2) RLS đã bật cho mọi bảng freight_:
--    SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname LIKE 'freight%' AND relkind = 'r' ORDER BY relname;
--
-- 3) RPC đã có:
--    SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND proname LIKE 'freight%' ORDER BY proname;
--
-- 4) Thử luồng bằng 2 tài khoản test (1 nhóm chủ hàng, 1 nhóm nhà xe):
--    - Tài khoản nhà xe: gọi freight_upsert_org_profile với org_type
--      'CARRIER' cho group của mình.
--    - Tài khoản chủ hàng: freight_create_load (...) -> lấy id load;
--      freight_assign_booking(load_id, group_nha_xe, gia) -> booking
--      PENDING_CONFIRM.
--    - Tài khoản nhà xe: freight_respond_booking(booking_id, true, null)
--      -> BOOKED; freight_advance_booking lần lượt ARRIVED_PICKUP,
--      PICKED_UP, IN_TRANSIT, ARRIVED_DELIVERY, DELIVERED.
--    - Tài khoản chủ hàng: freight_advance_booking(..., 'COMPLETED', ...)
--      -> COMPLETED; nếu load gắn order_id, kiểm tra orders.status đã
--      tiến tương ứng và order_events có dòng type 'freight_status'.
--
-- ROLLBACK (an toàn — chỉ xoá đối tượng freight_* do file này tạo):
--    DROP VIEW IF EXISTS public.freight_loads_public;
--    DROP TABLE IF EXISTS public.freight_booking_events,
--      public.freight_bookings, public.freight_loads, public.freight_org_links,
--      public.freight_service_routes, public.freight_drivers,
--      public.freight_vehicles, public.freight_warehouse_profiles,
--      public.freight_carrier_profiles, public.freight_org_profiles CASCADE;
--    DROP FUNCTION IF EXISTS public.freight_cancel_booking(uuid, text),
--      public.freight_advance_booking(uuid, text, text, double precision, double precision),
--      public.freight_assign_vehicle_driver(uuid, uuid, uuid),
--      public.freight_respond_booking(uuid, boolean, text),
--      public.freight_assign_booking(uuid, uuid, numeric),
--      public.freight_cancel_load(uuid, text),
--      public.freight_create_load(uuid, uuid, text, text, numeric, int, numeric, text, uuid, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz, text, uuid, numeric, timestamptz),
--      public.freight_upsert_carrier_profile(uuid, text, text),
--      public.freight_upsert_org_profile(uuid, text, text, text, text, text, text, text, text),
--      public.freight_sync_order(uuid, text, text),
--      public.freight_add_event(uuid, text, text, text, text, text, double precision, double precision),
--      public.freight_actor_side(uuid, uuid),
--      public.freight_booking_transition_allowed(text, text, text),
--      public.freight_order_rank(text),
--      public.freight_my_group_ids(),
--      public.freight_group_has_role(uuid, text[]),
--      public.freight_is_group_member(uuid),
--      public.freight_require_uid(),
--      public.freight_touch_updated_at();
--    DROP SEQUENCE IF EXISTS public.freight_load_code_seq, public.freight_booking_code_seq;
-- =====================================================================
