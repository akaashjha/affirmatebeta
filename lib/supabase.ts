import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) throw new Error("Missing SUPABASE_URL");
if (!anonKey) throw new Error("Missing SUPABASE_ANON_KEY");

export const supabaseAnon = createClient(url, anonKey);
export const supabaseService = serviceKey ? createClient(url, serviceKey) : null;
export const supabase = supabaseAnon;
