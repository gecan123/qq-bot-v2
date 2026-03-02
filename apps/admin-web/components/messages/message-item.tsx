import { Reply, FileText, Video, Mic, File } from "lucide-react";
import type { MessageRow } from "@/lib/queries";
import type { ParsedSegment } from "@/lib/message-segments";

function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });
}

function SegmentRenderer({ seg }: { seg: ParsedSegment }) {
  switch (seg.type) {
    case "text":
      return <span className="whitespace-pre-wrap break-words">{seg.content}</span>;

    case "image":
      if (seg.referenceId) {
        return (
          <span className="inline-block align-middle">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/media/${seg.referenceId}`}
              alt={seg.summary ?? seg.fileName ?? "图片"}
              className="max-h-48 max-w-xs rounded-md object-contain border border-slate-200"
              loading="lazy"
            />
          </span>
        );
      }
      if (seg.url) {
        return (
          <span className="inline-block align-middle">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={seg.url}
              alt={seg.summary ?? seg.fileName ?? "图片"}
              className="max-h-48 max-w-xs rounded-md object-contain border border-slate-200"
              loading="lazy"
            />
          </span>
        );
      }
      return (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-slate-100 text-slate-500 text-xs">
          <FileText className="h-3 w-3" />
          {seg.fileName ?? "[图片]"}
        </span>
      );

    case "face":
      return (
        <span className="inline-flex items-center rounded px-1 py-0.5 bg-yellow-50 text-yellow-600 text-xs border border-yellow-200">
          {seg.name ? `[${seg.name}]` : `[表情${seg.faceId}]`}
        </span>
      );

    case "at":
      return (
        <span className="text-indigo-600 font-medium">
          @{seg.targetName ?? seg.targetId}
        </span>
      );

    case "reply":
      return (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-slate-100 text-slate-400 text-xs border-l-2 border-slate-300">
          <Reply className="h-3 w-3" />
          回复 {seg.messageId}
        </span>
      );

    case "video":
      return (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-slate-100 text-slate-500 text-xs">
          <Video className="h-3 w-3 text-blue-500" />
          {seg.fileName ?? "[视频]"}
        </span>
      );

    case "record":
      return (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-slate-100 text-slate-500 text-xs">
          <Mic className="h-3 w-3 text-green-500" />
          {seg.fileName ?? "[语音]"}
        </span>
      );

    case "file":
      return (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-slate-100 text-slate-500 text-xs">
          <File className="h-3 w-3 text-orange-500" />
          {seg.fileName ?? "[文件]"}
        </span>
      );

    default:
      return (
        <span className="inline-flex items-center rounded px-1 py-0.5 bg-slate-100 text-slate-400 text-xs">
          [{(seg as ParsedSegment).type}]
        </span>
      );
  }
}

interface MessageItemProps {
  message: MessageRow;
}

export function MessageItem({ message }: MessageItemProps) {
  const displayName =
    message.senderGroupNickname ?? message.senderNickname ?? message.senderId;
  const initial = displayName.charAt(0).toUpperCase();
  const segments = message.content as ParsedSegment[];

  return (
    <div className="flex gap-3 py-3 group hover:bg-slate-50 px-3 -mx-3 rounded-lg transition-colors duration-100">
      {/* Avatar */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-600 text-xs font-semibold mt-0.5">
        {initial}
      </div>

      <div className="flex-1 min-w-0">
        {/* Sender + time */}
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-sm font-medium text-slate-800">{displayName}</span>
          {message.senderNickname && message.senderGroupNickname && (
            <span className="text-xs text-slate-400">({message.senderNickname})</span>
          )}
          <span className="text-xs text-slate-400 font-mono ml-auto">
            {formatDate(message.createdAt)} {formatTime(message.createdAt)}
          </span>
        </div>

        {/* Content */}
        <p className="text-sm text-slate-600 leading-relaxed">
          {segments.map((seg, i) => (
            <SegmentRenderer key={i} seg={seg} />
          ))}
        </p>
      </div>
    </div>
  );
}
