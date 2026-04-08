interface BuildMediaAssetUrlParams {
  mediaId: number;
  dataHash: string | null;
  createdAt: Date;
}

export function buildMediaAssetUrl({
  mediaId,
  dataHash,
  createdAt,
}: BuildMediaAssetUrlParams): string {
  const version = dataHash ?? String(createdAt.getTime());
  return `/api/media/${mediaId}?v=${encodeURIComponent(version)}`;
}
