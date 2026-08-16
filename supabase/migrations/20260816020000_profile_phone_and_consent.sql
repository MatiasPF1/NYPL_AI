-- Phase D step 8/9: the number we text, and permission to follow someone.
--
-- Two things the safety loop cannot run without, and neither of them may be
-- assumed:
--
--   * `phone` — where a deviation or SOS text is sent. Stored E.164 so there
--     is one canonical form; the app normalises before it gets here.
--   * `location_consent_at` — the moment the account holder authorised live
--     location tracking. A timestamp rather than a boolean, because "when did
--     they agree" is the question that actually gets asked later, and because
--     withdrawing consent is then a matter of setting it back to null.
--
-- Tracking is gated on that column being non-null. Absence is refusal: a row
-- that has never been through the consent form cannot be followed, which is
-- the correct default for a feature that records where someone walks.
--
-- Nothing here relaxes RLS. profiles already restricts every command to
-- `(select auth.uid()) = id`, so a user can set and clear their own consent
-- and nobody else's.

alter table public.profiles
  add column if not exists phone text
    check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  add column if not exists location_consent_at timestamptz;

comment on column public.profiles.phone is
  'E.164 mobile number for safety alerts. Null means no SMS can be sent.';
comment on column public.profiles.location_consent_at is
  'When the user authorised live location tracking. Null means not authorised.';
