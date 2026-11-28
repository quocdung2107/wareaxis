-- =====================================================================
-- MIGRATION R1 — Lớp trung gian giao tiếp: MÔ HÌNH DANH TÍNH THEO TÀI KHOẢN
-- Tên file: 20261128000000_freight_r1_account_model.sql
-- Thiết kế nguồn: ~/workspace/your_files/wms-nang-cap/
--   thiet-ke-lai-tai-khoan-va-t2-chao-gia.md (Phần 1 + Phụ lục A đã chốt).
-- =====================================================================
-- Mục đích:
--   Chuyển quyền sở hữu của lớp giao tiếp từ GROUP sang TÀI KHOẢN
--   (auth.users): mỗi tài khoản có MỘT hồ sơ đăng ký riêng
--   (freight_account_profiles, hai cờ độc lập is_shipper / is_carrier),
--   kho/xe/tài xế/tuyến thuộc tài khoản (freight_my_*), kết nối giữa hai
--   TÀI KHOẢN (freight_account_links), tải/chuyến lấy tài khoản làm hai
--   phía giao dịch. GROUP hạ xuống đúng vai trò KHÔNG GIAN TRAO ĐỔI:
--   chỉ còn là nguồn tạo tải từ đơn (group_id/order_id = tham chiếu
--   nguồn tuỳ chọn) và nơi chủ tải chủ động chia sẻ tải vào
--   (freight_load_groups). Xoá group KHÔNG xoá được hồ sơ/tải/chuyến
--   của tài khoản — không bảng mới nào có FK tới groups.
--
-- Triết lý Bản A — giữ nguyên như T1:
--   * Không xác thực/duyệt hồ sơ, không trạng thái chờ duyệt.
--   * Ngày hết hạn giấy tờ (đăng kiểm/bảo hiểm/bằng lái) chỉ để HIỂN THỊ.
--     Không RPC nào trong file này đọc *_expires_at để chặn giao dịch
--     (xem ghi chú NT-02 trong freight_acct_assign_vehicle_driver).
--   * RPC chỉ bảo đảm toàn vẹn dữ liệu (một load tối đa một booking
--     đang sống — unique index của T1 giữ nguyên; chuyển trạng thái
--     đúng máy trạng thái T1 dùng lại nguyên vẹn), không có "sàn duyệt".
--
-- Điều kiện tiên quyết: migration T1
--   (20261127000000_freight_t1_foundation.sql) ĐÃ ÁP và đang chạy thật.
--
-- Ảnh hưởng (KHÔNG phá hoại):
--   * Tạo MỚI: 7 bảng (freight_account_profiles, freight_my_warehouses,
--     freight_my_vehicles, freight_my_drivers, freight_my_routes,
--     freight_account_links, freight_load_groups), 1 view
--     (freight_loads_discover), helper freight_acct_* và RPC
--     freight_acct_* chạy SONG SONG với RPC group cũ của T1.
--   * ALTER duy nhất trên bảng cũ:
--       - freight_loads / freight_bookings: ADD COLUMN (nullable).
--       - freight_loads.group_id, freight_bookings.shipper_group_id /
--         carrier_group_id: DROP NOT NULL — NỚI LỎNG ràng buộc (không
--         sửa một byte dữ liệu nào): ở mô hình tài khoản, group chỉ là
--         tham chiếu nguồn tuỳ chọn nên tải/chuyến tạo độc lập (không
--         qua group) phải để các cột này NULL được. RPC group cũ của T1
--         luôn ghi đầy đủ các cột này nên client cũ không bị ảnh hưởng.
--   * Di trú dữ liệu (mục 7): chỉ ĐỌC bảng group cũ và SAO CHÉP sang
--     bảng mới (ghi vết legacy_source_id). Bảng cũ không bị sửa/xoá
--     một dòng nào — rollback phía client = quay về bản deploy trước,
--     dữ liệu T1 vẫn nguyên vẹn (xem khối ROLLBACK cuối file).
--   * Đối tượng group cũ của T1 chỉ bị COMMENT đánh dấu DEPRECATED
--     (mục 8). KHÔNG DROP bất kỳ đối tượng cũ nào.
--
-- Giả định (đã đối chiếu schema thật 2026-11-27, cùng T1):
--   groups(id, name, created_by, ...), group_members(group_id, user_id,
--   roles text[]), orders / orders_view, profiles(id, display_name),
--   complete_order(p_order, p_note) tồn tại. auth.uid() dùng được.
--   Di trú gán chủ mặc định = groups.created_by (điểm đã chốt 6).
--
-- Cách áp: Supabase Dashboard -> SQL Editor -> dán toàn bộ file -> Run.
-- Sau khi chạy ĐỌC KỸ các RAISE NOTICE của mục 7 (di trú) và chạy khối
-- KIỂM CHỨNG ở cuối file. Hướng dẫn chi tiết:
--   ~/workspace/your_files/wms-nang-cap/huong-dan-r1-di-tru-tai-khoan.md
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. HELPER THEO TÀI KHOẢN
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

