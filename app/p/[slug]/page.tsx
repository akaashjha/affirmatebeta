type PageProps = {
  params: { slug: string };
};

export default async function ProfilePage({ params }: PageProps) {
  const slug = params.slug;

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: 16, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Affirmate</h1>
      <p style={{ marginTop: 0, opacity: 0.8 }}>
        Profile: <b>{slug}</b>
      </p>

      <p style={{ marginTop: 24 }}>
        UI coming next. Your backend is live, this page just proves routing works.
      </p>
    </main>
  );
}
