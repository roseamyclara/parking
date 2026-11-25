-- 臺中市身障免銷單停車場地圖 — TDX 剩餘車位即時代理快取與每日上限
-- 在 Supabase SQL Editor 執行一次即可；重複執行不會出錯。
--
-- 所有資料表都啟用 RLS 且不設公開 policy：只允許 Edge Function（service_role）讀寫，
-- 前端（anon / authenticated）無法直接讀取或修改。

-- 1. 單列共用快取（固定 id = 1）：90 秒內多位使用者點擊「即時更新」共用同一份 TDX 結果
create table if not exists public.tdx_availability_cache (
  id integer primary key default 1 check (id = 1),
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.tdx_availability_cache enable row level security;

-- 2. 每日（臺灣時間 Asia/Taipei）實際向 TDX 查詢的次數，保護免費額度
create table if not exists public.tdx_daily_usage (
  day date primary key,
  fetches integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.tdx_daily_usage enable row level security;

-- 3. TDX OAuth access token 單列快取（固定 id = 1）：避免每次都重打 token endpoint
create table if not exists public.tdx_token_cache (
  id integer primary key default 1 check (id = 1),
  access_token text not null,
  expires_at timestamptz not null
);
alter table public.tdx_token_cache enable row level security;

-- 4. 原子化每日次數扣抵（僅在今日 fetches < p_cap 時遞增並回傳 allowed = true）
create or replace function public.claim_tdx_fetch(p_cap integer default 90)
returns table (allowed boolean, fetches integer)
language plpgsql security definer set search_path = public as $$
declare
  v_day date := (now() at time zone 'Asia/Taipei')::date;
  v_fetches integer;
begin
  if p_cap <= 0 then
    select u.fetches into v_fetches
    from public.tdx_daily_usage u
    where u.day = v_day;
    return query select false, coalesce(v_fetches, 0);
    return;
  end if;

  insert into public.tdx_daily_usage (day, fetches, updated_at)
  values (v_day, 1, now())
  on conflict (day) do update
    set fetches = public.tdx_daily_usage.fetches + 1,
        updated_at = now()
    where public.tdx_daily_usage.fetches < p_cap
  returning public.tdx_daily_usage.fetches into v_fetches;

  if found then
    return query select true, v_fetches;
    return;
  end if;

  select u.fetches into v_fetches
  from public.tdx_daily_usage u
  where u.day = v_day;

  return query select false, coalesce(v_fetches, p_cap);
end;
$$;

revoke execute on function public.claim_tdx_fetch(integer) from public, anon, authenticated;
grant execute on function public.claim_tdx_fetch(integer) to service_role;
