import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageItem } from "./message-item";
import type { MessageRow } from "@/lib/queries";

interface PaginationProps {
  page: number;
  total: number;
  pageSize: number;
  baseUrl: string;
  search?: string;
}

function buildPageUrl(baseUrl: string, page: number, search?: string): string {
  const params = new URLSearchParams();
  params.set("page", String(page));
  if (search) params.set("search", search);
  return `${baseUrl}?${params.toString()}`;
}

function Pagination({ page, total, pageSize, baseUrl, search }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <div className="flex items-center justify-between pt-4 border-t border-slate-200">
      <span className="text-xs text-slate-400">
        第 {page} / {totalPages} 页 · 共 {total.toLocaleString("zh-CN")} 条
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
            <Link href={buildPageUrl(baseUrl, page - 1, search)}>
              <ChevronLeft className="h-4 w-4 mr-1" />
              上一页
            </Link>
          ) : (
            <span>
              <ChevronLeft className="h-4 w-4 mr-1" />
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
            <Link href={buildPageUrl(baseUrl, page + 1, search)}>
              下一页
              <ChevronRight className="h-4 w-4 ml-1" />
            </Link>
          ) : (
            <span>
              下一页
              <ChevronRight className="h-4 w-4 ml-1" />
            </span>
          )}
        </Button>
      </div>
    </div>
  );
}

interface MessageFeedProps {
  messages: MessageRow[];
  total: number;
  page: number;
  pageSize: number;
  baseUrl: string;
  search?: string;
}

export function MessageFeed({ messages, total, page, pageSize, baseUrl, search }: MessageFeedProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400">
        <p className="text-sm">暂无消息记录</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0">
      <div className="divide-y divide-slate-100">
        {messages.map((msg) => (
          <MessageItem key={msg.id} message={msg} />
        ))}
      </div>
      <Pagination page={page} total={total} pageSize={pageSize} baseUrl={baseUrl} search={search} />
    </div>
  );
}
