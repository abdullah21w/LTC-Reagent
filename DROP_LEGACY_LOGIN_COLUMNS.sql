-- Removes the old shared "lab" / "viewer" login columns from app_config.
-- These predate the per-employee staff_accounts system and have been
-- unused by the app since (see ADD_CUSTOM_PERMISSIONS.sql). Confirmed no
-- code in App.jsx, Login.jsx, or Settings.jsx reads these fields.

alter table app_config drop column if exists lab_username;
alter table app_config drop column if exists lab_password;
alter table app_config drop column if exists viewer_username;
alter table app_config drop column if exists viewer_password;
