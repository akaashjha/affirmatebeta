import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getSlug(req: Request, context: any): string | null {
  const fromParams = context?.params?.slug;
  if (typeof fromParams === "string" && fromParams.length > 0) return fromParams;

  const pathname = new URL(req.url).pathname;
  const parts = pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last || last === "results") return null;
  return last;
}

export async function GET(req: Request, context: any) {
  const slug = getSlug(req, context);

  if (!slug) {
    return NextResponse.json({ error: "Missing slug" }, { status: 400 });
  }

  // 1) Fetch profile
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, name, slug")
    .eq("slug", slug)
    .single();

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  // 2) Count submissions
  const { count: submissionCount } = await supabase
    .from("submissions")
    .select("*", { count: "exact", head: true })
    .eq("profile_id", profile.id);

  const totalSubmissions = submissionCount ?? 0;

  // 3) Check cache
  const { data: cache } = await supabase
    .from("profile_top3_cache")
    .select("*")
    .eq("profile_id", profile.id)
    .single();

  if (
    cache &&
    cache.submission_count_at_compute === totalSubmissions
  ) {
    // return cached result
    const { data: words } = await supabase
      .from("adjectives")
      .select("id, word, category")
      .in("id", cache.top3_ids);

    return NextResponse.json({
      profile,
      totalSubmissions,
      top3: words ?? [],
      cached: true,
    });
  }

  // 4) Get histogram
  const { data: histogram } = await supabase.rpc("get_profile_histogram", {
    profile_id_input: profile.id,
  });

  const candidates = (histogram ?? [])
    .map((r: any) => ({
      id: String(r.adjective_id),
      word: String(r.word),
      category: r.category,
      count: Number(r.count),
    }))
    .slice(0, 60);

  if (candidates.length === 0) {
    return NextResponse.json({
      profile,
      totalSubmissions,
      top3: [],
    });
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Pick exactly 3 UNIQUE adjective ids from the provided candidates that best summarize the entire distribution. Return JSON only as {"selected":["id1","id2","id3"]}.',
      },
      {
        role: "user",
        content: JSON.stringify({
          totalSubmissions,
          candidates,
        }),
      },
    ],
  });

  let parsed: any;
  try {
    parsed = JSON.parse(completion.choices[0]?.message?.content ?? "null");
  } catch {
    return NextResponse.json({ error: "LLM invalid JSON" }, { status: 500 });
  }

  const selectedIds: string[] = parsed?.selected;

  if (!Array.isArray(selectedIds) || selectedIds.length !== 3) {
    return NextResponse.json({ error: "LLM did not return 3 ids" }, { status: 500 });
  }

  // 5) Cache result
  await supabase.from("profile_top3_cache").upsert({
    profile_id: profile.id,
    top3_ids: selectedIds,
    submission_count_at_compute: totalSubmissions,
    updated_at: new Date().toISOString(),
  });

  const { data: words } = await supabase
    .from("adjectives")
    .select("id, word, category")
    .in("id", selectedIds);

  return NextResponse.json({
    profile,
    totalSubmissions,
    top3: words ?? [],
    cached: false,
  });
}

