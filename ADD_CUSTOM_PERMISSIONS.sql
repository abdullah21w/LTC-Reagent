-- Run this only if you already ran an older version of supabase_schema.sql
-- that had lab_username/lab_password/viewer_username/viewer_password on
-- app_config, and/or a staff_accounts table with no "permissions" column.

alter table staff_accounts add column if not exists permissions jsonb not null
  default '{"dashboard":true,"reports":true,"charts":false,"settings":false,"receive":false,"log_use":false,"edit":false,"delete":false}'::jsonb;

-- Give every existing employee account full access by default so nobody gets
-- locked out after this migration. Go to Settings and adjust each one from there.
update staff_accounts set permissions = '{"dashboard":true,"reports":true,"charts":true,"settings":true,"receive":true,"log_use":true,"edit":true,"delete":true}'::jsonb
where permissions = '{"dashboard":true,"reports":true,"charts":false,"settings":false,"receive":false,"log_use":false,"edit":false,"delete":false}'::jsonb;

-- The shared "lab" / "viewer" logins are no longer used by the app — everyone
-- now signs in with their own account from the Employee accounts list in
-- Settings. It's safe to leave the old columns in app_config; the app just
-- ignores them. To clean them up (optional):
-- alter table app_config drop column if exists lab_username;
-- alter table app_config drop column if exists lab_password;
-- alter table app_config drop column if exists viewer_username;
-- alter table app_config drop column if exists viewer_password;
