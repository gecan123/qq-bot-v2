const TZ = "Asia/Shanghai";

export function formatTime(date: Date | string): string {
  return new Date(date).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TZ,
  });
}

export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
    timeZone: TZ,
  });
}

export function formatDateTime(date: Date | string): string {
  return new Date(date).toLocaleString("zh-CN", { timeZone: TZ });
}
