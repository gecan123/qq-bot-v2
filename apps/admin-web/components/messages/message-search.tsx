"use client";

import { useRouter, usePathname } from "next/navigation";
import { Search, X } from "lucide-react";
import { useRef, useTransition } from "react";

interface MessageSearchProps {
  defaultValue?: string;
}

export function MessageSearch({ defaultValue = "" }: MessageSearchProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = inputRef.current?.value.trim() ?? "";
    startTransition(() => {
      if (q) {
        router.push(`${pathname}?search=${encodeURIComponent(q)}&page=1`);
      } else {
        router.push(pathname);
      }
    });
  }

  function handleClear() {
    if (inputRef.current) inputRef.current.value = "";
    startTransition(() => router.push(pathname));
  }

  return (
    <form onSubmit={handleSubmit} className="relative flex items-center">
      <Search className="absolute left-2.5 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
      <input
        ref={inputRef}
        type="search"
        name="search"
        defaultValue={defaultValue}
        placeholder="搜索消息…"
        className="h-8 w-48 rounded-md border border-slate-200 bg-white pl-8 pr-8 text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 transition-colors"
        disabled={isPending}
      />
      {defaultValue && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute right-2 text-slate-400 hover:text-slate-600 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </form>
  );
}
