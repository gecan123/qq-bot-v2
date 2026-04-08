import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildMediaAssetUrl } from "./media-url";

describe("buildMediaAssetUrl", () => {
  test("appends a version derived from data hash", () => {
    assert.equal(
      buildMediaAssetUrl({
        mediaId: 31,
        dataHash: "abc123def456",
        createdAt: new Date("2026-04-07T06:14:49.751Z"),
      }),
      "/api/media/31?v=abc123def456",
    );
  });

  test("falls back to createdAt timestamp when data hash is missing", () => {
    assert.equal(
      buildMediaAssetUrl({
        mediaId: 34,
        dataHash: null,
        createdAt: new Date("2026-04-07T06:21:52.357Z"),
      }),
      "/api/media/34?v=1775542912357",
    );
  });
});