-- ---------------------------------------------------------------------
-- 2. BẢNG MỚI THEO TÀI KHOẢN
-- Mọi bảng sở hữu đều FK về auth.users ON DELETE CASCADE (xoá TÀI KHOẢN
-- thì dữ liệu của tài khoản đi theo — đúng nghĩa sở hữu). Không bảng nào
-- có FK tới groups: xoá group không chạm được vào dữ liệu tài khoản.
-- ---------------------------------------------------------------------

-- Một tài khoản = MỘT dòng đăng ký duy nhất; hai vai trò là hai cờ độc
-- lập (vừa chủ kho vừa vận tải được — điểm đã chốt 1).
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
  legacy_source_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freight_my_warehouses_account ON public.freight_my_warehouses (account_id);

-- inspection_expires_at / insurance_expires_at: TỰ KHAI, chỉ hiển thị
-- (như T1) — không dùng để chặn bất kỳ thao tác nào.
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
  legacy_source_id uuid,
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
  legacy_source_id uuid,
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
  legacy_source_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freight_my_routes_account ON public.freight_my_routes (account_id);

-- Kết nối giữa hai TÀI KHOẢN: một phía mời (PENDING) -> phía kia chấp
-- nhận (ACCEPTED) -> một phía kết thúc (ENDED). Đồng ý hai bên giữa hai
-- tài khoản, không phải duyệt của sàn (điểm đã chốt 2a).
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

-- Trigger updated_at (dùng lại hàm của T1).
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

-- ---------------------------------------------------------------------
-- 3. THÊM CỘT VÀO BẢNG GIAO DỊCH HIỆN CÓ (nullable — dữ liệu cũ nguyên)
-- ---------------------------------------------------------------------

ALTER TABLE public.freight_loads
  ADD COLUMN IF NOT EXISTS poster_account_id uuid,
  ADD COLUMN IF NOT EXISTS directed_account_id uuid,
  ADD COLUMN IF NOT EXISTS pickup_point_id uuid;
CREATE INDEX IF NOT EXISTS idx_freight_loads_poster ON public.freight_loads (poster_account_id);
CREATE INDEX IF NOT EXISTS idx_freight_loads_directed ON public.freight_loads (directed_account_id);
-- group_id từ "chủ sở hữu" hạ xuống "tham chiếu nguồn tuỳ chọn": tải tạo
-- độc lập (không qua group) để NULL. Nới lỏng, không sửa dữ liệu.
ALTER TABLE public.freight_loads ALTER COLUMN group_id DROP NOT NULL;

ALTER TABLE public.freight_bookings
  ADD COLUMN IF NOT EXISTS shipper_account_id uuid,
  ADD COLUMN IF NOT EXISTS carrier_account_id uuid,
  ADD COLUMN IF NOT EXISTS my_vehicle_id uuid REFERENCES public.freight_my_vehicles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS my_driver_id uuid REFERENCES public.freight_my_drivers (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_freight_bookings_shipper_acct ON public.freight_bookings (shipper_account_id);
CREATE INDEX IF NOT EXISTS idx_freight_bookings_carrier_acct ON public.freight_bookings (carrier_account_id);
-- Hai cột group của booking cũng hạ xuống tham chiếu nguồn (nhà xe là
-- tài khoản độc lập, có thể không có group nào chung với chủ hàng).
ALTER TABLE public.freight_bookings ALTER COLUMN shipper_group_id DROP NOT NULL;
ALTER TABLE public.freight_bookings ALTER COLUMN carrier_group_id DROP NOT NULL;

-- ---------------------------------------------------------------------
-- 4. RLS CHO BẢNG MỚI + POLICY BỔ SUNG THEO TÀI KHOẢN
-- Nguyên tắc như T1: đọc theo quan hệ, ghi nhạy cảm qua RPC, ghi danh
-- mục của chính mình qua RLS. Policy T1 trên loads/bookings/events GIỮ
-- NGUYÊN (policy mới cộng thêm bằng OR, không thay thế).
-- ---------------------------------------------------------------------

ALTER TABLE public.freight_account_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_my_warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_my_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_my_drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_my_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_account_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.freight_load_groups ENABLE ROW LEVEL SECURITY;

-- Hồ sơ tài khoản: mọi người đã đăng nhập đọc được (thư mục đối tác —
-- cùng khuôn freight_org_profiles của T1; thông tin tự khai để hai bên
-- liên lạc, luôn hiển thị kèm nhãn tự khai phía client). Ghi chỉ qua
-- RPC freight_acct_upsert_profile — không mở policy ghi trực tiếp.
DROP POLICY IF EXISTS freight_account_profiles_select ON public.freight_account_profiles;
CREATE POLICY freight_account_profiles_select ON public.freight_account_profiles
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- Kho của tôi: chủ sở hữu đọc/ghi; nhà xe có booking ĐANG SỐNG gắn với
-- load lấy hàng tại kho này đọc được (biết điểm lấy sau khi chốt).
DROP POLICY IF EXISTS freight_my_warehouses_select ON public.freight_my_warehouses;
CREATE POLICY freight_my_warehouses_select ON public.freight_my_warehouses
  FOR SELECT TO authenticated USING (
    account_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.freight_loads l
      JOIN public.freight_bookings b ON b.load_id = l.id
      WHERE l.pickup_point_id = freight_my_warehouses.id
        AND b.carrier_account_id = auth.uid()
        AND b.status NOT IN ('CANCELLED', 'DECLINED')
    )
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

-- Xe / tài xế của tôi: chủ sở hữu đọc/ghi; chủ hàng của booking đã gán
-- xe/tài xế này đọc được (hiển thị cho đối tác sau khi chốt).
DROP POLICY IF EXISTS freight_my_vehicles_select ON public.freight_my_vehicles;
CREATE POLICY freight_my_vehicles_select ON public.freight_my_vehicles
  FOR SELECT TO authenticated USING (
    account_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.freight_bookings b
      WHERE b.my_vehicle_id = freight_my_vehicles.id AND b.shipper_account_id = auth.uid()
    )
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

DROP POLICY IF EXISTS freight_my_drivers_select ON public.freight_my_drivers;
CREATE POLICY freight_my_drivers_select ON public.freight_my_drivers
  FOR SELECT TO authenticated USING (
    account_id = auth.uid()
    OR user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.freight_bookings b
      WHERE b.my_driver_id = freight_my_drivers.id AND b.shipper_account_id = auth.uid()
    )
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

-- Chia sẻ tải vào group: chủ tải và thành viên group đích đọc được.
-- Ghi chỉ qua RPC share/unshare.
DROP POLICY IF EXISTS freight_load_groups_select ON public.freight_load_groups;
CREATE POLICY freight_load_groups_select ON public.freight_load_groups
  FOR SELECT TO authenticated USING (
    shared_by = auth.uid() OR public.freight_is_group_member(group_id)
  );

-- Policy BỔ SUNG theo tài khoản cho loads / bookings / events.
DROP POLICY IF EXISTS freight_loads_select_acct ON public.freight_loads;
CREATE POLICY freight_loads_select_acct ON public.freight_loads
  FOR SELECT TO authenticated USING (
    poster_account_id = auth.uid()
    OR directed_account_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.freight_bookings b
      WHERE b.load_id = freight_loads.id
        AND (b.shipper_account_id = auth.uid() OR b.carrier_account_id = auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.freight_load_groups lg
      WHERE lg.load_id = freight_loads.id AND public.freight_is_group_member(lg.group_id)
    )
  );

DROP POLICY IF EXISTS freight_bookings_select_acct ON public.freight_bookings;
CREATE POLICY freight_bookings_select_acct ON public.freight_bookings
  FOR SELECT TO authenticated USING (
    shipper_account_id = auth.uid()
    OR carrier_account_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.freight_my_drivers d
      WHERE d.user_id = auth.uid() AND d.account_id = freight_bookings.carrier_account_id AND d.active
    )
  );

