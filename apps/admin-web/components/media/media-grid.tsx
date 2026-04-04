"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, FileImage, FileVideo, FileAudio, File, RefreshCw, CheckCircle } from "lucide-react";
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

  return (
    <a
      href={`/api/media/${item.mediaId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative aspect-square overflow-hidden rounded-lg bg-slate-100 border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all duration-150 cursor-pointer block"
    >
      {isImage ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/media/${item.mediaId}`}
            alt={item.fileName ?? `media-${item.mediaId}`}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-slate-900/50 opacity-0 group-hover:opacity-100 transition-opacity duration-150 flex flex-col justify-end p-2">
            <div className="flex items-end justify-between">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-white truncate font-mono">{item.fileName ?? `#${item.mediaId}`}</p>
                {item.fileSize && (
                  <p className="text-xs text-slate-300">{formatBytes(item.fileSize)}</p>
                )}
                {(item.description || reanalyzed) && (
                  <p className="text-xs text-green-300 truncate mt-0.5">✓ 已解析</p>
                )}
              </div>
              <ReanalyzeButton mediaId={item.mediaId} onDone={() => setReanalyzed(true)} />
            </div>
          </div>
        </>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-3">
          <MediaTypeIcon contentType={item.contentType} />
          <p className="text-xs text-slate-500 text-center truncate w-full">{item.fileName ?? `#${item.mediaId}`}</p>
          {item.fileSize && (
            <span className="text-xs text-slate-400">{formatBytes(item.fileSize)}</span>
          )}
          {(item.description || reanalyzed) && (
            <span className="text-xs text-green-500">✓ 已解析</span>
          )}
          <ReanalyzeButton mediaId={item.mediaId} onDone={() => setReanalyzed(true)} />
        </div>
      )}
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
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
        {items.map((item) => (
          <MediaTile key={item.mediaId} item={item} />
        ))}
      </div>
      <Pagination page={page} total={total} pageSize={pageSize} />
    </div>
  );
}
