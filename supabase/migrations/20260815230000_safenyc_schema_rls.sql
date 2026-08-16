-- SafeNYC core schema.
--
-- Every table below is reachable through the Supabase Data API, so every one
-- of them enables RLS and declares explicit per-command policies. Three rules
-- are applied without exception:
--
--   1. Ownership is checked with `(select auth.uid()) = user_id`. The subselect
--      is not cosmetic: it lets Postgres evaluate the uid once per statement
--      via an InitPlan instead of once per row.
--   2. `TO authenticated` is never the only check. It proves the caller is
--      logged in, not that the row is theirs, so it always appears alongside a
--      USING or WITH CHECK ownership predicate.
--   3. INSERT gets WITH CHECK, and UPDATE gets both USING and WITH CHECK.
--      USING alone on UPDATE would let a user hand a row to someone else by
--      rewriting user_id; WITH CHECK is what makes the new row still theirs.
--
-- No policy is written for `anon`. Absence of a policy is a denial under RLS,
-- so anonymous callers can reach none of these tables.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- Keyed by auth.users.id rather than a separate user_id column, so the
-- ownership predicate here reads `= id`. Same rule, different column name.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  trusted_contact_name text,
  trusted_contact_email text,
  trusted_contact_phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

create policy "profiles_insert_own" on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = id);

create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy "profiles_delete_own" on public.profiles
  for delete to authenticated
  using ((select auth.uid()) = id);

-- ---------------------------------------------------------------------------
-- routes
-- ---------------------------------------------------------------------------

create table public.routes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text,
  origin_lat double precision not null,
  origin_lng double precision not null,
  dest_lat double precision not null,
  dest_lng double precision not null,
  path jsonb,
  distance_m double precision,
  risk_score double precision,
  created_at timestamptz not null default now()
);

create index routes_user_id_idx on public.routes (user_id);

alter table public.routes enable row level security;

create policy "routes_select_own" on public.routes
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "routes_insert_own" on public.routes
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "routes_update_own" on public.routes
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "routes_delete_own" on public.routes
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- location_shares
-- ---------------------------------------------------------------------------
-- Declared before `locations` because the locations SELECT policy references
-- it. Only the sha256 hash of a share token is stored: a dump of this table
-- yields nothing that can be replayed against a live share.

create table public.location_shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid references auth.users (id) on delete cascade,
  recipient_email text,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index location_shares_owner_idx on public.location_shares (owner_id);
create index location_shares_recipient_idx on public.location_shares (recipient_id);

alter table public.location_shares enable row level security;

-- The owner has full control over their own shares.
create policy "location_shares_select_own" on public.location_shares
  for select to authenticated
  using ((select auth.uid()) = owner_id);

create policy "location_shares_insert_own" on public.location_shares
  for insert to authenticated
  with check ((select auth.uid()) = owner_id);

-- Revoking is an UPDATE, so this needs WITH CHECK too, or a share could be
-- reassigned to a different owner on the way out.
create policy "location_shares_update_own" on public.location_shares
  for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

create policy "location_shares_delete_own" on public.location_shares
  for delete to authenticated
  using ((select auth.uid()) = owner_id);

-- A named recipient may read the share addressed to them, but only while it is
-- live. No INSERT/UPDATE/DELETE policy exists for recipients.
create policy "location_shares_select_as_recipient" on public.location_shares
  for select to authenticated
  using (
    (select auth.uid()) = recipient_id
    and revoked_at is null
    and expires_at > now()
  );

-- ---------------------------------------------------------------------------
-- locations
-- ---------------------------------------------------------------------------

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  route_id uuid references public.routes (id) on delete set null,
  lat double precision not null,
  lng double precision not null,
  accuracy_m double precision,
  recorded_at timestamptz not null default now()
);

create index locations_user_recorded_idx
  on public.locations (user_id, recorded_at desc);

alter table public.locations enable row level security;

-- Read: the owner, or a signed-in recipient holding a live, unrevoked share.
-- The share check is evaluated here in the database, never in the client, so
-- it applies identically to REST reads and to Realtime subscriptions.
create policy "locations_select_own_or_shared" on public.locations
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    or exists (
      select 1
      from public.location_shares s
      where s.owner_id = locations.user_id
        and s.recipient_id = (select auth.uid())
        and s.revoked_at is null
        and s.expires_at > now()
    )
  );

-- Write: owner only. A recipient can watch a walk; they can never forge one.
create policy "locations_insert_own" on public.locations
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "locations_update_own" on public.locations
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "locations_delete_own" on public.locations
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- alerts
-- ---------------------------------------------------------------------------

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  route_id uuid references public.routes (id) on delete set null,
  kind text not null check (kind in ('deviation', 'sos', 'arrived')),
  message text,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create index alerts_user_idx on public.alerts (user_id, created_at desc);

alter table public.alerts enable row level security;

create policy "alerts_select_own" on public.alerts
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "alerts_insert_own" on public.alerts
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "alerts_update_own" on public.alerts
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "alerts_delete_own" on public.alerts
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- new user -> profile row
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because it writes public.profiles on behalf of a user who
-- does not exist yet at the moment the trigger fires. It is safe because it
-- takes no arguments: the id comes from the NEW row Postgres hands it, so a
-- caller cannot aim it at another account. search_path is pinned to empty so a
-- malicious schema earlier on the path cannot shadow the objects it touches.

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- profiles.updated_at
-- ---------------------------------------------------------------------------

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();