DROP POLICY IF EXISTS freight_events_select_acct ON public.freight_booking_events;
CREATE POLICY freight_events_select_acct ON public.freight_booking_events
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.freight_bookings b
      WHERE b.id = freight_booking_events.booking_id
        AND (b.shipper_account_id = auth.uid() OR b.carrier_account_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.freight_my_drivers d
            WHERE d.user_id = auth.uid() AND d.account_id = b.carrier_account_id AND d.active
          ))
    )
  );

GRANT SELECT ON public.freight_account_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.freight_my_warehouses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.freight_my_vehicles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.freight_my_drivers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.freight_my_routes TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.freight_account_links TO authenticated;
GRANT SELECT ON public.freight_load_groups TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_is_linked(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_actor_side(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_my_linked_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.freight_acct_shares_group(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 5. VIEW TRA CỨU MỚI freight_loads_discover (bản rút gọn theo tài khoản)
-- Chỉ tỉnh đi/đến, loại hàng, khối lượng/kiện, cửa sổ giờ, giá mong
-- muốn — KHÔNG địa chỉ chi tiết/SĐT (như view T1). Điều kiện thấy:
--   - tải của chính mình;
--   - PUBLIC: mọi tài khoản đã đăng nhập (giữ như T1 — điểm chốt 7);
--   - DIRECT: đúng tài khoản được chỉ định;
--   - NETWORK: đã kết nối ACCEPTED với chủ tải, HOẶC cùng thuộc một
--     group trao đổi với chủ tải (điểm chốt 2b — group là nơi gặp nhau);
--   - tải được chủ tải chia sẻ vào một group mà mình là thành viên.
-- View freight_loads_public của T1 giữ nguyên cho client cũ.
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
  l.created_at
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
-- 6. RPC MỚI freight_acct_* (SECURITY DEFINER — chạy song song RPC cũ)
-- Mã lỗi cấu trúc, client map sang tiếng Việt
-- (src/shared/supabase/freightAccount.ts). Mã mới của R1: invalid_role,
-- not_party, not_poster, not_carrier, account_not_found, already_linked,
-- link_not_found, cannot_link_self. Mã của T1 giữ nguyên ngữ nghĩa.
-- Máy trạng thái freight_booking_transition_allowed của T1 DÙNG LẠI
-- nguyên vẹn; freight_add_event và freight_sync_order cũng dùng lại.
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
  p_visibility text, p_directed_account_id uuid, p_asking_price numeric, p_expires_at timestamptz
)
RETURNS public.freight_loads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.freight_require_uid();
  v_group uuid := p_source_group_id;
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
    visibility, directed_account_id, asking_price, status, expires_at, created_by,
    poster_account_id
  ) VALUES (
    'TAI-' || lpad(nextval('public.freight_load_code_seq')::text, 6, '0'),
    v_group, p_order_id, p_shipment_code, btrim(p_goods_desc), p_weight_kg, p_packages, p_volume_m3,
    p_vehicle_type_required, p_pickup_point_id, p_pickup_address, p_pickup_province,
    p_delivery_address, p_delivery_province, p_delivery_contact_name, p_delivery_contact_phone,
    p_pickup_window_from, p_pickup_window_to, p_delivery_window_to,
    p_visibility, p_directed_account_id, p_asking_price, 'POSTED', p_expires_at, v_uid,
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
  -- Tự chỉ định CHÍNH MÌNH được phép (tự vận chuyển bằng đội xe riêng —
  -- điểm đã chốt 5): không có guard carrier <> poster ở đây.
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
    -- ENDED -> mời lại bằng cách cập nhật dòng cũ (như reinviteLink của T1).
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
    -- cho danh sách sạch (quyết định đã ghi trong thiết kế 1.6.2).
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
GRANT EXECUTE ON FUNCTION public.freight_acct_create_load(uuid, uuid, text, text, numeric, int, numeric, text, uuid, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz, text, uuid, numeric, timestamptz) TO authenticated;
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
-- 7. DI TRÚ DỮ LIỆU T1 -> MÔ HÌNH TÀI KHOẢN
-- Quy tắc gán chủ (điểm đã chốt 6): chủ của tài sản thuộc một group =
-- groups.created_by của group đó. Mỗi bước bọc EXCEPTION + RAISE NOTICE
-- (đếm trước/sau) để một bước lỗi không làm hỏng phần cấu trúc — nhưng
-- PHẢI đọc NOTICE sau khi chạy (hướng dẫn đi kèm). Bảng cũ chỉ bị ĐỌC;
-- sao chép ghi vết legacy_source_id để truy nguồn và map khoá.
-- ---------------------------------------------------------------------

-- 7.0 Kiểm tra trước: group có dữ liệu freight nhưng thiếu created_by.
DO $$
DECLARE
  v_cnt int;
BEGIN
  SELECT COUNT(*) INTO v_cnt
  FROM public.groups g
  WHERE g.created_by IS NULL
    AND (EXISTS (SELECT 1 FROM public.freight_org_profiles op WHERE op.group_id = g.id)
      OR EXISTS (SELECT 1 FROM public.freight_warehouse_profiles w WHERE w.group_id = g.id)
      OR EXISTS (SELECT 1 FROM public.freight_vehicles v WHERE v.group_id = g.id)
      OR EXISTS (SELECT 1 FROM public.freight_drivers d WHERE d.group_id = g.id)
      OR EXISTS (SELECT 1 FROM public.freight_service_routes r WHERE r.group_id = g.id));
  RAISE NOTICE 'R1 di tru: % group co du lieu freight nhung groups.created_by NULL — du lieu cua cac group nay se KHONG duoc di tru tu dong (xu ly tay theo huong dan).', v_cnt;
END;
$$;

-- 7.1 Hồ sơ tổ chức -> hồ sơ tài khoản (hợp nhất: một người tạo cả group
-- kho lẫn group đội xe thì hai dòng hợp nhất thành MỘT hồ sơ; hai cờ vai
-- trò OR lại, trường văn bản giữ của dòng chèn trước — hồ sơ cũ nhất).
DO $$
DECLARE
  v_before int;
  v_after int;
BEGIN
  SELECT COUNT(DISTINCT g.created_by) INTO v_before
  FROM public.freight_org_profiles op JOIN public.groups g ON g.id = op.group_id
  WHERE g.created_by IS NOT NULL;
  RAISE NOTICE 'R1 di tru 7.1: so tai khoan phan biet co ho so org cu = % (ky vong so dong freight_account_profiles sau di tru).', v_before;

  -- GỘP trước khi chèn: một tài khoản có thể có nhiều dòng org (nhiều
  -- group) — INSERT ... ON CONFLICT DO UPDATE sẽ lỗi "cannot affect
  -- row a second time" nếu tập nguồn chứa hai dòng cùng khoá. first_row
  -- lấy trường văn bản của hồ sơ cũ nhất; agg OR hai cờ vai trò và lấy
  -- phần vận tải từ dòng nào có khai.
  INSERT INTO public.freight_account_profiles
    (account_id, display_name, legal_name, tax_code, contact_name, contact_phone,
     address, province, is_shipper, is_carrier, business_license_no, capability_note,
     self_declared_at)
  SELECT f.account_id, f.display_name, f.legal_name, f.tax_code, f.contact_name,
         f.contact_phone, f.address, f.province,
         a.is_shipper, a.is_carrier, a.business_license_no, a.capability_note,
         f.self_declared_at
  FROM (
    SELECT DISTINCT ON (g.created_by)
           g.created_by AS account_id, op.display_name, op.legal_name, op.tax_code,
           op.contact_name, op.contact_phone, op.address, op.province, op.self_declared_at
    FROM public.freight_org_profiles op
    JOIN public.groups g ON g.id = op.group_id
    WHERE g.created_by IS NOT NULL
    ORDER BY g.created_by, op.created_at
  ) f
  JOIN (
    SELECT g.created_by AS account_id,
           BOOL_OR(op.org_type IN ('SHIPPER', 'BOTH')) AS is_shipper,
           BOOL_OR(op.org_type IN ('CARRIER', 'BOTH')) AS is_carrier,
           (ARRAY_AGG(cp.business_license_no) FILTER (WHERE cp.business_license_no IS NOT NULL))[1] AS business_license_no,
           (ARRAY_AGG(cp.capability_note) FILTER (WHERE cp.capability_note IS NOT NULL))[1] AS capability_note
    FROM public.freight_org_profiles op
    JOIN public.groups g ON g.id = op.group_id
    LEFT JOIN public.freight_carrier_profiles cp ON cp.group_id = op.group_id
    WHERE g.created_by IS NOT NULL
    GROUP BY g.created_by
  ) a ON a.account_id = f.account_id
  ON CONFLICT (account_id) DO UPDATE SET
    is_shipper = public.freight_account_profiles.is_shipper OR EXCLUDED.is_shipper,
    is_carrier = public.freight_account_profiles.is_carrier OR EXCLUDED.is_carrier,
    business_license_no = COALESCE(public.freight_account_profiles.business_license_no, EXCLUDED.business_license_no),
    capability_note = COALESCE(public.freight_account_profiles.capability_note, EXCLUDED.capability_note);

  SELECT COUNT(*) INTO v_after FROM public.freight_account_profiles;
  RAISE NOTICE 'R1 di tru 7.1: freight_account_profiles sau di tru = % dong.', v_after;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'R1 di tru 7.1 LOI (ho so tai khoan chua di tru duoc): %', SQLERRM;
END;
$$;

-- 7.2 Kho / xe / tài xế / tuyến: sao chép theo group -> created_by của
-- group, ghi legacy_source_id = id dòng cũ. Bỏ qua dòng đã có vết
-- (chạy lại migration không nhân đôi).
DO $$
DECLARE
  v_n int;
BEGIN
  INSERT INTO public.freight_my_warehouses
    (account_id, name, address, province, lat, lng, open_hours, dock_count,
     arrival_requirements, contact_name, contact_phone, active, legacy_source_id)
  SELECT g.created_by, w.name, w.address, w.province, w.lat, w.lng, w.open_hours,
         w.dock_count, w.arrival_requirements, w.contact_name, w.contact_phone,
         w.active, w.id
  FROM public.freight_warehouse_profiles w
  JOIN public.groups g ON g.id = w.group_id
  WHERE g.created_by IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.freight_my_warehouses mw WHERE mw.legacy_source_id = w.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'R1 di tru 7.2: da sao chep % kho (freight_my_warehouses).', v_n;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'R1 di tru 7.2 (kho) LOI: %', SQLERRM;
END;
$$;

DO $$
DECLARE
  v_n int;
BEGIN
  -- Trùng biển số khi hợp nhất nhiều group về một tài khoản: dòng trùng
  -- bị bỏ qua (ON CONFLICT DO NOTHING) — dòng cũ vẫn còn nguyên ở bảng
  -- cũ; kiểm chứng 7.2(c) ở cuối file liệt kê các dòng này.
  INSERT INTO public.freight_my_vehicles
    (account_id, plate, vehicle_type, payload_kg, box_length_m, box_width_m,
     box_height_m, photo_path, inspection_expires_at, insurance_expires_at,
     active, legacy_source_id)
  SELECT g.created_by, v.plate, v.vehicle_type, v.payload_kg, v.box_length_m,
         v.box_width_m, v.box_height_m, v.photo_path, v.inspection_expires_at,
         v.insurance_expires_at, v.active, v.id
  FROM public.freight_vehicles v
  JOIN public.groups g ON g.id = v.group_id
  WHERE g.created_by IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.freight_my_vehicles mv WHERE mv.legacy_source_id = v.id)
  ON CONFLICT (account_id, plate) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'R1 di tru 7.2: da sao chep % xe (freight_my_vehicles).', v_n;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'R1 di tru 7.2 (xe) LOI: %', SQLERRM;
END;
$$;

DO $$
DECLARE
  v_n int;
BEGIN
  INSERT INTO public.freight_my_drivers
    (account_id, user_id, full_name, phone, license_class, license_expires_at,
     active, legacy_source_id)
  SELECT g.created_by, d.user_id, d.full_name, d.phone, d.license_class,
         d.license_expires_at, d.active, d.id
  FROM public.freight_drivers d
  JOIN public.groups g ON g.id = d.group_id
  WHERE g.created_by IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.freight_my_drivers md WHERE md.legacy_source_id = d.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'R1 di tru 7.2: da sao chep % tai xe (freight_my_drivers).', v_n;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'R1 di tru 7.2 (tai xe) LOI: %', SQLERRM;
END;
$$;

DO $$
DECLARE
  v_n int;
BEGIN
  INSERT INTO public.freight_my_routes
    (account_id, from_province, to_province, vehicle_type, ref_price, note,
     active, legacy_source_id)
  SELECT g.created_by, r.from_province, r.to_province, r.vehicle_type,
         r.ref_price, r.note, r.active, r.id
  FROM public.freight_service_routes r
  JOIN public.groups g ON g.id = r.group_id
  WHERE g.created_by IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.freight_my_routes mr WHERE mr.legacy_source_id = r.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'R1 di tru 7.2: da sao chep % tuyen (freight_my_routes).', v_n;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'R1 di tru 7.2 (tuyen) LOI: %', SQLERRM;
END;
$$;

-- 7.3 Kết nối group -> kết nối tài khoản. Hai đầu dịch qua created_by
-- của group tương ứng; bỏ qua dòng hai đầu dịch ra cùng một tài khoản.
-- Chiều mời: theo org_links.created_by thuộc group nào; không rõ thì
-- phía chủ hàng là requester.
DO $$
DECLARE
  v_n int;
BEGIN
  -- Dịch hai đầu sang tài khoản trong subquery t, rồi DISTINCT ON theo
  -- cặp chuẩn hoá (nhiều org_links có thể dịch về cùng một cặp tài
  -- khoản — tránh lỗi "cannot affect row a second time" của ON
  -- CONFLICT DO UPDATE); ưu tiên dòng ACCEPTED, rồi dòng cũ nhất.
  INSERT INTO public.freight_account_links
    (requester_account_id, addressee_account_id, source, status, created_by, created_at)
  SELECT t.requester_account_id, t.addressee_account_id, t.source, t.status,
         t.created_by, t.created_at
  FROM (
    SELECT DISTINCT ON (LEAST(x.req, x.addr), GREATEST(x.req, x.addr))
           x.req AS requester_account_id, x.addr AS addressee_account_id,
           x.source, x.status, x.created_by, x.created_at
    FROM (
      SELECT
        CASE
          WHEN EXISTS (SELECT 1 FROM public.group_members gm
                       WHERE gm.group_id = lk.carrier_group_id AND gm.user_id = lk.created_by)
            THEN gc.created_by
          ELSE gs.created_by
        END AS req,
        CASE
          WHEN EXISTS (SELECT 1 FROM public.group_members gm
                       WHERE gm.group_id = lk.carrier_group_id AND gm.user_id = lk.created_by)
            THEN gs.created_by
          ELSE gc.created_by
        END AS addr,
        lk.source, lk.status, lk.created_by, lk.created_at
      FROM public.freight_org_links lk
      JOIN public.groups gs ON gs.id = lk.shipper_group_id
      JOIN public.groups gc ON gc.id = lk.carrier_group_id
      WHERE gs.created_by IS NOT NULL AND gc.created_by IS NOT NULL
        AND gs.created_by <> gc.created_by
    ) x
    ORDER BY LEAST(x.req, x.addr), GREATEST(x.req, x.addr),
             (x.status = 'ACCEPTED') DESC, x.created_at
  ) t
  ON CONFLICT (LEAST(requester_account_id, addressee_account_id),
               GREATEST(requester_account_id, addressee_account_id))
  DO UPDATE SET status = CASE
    WHEN public.freight_account_links.status = 'ACCEPTED' OR EXCLUDED.status = 'ACCEPTED'
      THEN 'ACCEPTED'
    ELSE public.freight_account_links.status
  END;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'R1 di tru 7.3: da xu ly % ket noi (freight_account_links).', v_n;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'R1 di tru 7.3 LOI: %', SQLERRM;
END;
$$;

-- 7.4 Tải: poster = người trực tiếp tạo tải (created_by đã có ở T1),
-- fallback chủ group. directed/pickup_point map theo quy tắc thiết kế.
DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.freight_loads l
  SET poster_account_id = COALESCE(l.created_by, g.created_by)
  FROM public.groups g
  WHERE g.id = l.group_id AND l.poster_account_id IS NULL AND g.created_by IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'R1 di tru 7.4: da gan poster_account_id cho % tai (qua group).', v_n;

  UPDATE public.freight_loads l
  SET poster_account_id = l.created_by
  WHERE l.poster_account_id IS NULL AND l.created_by IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'R1 di tru 7.4: da gan poster_account_id cho % tai (fallback created_by, group khong co created_by).', v_n;

  UPDATE public.freight_loads l
  SET directed_account_id = g.created_by
  FROM public.groups g
  WHERE g.id = l.directed_group_id AND l.directed_account_id IS NULL AND g.created_by IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'R1 di tru 7.4: da gan directed_account_id cho % tai.', v_n;

  UPDATE public.freight_loads l
  SET pickup_point_id = mw.id
  FROM public.freight_my_warehouses mw
  WHERE mw.legacy_source_id = l.pickup_warehouse_id
    AND mw.account_id = l.poster_account_id
    AND l.pickup_point_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'R1 di tru 7.4: da map pickup_point_id cho % tai.', v_n;

  SELECT COUNT(*) INTO v_n FROM public.freight_loads WHERE poster_account_id IS NULL;
  RAISE NOTICE 'R1 di tru 7.4: con % tai CHUA co poster_account_id (ky vong 0 — neu > 0, xem huong dan xu ly tay).', v_n;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'R1 di tru 7.4 LOI: %', SQLERRM;
END;
$$;

-- 7.5 Chuyến: shipper = poster của load (nguồn nhất quán nhất);
-- carrier = created_by của carrier group; xe/tài xế map qua
-- legacy_source_id, chỉ nhận dòng thuộc chính carrier vừa dịch.
DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.freight_bookings b
  SET shipper_account_id = l.poster_account_id,
      carrier_account_id = gc.created_by
  FROM public.freight_loads l
  LEFT JOIN public.groups gc ON gc.id = b.carrier_group_id
  WHERE l.id = b.load_id AND b.shipper_account_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'R1 di tru 7.5: da gan tai khoan hai phia cho % chuyen.', v_n;

  UPDATE public.freight_bookings b
  SET my_vehicle_id = mv.id
  FROM public.freight_my_vehicles mv
  WHERE mv.legacy_source_id = b.vehicle_id
    AND mv.account_id = b.carrier_account_id
    AND b.my_vehicle_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'R1 di tru 7.5: da map my_vehicle_id cho % chuyen.', v_n;

  UPDATE public.freight_bookings b
  SET my_driver_id = md.id
  FROM public.freight_my_drivers md
  WHERE md.legacy_source_id = b.driver_id
    AND md.account_id = b.carrier_account_id
    AND b.my_driver_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'R1 di tru 7.5: da map my_driver_id cho % chuyen.', v_n;

  SELECT COUNT(*) INTO v_n FROM public.freight_bookings
  WHERE shipper_account_id IS NULL OR carrier_account_id IS NULL;
  RAISE NOTICE 'R1 di tru 7.5: con % chuyen CHUA du tai khoan hai phia (ky vong 0 — neu > 0, xem huong dan).', v_n;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'R1 di tru 7.5 LOI: %', SQLERRM;
END;
$$;

-- ---------------------------------------------------------------------
-- 8. ĐÁNH DẤU DEPRECATED CHO ĐỐI TƯỢNG GROUP CŨ (chỉ comment — KHÔNG
-- DROP, KHÔNG sửa dữ liệu; giữ cho client cũ + đối chiếu lịch sử).
-- ---------------------------------------------------------------------

COMMENT ON TABLE public.freight_org_profiles IS 'DEPRECATED từ R1 (2026-11-28): mô hình group cũ, chỉ đọc lịch sử. Dùng freight_account_profiles.';
COMMENT ON TABLE public.freight_carrier_profiles IS 'DEPRECATED từ R1 (2026-11-28): mô hình group cũ, chỉ đọc lịch sử. Phần vận tải đã gộp vào freight_account_profiles.';
COMMENT ON TABLE public.freight_warehouse_profiles IS 'DEPRECATED từ R1 (2026-11-28): mô hình group cũ, chỉ đọc lịch sử. Dùng freight_my_warehouses.';
COMMENT ON TABLE public.freight_vehicles IS 'DEPRECATED từ R1 (2026-11-28): mô hình group cũ, chỉ đọc lịch sử. Dùng freight_my_vehicles.';
COMMENT ON TABLE public.freight_drivers IS 'DEPRECATED từ R1 (2026-11-28): mô hình group cũ, chỉ đọc lịch sử. Dùng freight_my_drivers.';
COMMENT ON TABLE public.freight_service_routes IS 'DEPRECATED từ R1 (2026-11-28): mô hình group cũ, chỉ đọc lịch sử. Dùng freight_my_routes.';
COMMENT ON TABLE public.freight_org_links IS 'DEPRECATED từ R1 (2026-11-28): kết nối theo group cũ, chỉ đọc lịch sử. Dùng freight_account_links.';
COMMENT ON VIEW public.freight_loads_public IS 'DEPRECATED từ R1 (2026-11-28): view tra cứu theo group của T1, giữ cho client cũ. Client mới dùng freight_loads_discover.';

-- =====================================================================
-- KIỂM CHỨNG SAU KHI ÁP (chạy tay trong SQL Editor — tương ứng mục
-- 1.8.4 của tài liệu thiết kế; hướng dẫn đầy đủ ở
-- huong-dan-r1-di-tru-tai-khoan.md):
--
-- (a) Số tài khoản có hồ sơ: hai số phải bằng nhau (chênh lệch chỉ bởi
--     group thiếu created_by đã được NOTICE ở bước 7.0 liệt kê):
--     SELECT COUNT(DISTINCT g.created_by) FROM public.freight_org_profiles op
--       JOIN public.groups g ON g.id = op.group_id WHERE g.created_by IS NOT NULL;
--     SELECT COUNT(*) FROM public.freight_account_profiles;
--
-- (b) Mọi tải/chuyến đều đã có chủ tài khoản — kỳ vọng 0 và 0:
--     SELECT COUNT(*) FROM public.freight_loads WHERE poster_account_id IS NULL;
--     SELECT COUNT(*) FROM public.freight_bookings
--       WHERE shipper_account_id IS NULL OR carrier_account_id IS NULL;
--
-- (c) Xe cũ chưa có bản sao theo tài khoản — kỳ vọng CHỈ gồm các dòng
--     trùng biển số (cùng một tài khoản, hai group cũ) bị DO NOTHING:
--     SELECT v.* FROM public.freight_vehicles v
--     WHERE NOT EXISTS (SELECT 1 FROM public.freight_my_vehicles mv
--                       WHERE mv.legacy_source_id = v.id);
--
-- (d) Đếm kho/tài xế/tuyến cũ (thuộc group có created_by) so với mới:
--     SELECT (SELECT COUNT(*) FROM public.freight_warehouse_profiles w
--               JOIN public.groups g ON g.id = w.group_id WHERE g.created_by IS NOT NULL) AS kho_cu,
--            (SELECT COUNT(*) FROM public.freight_my_warehouses) AS kho_moi,
--            (SELECT COUNT(*) FROM public.freight_drivers d
--               JOIN public.groups g ON g.id = d.group_id WHERE g.created_by IS NOT NULL) AS tx_cu,
--            (SELECT COUNT(*) FROM public.freight_my_drivers) AS tx_moi,
--            (SELECT COUNT(*) FROM public.freight_service_routes r
--               JOIN public.groups g ON g.id = r.group_id WHERE g.created_by IS NOT NULL) AS tuyen_cu,
--            (SELECT COUNT(*) FROM public.freight_my_routes) AS tuyen_moi;
--
-- (e) Kiểm tra mẫu 1 chuyến cũ: shipper_account_id phải bằng
--     poster_account_id của load; carrier_account_id phải bằng
--     created_by của carrier group:
--     SELECT b.code, b.shipper_account_id, l.poster_account_id,
--            b.carrier_account_id, g.created_by AS carrier_group_creator
--     FROM public.freight_bookings b
--     JOIN public.freight_loads l ON l.id = b.load_id
--     LEFT JOIN public.groups g ON g.id = b.carrier_group_id
--     LIMIT 10;
--
-- (f) Đối tượng mới đã tồn tại:
--     SELECT table_name, table_type FROM information_schema.tables
--     WHERE table_schema = 'public' AND table_name LIKE 'freight%'
--     ORDER BY table_name;
--     SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--     WHERE n.nspname = 'public' AND proname LIKE 'freight_acct%' ORDER BY proname;
--
-- ROLLBACK:
--   * Đường chính là PHÍA CLIENT: quay về bản deploy trước R1 — client
--     cũ chỉ dùng bảng/RPC group của T1, mà R1 KHÔNG sửa một dòng dữ
--     liệu nào của chúng (chỉ ADD COLUMN nullable + DROP NOT NULL +
--     comment). Không cần đụng database.
--   * Dọn hẳn phía schema (CHỈ khi đã chắc chắn không quay lại mô hình
--     tài khoản; làm mất dữ liệu đã tạo trong bảng mới):
--     DROP VIEW IF EXISTS public.freight_loads_discover;
--     DROP TABLE IF EXISTS public.freight_load_groups,
--       public.freight_account_links, public.freight_my_routes,
--       public.freight_my_drivers, public.freight_my_vehicles,
--       public.freight_my_warehouses, public.freight_account_profiles CASCADE;
--     ALTER TABLE public.freight_bookings
--       DROP COLUMN IF EXISTS my_driver_id, DROP COLUMN IF EXISTS my_vehicle_id,
--       DROP COLUMN IF EXISTS carrier_account_id, DROP COLUMN IF EXISTS shipper_account_id;
--     ALTER TABLE public.freight_loads
--       DROP COLUMN IF EXISTS pickup_point_id, DROP COLUMN IF EXISTS directed_account_id,
--       DROP COLUMN IF EXISTS poster_account_id;
--     DROP FUNCTION IF EXISTS
--       public.freight_acct_respond_link(uuid, boolean),
--       public.freight_acct_invite_link(uuid),
--       public.freight_acct_cancel_booking(uuid, text),
--       public.freight_acct_advance_booking(uuid, text, text, double precision, double precision),
--       public.freight_acct_assign_vehicle_driver(uuid, uuid, uuid),
--       public.freight_acct_respond_booking(uuid, boolean, text),
--       public.freight_acct_assign_booking(uuid, uuid, numeric),
--       public.freight_acct_unshare_load(uuid, uuid),
--       public.freight_acct_share_load_to_group(uuid, uuid),
--       public.freight_acct_cancel_load(uuid, text),
--       public.freight_acct_create_load(uuid, uuid, text, text, numeric, int, numeric, text, uuid, text, text, text, text, text, text, timestamptz, timestamptz, timestamptz, text, uuid, numeric, timestamptz),
--       public.freight_acct_upsert_profile(text, text, text, text, text, text, text, boolean, boolean, text, text),
--       public.freight_acct_actor_side(uuid, uuid),
--       public.freight_acct_my_linked_ids(),
--       public.freight_acct_shares_group(uuid, uuid),
--       public.freight_acct_is_linked(uuid, uuid);
--     (Không khôi phục lại NOT NULL cho các cột group: việc nới lỏng vô
--     hại với cả hai mô hình, giữ nguyên để tránh khoá dữ liệu NULL
--     hợp lệ đã phát sinh trong thời gian chạy mô hình tài khoản.)
-- =====================================================================
