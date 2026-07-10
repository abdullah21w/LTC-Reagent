import { createClient } from "@supabase/supabase-js";

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

export const supabase = createClient(url, key);
