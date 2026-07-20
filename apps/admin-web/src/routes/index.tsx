import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: HomePage })

export function HomePage() {
  return <main className="p-6"><h1 className="text-2xl font-semibold">QQ Bot WebAdmin</h1></main>
}
