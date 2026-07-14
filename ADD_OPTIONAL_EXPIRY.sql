-- Run this only if your reagents table still requires expiry_date.

alter table reagents alter column expiry_date drop not null;
