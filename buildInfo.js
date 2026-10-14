// This app's build id: the Git commit Vercel built it from (vite.config.js),
// "dev" for local builds. Sent with every database request (supabaseClient.js) so
// the database can refuse writes from any build other than the one the owner
// approved (ADD_RELEASE_CONTROL.sql).
/* global __LTC_BUILD__ */
export const BUILD = typeof __LTC_BUILD__ !== "undefined" && __LTC_BUILD__ ? __LTC_BUILD__ : "dev";
