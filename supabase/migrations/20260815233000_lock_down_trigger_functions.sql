-- Supabase's security advisor flagged public.handle_new_user() as a
-- SECURITY DEFINER function reachable by both `anon` and `authenticated`
-- through /rest/v1/rpc/handle_new_user.
--
-- In practice Postgres refuses to invoke a trigger function directly ("trigger
-- functions can only be called as triggers"), so this was not exploitable. But
-- an exposed definer-rights function is the exact shape of a privilege
-- escalation, and it costs nothing to close: the trigger runs as the table
-- owner and never needs an EXECUTE grant for anon or authenticated.

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
