"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  AlignLeft,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  File,
  FileAudio,
  FileImage,
  FileJson2,
  FileVideo,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  formatMediaDescriptionRaw,
  getMediaDescriptionContent,
} from "@/lib/media-description";
import { buildMediaAssetUrl } from "@/lib/media-url";
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

  function handleClick(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
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
      className="flex h-6 w-6 items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60 disabled:opacity-50"
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

interface DescriptionDialogProps {
  item: MediaMeta;
  mediaUrl: string;
  fullText: string | null;
  rawText: string;
  open: boolean;
  onClose: () => void;
}

function DescriptionDialog({
  item,
  mediaUrl,
  fullText,
  rawText,
  open,
  onClose,
}: DescriptionDialogProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`media-description-title-${item.mediaId}`}
        className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-2xl shadow-slate-950/20"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-gradient-to-r from-slate-50 via-white to-slate-50 px-6 py-5">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium text-slate-500">
              <span className="rounded-full bg-slate-100 px-2.5 py-1">媒体描述</span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1">#{item.mediaId}</span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1">
                {item.fileSize ? formatBytes(item.fileSize) : item.mediaType ?? "未知类型"}
              </span>
            </div>
            <div>
              <h2
                id={`media-description-title-${item.mediaId}`}
                className="truncate text-lg font-semibold text-slate-900"
              >
                {item.fileName ?? `#${item.mediaId}`}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                文本区只负责查看描述。媒体文件仍通过预览区或右下角入口打开。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 bg-white p-2 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-900"
            aria-label="关闭描述弹窗"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 gap-4 overflow-hidden bg-slate-50/70 p-4 md:grid-cols-[1.1fr_0.9fr]">
          <section className="min-h-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
              <AlignLeft className="h-4 w-4 text-slate-400" />
              <h3 className="text-sm font-medium text-slate-900">完整文本</h3>
            </div>
            <div className="max-h-full overflow-y-auto px-4 py-4">
              <p className="whitespace-pre-wrap text-sm leading-7 text-slate-700">
                {fullText ?? "暂无可读文本"}
              </p>
            </div>
          </section>

          <section className="min-h-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 shadow-sm">
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <FileJson2 className="h-4 w-4 text-slate-400" />
                <h3 className="text-sm font-medium text-white">JSON 原文</h3>
              </div>
              <span className="text-[11px] text-slate-400">只读</span>
            </div>
            <div className="max-h-full overflow-y-auto px-4 py-4">
              <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-6 text-slate-200">
                {rawText || "暂无原始 JSON"}
              </pre>
            </div>
          </section>
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-white px-6 py-4">
          <p className="text-xs text-slate-400">点击遮罩或按 Esc 关闭这个弹窗。</p>
          <a
            href={mediaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
          >
            打开媒体文件
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </div>
    </div>,
    document.body
  );
}

function MediaTile({ item }: { item: MediaMeta }) {
  const isImage = item.contentType?.startsWith("image/");
  const [reanalyzed, setReanalyzed] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const mediaUrl = buildMediaAssetUrl({
    mediaId: item.mediaId,
    dataHash: item.dataHash,
    createdAt: item.createdAt,
  });
  const description = getMediaDescriptionContent(item.descriptionRaw);
  const rawDescription = formatMediaDescriptionRaw(item.descriptionRaw);
  const hasDescription = Boolean(description.summary || description.details.length > 0 || reanalyzed);
  const summaryText = reanalyzed
    ? description.summary ?? "媒体描述已更新，刷新后可看到最新结果。"
    : description.summary ?? "暂无媒体描述";

  return (
    <>
      <div className="group flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-lg hover:shadow-slate-200/70">
        <a
          href={mediaUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="relative block aspect-square overflow-hidden bg-slate-100"
        >
          {isImage ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={mediaUrl}
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
                <p className="text-sm text-slate-500">无缩略图预览</p>
              </div>
            </div>
          )}
          <div className="absolute right-2 top-2">
            <ReanalyzeButton mediaId={item.mediaId} onDone={() => setReanalyzed(true)} />
          </div>
        </a>

        <div className="flex flex-1 flex-col gap-3 p-3">
          <button
            type="button"
            onClick={() => hasDescription && setIsDialogOpen(true)}
            disabled={!hasDescription}
            className="rounded-2xl border border-transparent p-2 text-left outline-none transition-all hover:border-slate-200 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2 disabled:cursor-default disabled:hover:border-transparent disabled:hover:bg-transparent"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="truncate text-sm font-medium text-slate-900">
                {item.fileName ?? `#${item.mediaId}`}
              </p>
              {hasDescription ? (
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-500">
                  查看详情
                </span>
              ) : null}
            </div>

            <p
              className={`mt-2 text-xs leading-5 ${
                hasDescription ? "text-slate-700" : "text-slate-400"
              } line-clamp-2 min-h-[2.5rem]`}
              title={description.fullText ?? undefined}
            >
              {summaryText}
            </p>

            <div className="mt-3 flex items-center justify-between gap-2 border-t border-dashed border-slate-200 pt-2">
              <p className="text-[11px] font-medium text-slate-400">
                {hasDescription ? "点击文本区域查看完整文本与 JSON 原文" : ""}
              </p>
              {hasDescription ? <ExternalLink className="h-3.5 w-3.5 text-slate-300" /> : null}
            </div>
          </button>

          <div className="mt-auto flex items-center justify-between gap-2 text-[11px] text-slate-400">
            <span className="truncate">
              {item.fileSize ? formatBytes(item.fileSize) : item.mediaType ?? "未知类型"}
            </span>
            <span className="shrink-0">{formatCreatedAt(item.createdAt)}</span>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
            <span
              className={`inline-flex items-center rounded-full px-2 py-1 text-[11px] font-medium ${
                hasDescription ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
              }`}
            >
              {hasDescription ? "已解析描述" : "待补充描述"}
            </span>
            <span className="text-[11px] text-slate-400">#{item.mediaId}</span>
          </div>
        </div>
      </div>

      <DescriptionDialog
        item={item}
        mediaUrl={mediaUrl}
        fullText={description.fullText}
        rawText={rawDescription}
        open={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
      />
    </>
  );
}

function Pagination({ page, total, pageSize }: { page: number; total: number; pageSize: number }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <div className="flex items-center justify-between border-t border-slate-200 pt-4">
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
              <ChevronLeft className="mr-1 h-4 w-4" />
              上一页
            </Link>
          ) : (
            <span>
              <ChevronLeft className="mr-1 h-4 w-4" />
              上一页
            </span>
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
              <ChevronRight className="ml-1 h-4 w-4" />
            </Link>
          ) : (
            <span>
              下一页
              <ChevronRight className="ml-1 h-4 w-4" />
            </span>
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
        <FileImage className="mb-3 h-8 w-8 opacity-40" />
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
