export function qqGatewayHealth(connected: boolean, backfillCompleted: boolean): {
  status: 200 | 503
  body: { ok: boolean; connected: boolean; backfillCompleted: boolean }
} {
  const ok = connected && backfillCompleted
  return {
    status: ok ? 200 : 503,
    body: { ok, connected, backfillCompleted },
  }
}
