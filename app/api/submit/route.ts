import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import crypto from "crypto";

export const runtime = "nodejs";

function sha256(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function getClientIp(req: Request) {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const profileId = body?.profileId;
  const adjectiveIds = body?.adjectiveIds;

  if (!profileId || typeof profileId !== "string") {
    return NextResponse.json({ error: "profileId required" }, { status: 400 });
  }

  if (!Array.isArray(adjectiveIds) || adjectiveIds.length !== 3) {
    return NextResponse.json({ error: "Pick exactly 3 adjectives" }, { status: 400 });
  }

  const ids = adjectiveIds.map(String);
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length !== 3) {
    return NextResponse.json({ error: "Adjectives must be distinct" }, { status: 400 });
  }

  // verify adjective ids exist
  const { data: found, error: foundErr } = await supabase
    .from("adjectives")
    .select("id")
    .in("id", uniqueIds);

  if (foundErr) return NextResponse.json({ error: foundErr.message }, { status: 500 });
  if (!found || found.length !== 3) {
    return NextResponse.json({ error: "One or more adjectiveIds invalid" }, { status: 400 });
  }

  const ip = getClientIp(req);
  const ua = req.headers.get("user-agent") ?? "unknown";
  const fingerprint = sha256(`${ip}|${ua}`);

  // basic 30s rate limit per profile+fingerprint
  const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString();
  const { data: recent, error: recentErr } = await supabase
    .from("submissions")
    .select("id")
    .eq("profile_id", profileId)
    .eq("fingerprint", fingerprint)
    .gte("created_at", thirtySecondsAgo)
    .limit(1);

  if (recentErr) return NextResponse.json({ error: recentErr.message }, { status: 500 });
  if (recent && recent.length > 0) {
    return NextResponse.json({ error: "Too many submissions, try again shortly" }, { status: 429 });
  }

  const { data: submission, error: subErr } = await supabase
    .from("submissions")
    .insert({ profile_id: profileId, fingerprint })
    .select("id")
    .single();

  if (subErr || !submission) {
    const msg = subErr?.message ?? "Failed to create submission";
    if (msg.toLowerCase().includes("duplicate") || msg.toLowerCase().includes("unique")) {
      return NextResponse.json({ error: "Duplicate submission blocked" }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const rows = uniqueIds.map((adjective_id: string) => ({
    submission_id: submission.id,
    adjective_id,
  }));

  const { error: joinErr } = await supabase.from("submission_adjectives").insert(rows);

  if (joinErr) {
    await supabase.from("submissions").delete().eq("id", submission.id);
    return NextResponse.json({ error: joinErr.message }, { status: 400 });
  }

  return NextResponse.json({ success: true, submissionId: submission.id });
}
