import { NextResponse } from "next/server";
import { supabaseAnon, supabaseService } from "@/lib/supabase";
import OpenAI from "openai";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type RouteContext = { params: { slug: string } };

type HistogramRow = {
  adjective_id: string;
  word: string;
  category: string | null;
  count: number | string;
};

type Candidate = {
  id: string;
  word: string;
  category: string | null;
  count: number;
};

type LlmSelected = { selected: string[] };

function getSlug(req: Request, context: RouteContext): string | null {
  const fromParams = context?.params?.slug;
  if (typeof fromParams === "string" && fromParams.length > 0) return fromParams;

  const pathname = new URL(req.url).pathname;
  const parts = pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last || last === "results") return null;
  return last;
}

function uniq(arr: string[]) {
  return Array.from(new Set(arr));
}

export async function GET(req: Request, context: RouteContext) {
  const slug = getSlug(req, context);
  if (!slug) return NextResponse.json({ error: "Missing slug" }, { status: 400 });

  // 1) Fetch profile (public read)
  const { data: profile, error: profErr } = await supabaseAnon
    .from("profiles")
    .select("id, name, slug")
    .eq("slug", slug)
    .single();

  if (profErr) return NextResponse.json({ error: profErr.message }, { status: 500 });
  if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

  // 2) Count submissions (public read)
  const { count: submissionCount, error: countErr } = await supabaseAnon
    .from("submissions")
    .select("*", { count: "exact", head: true })
    .eq("profile_id", profile.id);

  if (countErr) return NextResponse.json({ error: countErr.message }, { status: 500 });

  const totalSubmissions = submissionCount ?? 0;

  // 3) Check cache (public read)
  const { data: cache, error: cacheErr } = await supabaseAnon
    .from("profile_top3_cache")
    .select("profile_id, top3_ids, submission_count_at_compute, updated_at")
    .eq("profile_id", profile.id)
    .maybeSingle();

  if (cacheErr) return NextResponse.json({ error: cacheErr.message }, { status: 500 });

  if (cache && cache.submission_count_at_compute === totalSubmissions) {
    const { data: words, error: wordsErr } = await supabaseAnon
      .from("adjectives")
      .select("id, word, category")
      .in("id", cache.top3_ids);

    if (wordsErr) return NextResponse.json({ error: wordsErr.message }, { status: 500 });

    return NextResponse.json({
      profile,
      totalSubmissions,
      top3: words ?? [],
      cached: true,
    });
  }

  // If nothing submitted yet, return empty
  if (totalSubmissions === 0) {
    return NextResponse.json({ profile, totalSubmissions, top3: [], cached: false });
  }

  // 4) Get histogram (public read via RPC)
  const { data: histogram, error: histErr } = await supabaseAnon.rpc("get_profile_histogram", {
    profile_id_input: profile.id,
  });

  if (histErr) return NextResponse.json({ error: histErr.message }, { status: 500 });

  const candidates: Candidate[] = ((histogram ?? []) as HistogramRow[])
    .map((r) => ({
      id: String(r.adjective_id),
      word: String(r.word),
      category: r.category ?? null,
      count: Number(r.count),
    }))
    .slice(0, 60);

  if (candidates.length === 0) {
    return NextResponse.json({ profile, totalSubmissions, top3: [], cached: false });
  }

  const candidateIdSet = new Set(candidates.map((c) => c.id));

  // 5) LLM select
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Pick exactly 3 UNIQUE adjective ids from the provided candidates. IDs must be from the candidate list. Return JSON only as {"selected":["id1","id2","id3"]}.',
      },
      { role: "user", content: JSON.stringify({ totalSubmissions, candidates }) },
    ],
  });

  let parsed: LlmSelected | null = null;
  try {
    parsed = JSON.parse(completion.choices[0]?.message?.content ?? "null") as LlmSelected;
  } catch {
    parsed = null;
  }

  const selectedIdsRaw = Array.isArray(parsed?.selected)
    ? parsed!.selected.map(String)
    : [];

  const cleaned = uniq(selectedIdsRaw);
  const valid = cleaned.length === 3 && cleaned.every((id) => candidateIdSet.has(id));

  // Fallback deterministic if invalid
  const finalIds = valid
    ? cleaned
    : candidates
        .slice()
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
        .map((c) => c.id);

  // 6) Cache result (service role only)
  if (!supabaseService) {
    return NextResponse.json(
      { error: "Server cache client not configured (SUPABASE_SERVICE_ROLE_KEY missing)" },
      { status: 500 }
    );
  }

  const { error: upsertErr } = await supabaseService.from("profile_top3_cache").upsert({
    profile_id: profile.id,
    top3_ids: finalIds,
    submission_count_at_compute: totalSubmissions,
    updated_at: new Date().toISOString(),
  });

  if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 500 });

  // 7) Return words (public read)
  const { data: words, error: wordsErr } = await supabaseAnon
    .from("adjectives")
    .select("id, word, category")
    .in("id", finalIds);

  if (wordsErr) return NextResponse.json({ error: wordsErr.message }, { status: 500 });

  return NextResponse.json({
    profile,
    totalSubmissions,
    top3: words ?? [],
    cached: false,
  });
}
