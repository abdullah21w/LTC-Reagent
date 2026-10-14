import { createClient } from "@supabase/supabase-js";
import { BUILD } from "./buildInfo";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error(
    "Missing Supabase configuration.\n\n" +
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set as Environment Variables " +
    "in your Vercel project (Project → Settings → Environment Variables), then redeploy.\n\n" +
    `VITE_SUPABASE_URL is currently: ${url || "(missing)"}\n` +
    `VITE_SUPABASE_ANON_KEY is currently: ${key ? "(set)" : "(missing)"}`
  );
}

// Every request carries this app's build id: the database refuses writes from any
// build other than the one the owner approved (ADD_RELEASE_CONTROL.sql).
export const supabase = createClient(url, key, { global: { headers: { "x-ltc-build": BUILD } } });
