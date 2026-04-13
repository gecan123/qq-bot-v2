"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard,
  MessageSquare,
  Image,
  ChevronLeft,
  ChevronRight,
  Bot,
  FlaskConical,
  FileSearch,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const navItems = [
  { href: "/", icon: LayoutDashboard, label: "概览" },
  { href: "/groups", icon: MessageSquare, label: "群组" },
  { href: "/media", icon: Image, label: "媒体库" },
  { href: "/llm-traces", icon: FileSearch, label: "LLM Traces" },
  { href: "/playground", icon: FlaskConical, label: "Playground" },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex flex-col border-r border-slate-200 bg-white transition-[width] duration-200",
          collapsed ? "w-16" : "w-56"
        )}
      >
        {/* Logo */}
        <div className={cn(
          "flex h-14 items-center border-b border-slate-200 px-3 gap-2.5",
          collapsed && "justify-center"
        )}>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600">
            <Bot className="h-4 w-4" />
          </div>
          {!collapsed && (
            <span className="font-semibold text-sm text-slate-800 tracking-tight whitespace-nowrap">
              QQ Bot Admin
            </span>
          )}
        </div>

        {/* Nav */}
        <nav className="flex flex-col gap-1 p-2 flex-1">
          {navItems.map(({ href, icon: Icon, label }) => {
            const isActive =
              href === "/" ? pathname === "/" : pathname.startsWith(href);

            const link = (
              <Link
                key={href}
                href={href}
                className={cn(
                  "sidebar-link",
                  collapsed ? "justify-center px-2" : "",
                  isActive ? "sidebar-link-active" : "sidebar-link-inactive"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span>{label}</span>}
              </Link>
            );

            return collapsed ? (
              <Tooltip key={href}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">
                  {label}
                </TooltipContent>
              </Tooltip>
            ) : (
              link
            );
          })}
        </nav>

        {/* Collapse toggle */}
        <div className="p-2 border-t border-slate-200">
          <button
            onClick={() => setCollapsed((c) => !c)}
            className={cn(
              "sidebar-link sidebar-link-inactive w-full",
              collapsed ? "justify-center px-2" : "justify-between"
            )}
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            {!collapsed && <span className="text-xs">收起</span>}
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
