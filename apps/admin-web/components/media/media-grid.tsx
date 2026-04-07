"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  FileImage,
  FileVideo,
  FileAudio,
  File,
  RefreshCw,
  CheckCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MediaMeta } from "@/lib/queries";

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MediaTypeIcon({ contentType }: { contentType: string | null }) {
  if (contentType?.startsWith("image/")) return <FileImage className="h-5 w-5 text-blue-500" />;
  if (contentType?.startsWith("video/")) return <FileVideo className="h-5 w-5 text-purple-500" />;
  if (contentType?.startsWith("audio/")) return <FileAudio className="h-5 w-5 text-green-500" />;
  return <File className="h-5 w-5 text-slate-400" />;
}

function formatCreatedAt(createdAt: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(createdAt));
}

function ReanalyzeButton({ mediaId, onDone }: { mediaId: number; onDone: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    startTransition(async () => {
      await fetch(`/api/bot/api/media/${mediaId}/reanalyze`, { method: "POST" });
      setDone(true);
      onDone();
    });
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      title="重新解析"
      className="flex items-center justify-center h-6 w-6 rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors disabled:opacity-50"
    >
      {done ? (
        <CheckCircle className="h-3.5 w-3.5 text-green-300" />
      ) : isPending ? (
        <RefreshCw className="h-3 w-3 animate-spin" />
      ) : (
        <RefreshCw className="h-3 w-3" />
      )}
    </button>
  );
}

function MediaTile({ item }: { item: MediaMeta }) {
  const isImage = item.contentType?.startsWith("image/");
  const [reanalyzed, setReanalyzed] = useState(false);
  const hasDescription = Boolean(item.description || reanalyzed);
  const descriptionText = reanalyzed
    ? item.description ?? "媒体描述已更新，刷新后可看到最新结果。"
    : item.description ?? "暂无媒体描述";

  return (
    <a
      href={`/api/media/${item.mediaId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-lg hover:shadow-slate-200/70"
    >
      <div className="relative aspect-square overflow-hidden bg-slate-100">
        {isImage ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/media/${item.mediaId}`}
              alt={item.fileName ?? `media-${item.mediaId}`}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
              loading="lazy"
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-slate-950/45 via-slate-950/10 to-transparent" />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 bg-slate-50 p-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
              <MediaTypeIcon contentType={item.contentType} />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                {item.mediaType ?? "FILE"}
              </p>
              <p className="text-sm text-slate-500">
                无缩略图预览
              </p>
            </div>
          </div>
        )}
        <div className="absolute right-2 top-2">
          <ReanalyzeButton mediaId={item.mediaId} onDone={() => setReanalyzed(true)} />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-3">
        <div className="space-y-1.5">
          <p className="truncate text-sm font-medium text-slate-900">
            {item.fileName ?? `#${item.mediaId}`}
          </p>
          <p
            className={`text-xs leading-5 ${
              hasDescription ? "text-slate-600" : "text-slate-400"
            } line-clamp-3 min-h-[3.75rem]`}
            title={item.description ?? undefined}
          >
            {descriptionText}
          </p>
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 text-[11px] text-slate-400">
          <span className="truncate">
            {item.fileSize ? formatBytes(item.fileSize) : item.mediaType ?? "未知类型"}
          </span>
          <span className="shrink-0">{formatCreatedAt(item.createdAt)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
          <span
            className={`inline-flex items-center rounded-full px-2 py-1 text-[11px] font-medium ${
              hasDescription
                ? "bg-emerald-50 text-emerald-700"
                : "bg-slate-100 text-slate-500"
            }`}
          >
            {hasDescription ? "已解析描述" : "待补充描述"}
          </span>
          <span className="text-[11px] text-slate-400">#{item.mediaId}</span>
        </div>
      </div>
    </a>
  );
}

function Pagination({ page, total, pageSize }: { page: number; total: number; pageSize: number }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <div className="flex items-center justify-between pt-4 border-t border-slate-200">
      <span className="text-xs text-slate-400">
        第 {page} / {totalPages} 页 · 共 {total.toLocaleString("zh-CN")} 个文件
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!hasPrev}
          className="h-8 border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40"
          asChild={hasPrev}
        >
          {hasPrev ? (
            <Link href={`/media?page=${page - 1}`}>
              <ChevronLeft className="h-4 w-4 mr-1" />
              上一页
            </Link>
          ) : (
            <span><ChevronLeft className="h-4 w-4 mr-1" />上一页</span>
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasNext}
          className="h-8 border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40"
          asChild={hasNext}
        >
          {hasNext ? (
            <Link href={`/media?page=${page + 1}`}>
              下一页
              <ChevronRight className="h-4 w-4 ml-1" />
            </Link>
          ) : (
            <span>下一页<ChevronRight className="h-4 w-4 ml-1" /></span>
          )}
        </Button>
      </div>
    </div>
  );
}

interface MediaGridProps {
  items: MediaMeta[];
  total: number;
  page: number;
  pageSize: number;
}

export function MediaGrid({ items, total, page, pageSize }: MediaGridProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400">
        <FileImage className="h-8 w-8 mb-3 opacity-40" />
        <p className="text-sm">暂无媒体文件</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
        {items.map((item) => (
          <MediaTile key={item.mediaId} item={item} />
        ))}
      </div>
      <Pagination page={page} total={total} pageSize={pageSize} />
    </div>
  );
}
