import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  const { mediaId } = await params;
  const id = parseInt(mediaId, 10);

  if (isNaN(id)) {
    return new NextResponse("Invalid media ID", { status: 400 });
  }

  const media = await prisma.media.findUnique({
    where: { mediaId: id },
    select: { data: true, contentType: true },
  });

  if (!media || !media.data) {
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(media.data, {
    headers: {
      "Content-Type": media.contentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
