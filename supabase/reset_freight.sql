-- =====================================================================
-- RESET FREIGHT — xoá sạch toàn bộ đối tượng freight_* để cài lại từ đầu
-- Vị trí: supabase/reset_freight.sql (NẰM NGOÀI thư mục migrations —
-- đây là script vận hành chạy tay, không phải migration).
-- =====================================================================
-- ⚠️ PHẠM VI AN TOÀN — ĐỌC TRƯỚC KHI CHẠY:
--   Project Supabase này DÙNG CHUNG với app wms đang có khách dùng thật.
--   Script này CHỈ xoá các đối tượng trong schema public có tên bắt đầu
--   bằng tiền tố freight_ (view, bảng, sequence, hàm). Mọi vòng lặp đều
--   lọc cứng bằng LIKE 'freight\_%' — không có ngoại lệ.
--
--   TUYỆT ĐỐI KHÔNG đụng vào (không nằm trong phạm vi lọc freight_):
--     groups, group_members, orders, orders_view, order_events,
--     messages, message_attachments, carriers, carrier_claims,
--     carrier_suggestions, carrier_verifications, carriers_public,
--     profiles, và mọi hàm cũ (create_order, change_status,
--     complete_order, is_member, has_role, ...).
--   Dữ liệu kho LOCAL trong trình duyệt (OPFS) cũng không liên quan —
--   script này chỉ chạy phía Supabase.
--
-- Khi nào dùng: quy trình phát triển freight hiện tại là
--   "xoá sạch — cài mới" (dữ liệu freight chỉ là dữ liệu test):
--     1) Chạy file này (Supabase Dashboard -> SQL Editor -> Run).
--     2) Chạy migration gộp bản sạch:
--        supabase/migrations/20261128020000_freight_account_model_fresh.sql
--     3) Kiểm chứng theo cuối file migration đó.
--   Xem: ~/workspace/your_files/wms-nang-cap/
--        huong-dan-reset-va-cai-lai-freight.md
--
-- Script IDEMPOTENT: chạy lại nhiều lần an toàn (mọi DROP đều IF EXISTS
-- và các vòng lặp tự rỗng khi không còn đối tượng freight_ nào).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Xoá VIEW / MATERIALIZED VIEW freight_*
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_list text := '';
BEGIN
  FOR r IN
    SELECT viewname AS name FROM pg_views
    WHERE schemaname = 'public' AND viewname LIKE 'freight\_%'
    UNION ALL
    SELECT matviewname AS name FROM pg_matviews
    WHERE schemaname = 'public' AND matviewname LIKE 'freight\_%'
    ORDER BY 1
  LOOP
    EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', r.name);
    v_list := v_list || r.name || ', ';
  END LOOP;
  RAISE NOTICE 'Reset freight [1/4]: da xoa VIEW/MATVIEW: %', COALESCE(NULLIF(btrim(v_list, ', '), ''), '(khong co)');
END;
$$;

-- ---------------------------------------------------------------------
-- 2. Xoá BẢNG freight_* (CASCADE gỡ luôn policy/trigger/index/FK phụ thuộc)
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_list text := '';
BEGIN
  FOR r IN
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      AND table_name LIKE 'freight\_%'
    ORDER BY 1
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.name);
    v_list := v_list || r.name || ', ';
  END LOOP;
  RAISE NOTICE 'Reset freight [2/4]: da xoa BANG: %', COALESCE(NULLIF(btrim(v_list, ', '), ''), '(khong co)');
END;
$$;

-- ---------------------------------------------------------------------
-- 3. Xoá SEQUENCE freight_* (sequence của mã TAI-/CH- không tự mất theo
-- bảng vì được tạo độc lập bằng CREATE SEQUENCE)
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_list text := '';
BEGIN
  FOR r IN
    SELECT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
      AND c.relname LIKE 'freight\_%'
    ORDER BY 1
  LOOP
    EXECUTE format('DROP SEQUENCE IF EXISTS public.%I CASCADE', r.name);
    v_list := v_list || r.name || ', ';
  END LOOP;
  RAISE NOTICE 'Reset freight [3/4]: da xoa SEQUENCE: %', COALESCE(NULLIF(btrim(v_list, ', '), ''), '(khong co)');
END;
$$;

-- ---------------------------------------------------------------------
-- 4. Xoá FUNCTION freight_* (đúng chữ ký bằng
-- pg_get_function_identity_arguments). Chạy 2 lượt: lượt 2 dọn các hàm
-- SQL-language còn phụ thuộc chéo mà CASCADE ở lượt 1 chưa gỡ hết.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_pass int;
  v_list text;
BEGIN
  FOR v_pass IN 1..2 LOOP
    v_list := '';
    FOR r IN
      SELECT p.proname AS name,
             pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'freight\_%'
      ORDER BY 1, 2
    LOOP
      EXECUTE format('DROP FUNCTION IF EXISTS public.%I(%s) CASCADE', r.name, r.args);
      v_list := v_list || r.name || ', ';
    END LOOP;
    RAISE NOTICE 'Reset freight [4/4] luot %: da xoa FUNCTION: %', v_pass, COALESCE(NULLIF(btrim(v_list, ', '), ''), '(khong co)');
  END LOOP;
END;
$$;

-- =====================================================================
-- KIỂM CHỨNG SAU RESET (các SELECT dưới đây tự chạy kèm khi Run cả file):
--   - freight_con_lai PHAI = 0 (bảng + view + hàm + sequence).
--   - orders_rows / groups_rows là số dòng HIỆN CÓ của app đang chạy —
--     chỉ để đối chiếu bằng mắt rằng dữ liệu cũ vẫn nguyên (script này
--     không hề ghi vào hai bảng đó).
-- =====================================================================
SELECT
  (SELECT COUNT(*) FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE 'freight\_%')
  + (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'freight\_%')
  + (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S' AND c.relname LIKE 'freight\_%')
    AS freight_con_lai,
  (SELECT COUNT(*) FROM public.orders) AS orders_rows_khong_doi,
  (SELECT COUNT(*) FROM public.groups) AS groups_rows_khong_doi;
