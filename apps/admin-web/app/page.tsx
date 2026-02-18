export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 p-8">
      <section className="rounded-xl border bg-card p-6 text-card-foreground">
        <h1 className="text-2xl font-semibold tracking-tight">QQ Bot Admin</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Admin WebUI scaffold is ready. Data query flows will be added in the next step.
        </p>
      </section>
    </main>
  );
}
