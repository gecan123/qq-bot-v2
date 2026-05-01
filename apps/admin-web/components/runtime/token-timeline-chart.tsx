/**
 * Phase 1.5 token timeline chart.
 *
 * 双线: input_tokens (灰) + cached_tokens (绿)。
 * prefix_hash 切换处加竖线 = compaction 时刻。
 * 纯 SVG, 不引第三方库。
 */
export interface TokenTimelinePoint {
  createdAt: Date;
  inputTokens: number | null;
  cachedTokens: number | null;
  prefixHash: string | null;
}

export function TokenTimelineChart({ points }: { points: TokenTimelinePoint[] }) {
  if (points.length === 0) {
    return <div className="text-xs text-slate-400">无数据</div>;
  }
  // 按时间正序，方便从左到右画
  const series = [...points].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const width = 720;
  const height = 160;
  const paddingLeft = 44;
  const paddingRight = 16;
  const paddingTop = 12;
  const paddingBottom = 28;
  const innerW = width - paddingLeft - paddingRight;
  const innerH = height - paddingTop - paddingBottom;

  const maxToken = Math.max(
    1,
    ...series.map((p) => Math.max(p.inputTokens ?? 0, p.cachedTokens ?? 0)),
  );

  const xAt = (i: number): number =>
    series.length === 1 ? paddingLeft + innerW / 2 : paddingLeft + (i / (series.length - 1)) * innerW;
  const yAt = (token: number): number => paddingTop + innerH - (token / maxToken) * innerH;

  const inputPath = series
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.inputTokens ?? 0).toFixed(1)}`)
    .join(" ");
  const cachedPath = series
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.cachedTokens ?? 0).toFixed(1)}`)
    .join(" ");

  // prefix 切换点: 当前 prefixHash 跟前一个不同
  const prefixSwitches = series
    .map((p, i) => ({ i, hash: p.prefixHash, prev: series[i - 1]?.prefixHash ?? null }))
    .filter((s) => s.i > 0 && s.hash !== s.prev);

  // Y 轴 grid (3 条线: 0 / 50% / 100%)
  const gridYs = [0, 0.5, 1].map((ratio) => ({
    y: paddingTop + innerH * (1 - ratio),
    label: Math.round(maxToken * ratio).toLocaleString(),
  }));

  // X 轴时间 label: 第一个、中间、最后一个
  const xLabels = series.length === 1
    ? [{ x: xAt(0), label: formatHm(series[0]!.createdAt) }]
    : [
        { x: xAt(0), label: formatHm(series[0]!.createdAt) },
        ...(series.length >= 4
          ? [{ x: xAt(Math.floor(series.length / 2)), label: formatHm(series[Math.floor(series.length / 2)]!.createdAt) }]
          : []),
        { x: xAt(series.length - 1), label: formatHm(series[series.length - 1]!.createdAt) },
      ];

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block w-full"
        role="img"
        aria-label="Token usage timeline"
      >
        {/* Y grid */}
        {gridYs.map((g, i) => (
          <g key={`grid-${i}`}>
            <line
              x1={paddingLeft}
              y1={g.y}
              x2={width - paddingRight}
              y2={g.y}
              stroke="#e2e8f0"
              strokeDasharray={i === 0 ? "0" : "2 2"}
            />
            <text x={paddingLeft - 6} y={g.y + 3} textAnchor="end" fontSize="9" fill="#94a3b8">
              {g.label}
            </text>
          </g>
        ))}
        {/* prefix switch 竖线 */}
        {prefixSwitches.map((s) => (
          <g key={`switch-${s.i}`}>
            <line
              x1={xAt(s.i)}
              y1={paddingTop}
              x2={xAt(s.i)}
              y2={paddingTop + innerH}
              stroke="#f59e0b"
              strokeWidth="1"
              strokeDasharray="3 2"
            />
            <text x={xAt(s.i) + 3} y={paddingTop + 9} fontSize="8" fill="#b45309">
              prefix
            </text>
          </g>
        ))}
        {/* input line */}
        <path d={inputPath} fill="none" stroke="#64748b" strokeWidth="1.5" />
        {/* cached line */}
        <path d={cachedPath} fill="none" stroke="#10b981" strokeWidth="1.5" />
        {/* points: input gray, cached green */}
        {series.map((p, i) => (
          <g key={`pt-${i}`}>
            <circle cx={xAt(i)} cy={yAt(p.inputTokens ?? 0)} r="2" fill="#64748b">
              <title>{`${formatHm(p.createdAt)} · input ${p.inputTokens ?? "—"}`}</title>
            </circle>
            <circle cx={xAt(i)} cy={yAt(p.cachedTokens ?? 0)} r="2" fill="#10b981">
              <title>{`${formatHm(p.createdAt)} · cached ${p.cachedTokens ?? "—"}`}</title>
            </circle>
          </g>
        ))}
        {/* X labels */}
        {xLabels.map((label, i) => (
          <text
            key={`xlabel-${i}`}
            x={label.x}
            y={height - 8}
            textAnchor="middle"
            fontSize="9"
            fill="#94a3b8"
          >
            {label.label}
          </text>
        ))}
      </svg>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
        <span><span className="mr-1 inline-block h-2 w-3 rounded bg-slate-500" /> input</span>
        <span><span className="mr-1 inline-block h-2 w-3 rounded bg-emerald-500" /> cached</span>
        <span><span className="mr-1 inline-block h-2 w-3 border-l-2 border-dashed border-amber-500" /> prefix 切换 (compaction)</span>
      </div>
    </div>
  );
}

function formatHm(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}
