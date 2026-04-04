import { type NextRequest, NextResponse } from "next/server";

const BOT_API_URL = process.env.BOT_API_URL ?? "http://localhost:3101";

interface Params {
  params: Promise<{ path: string[] }>;
}

async function proxyRequest(req: NextRequest, params: Params): Promise<NextResponse> {
  const { path } = await params.params;
  const targetUrl = `${BOT_API_URL}/${path.join("/")}`;

  const headers = new Headers();
  headers.set("Content-Type", "application/json");

  let body: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.text();
  }

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers,
    body,
  });

  const data = await upstream.json();
  return NextResponse.json(data, { status: upstream.status });
}

export async function GET(req: NextRequest, params: Params) {
  return proxyRequest(req, params);
}

export async function POST(req: NextRequest, params: Params) {
  return proxyRequest(req, params);
}
