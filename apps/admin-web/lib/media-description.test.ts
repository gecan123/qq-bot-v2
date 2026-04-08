import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatMediaDescriptionRaw, getMediaDescriptionContent } from "./media-description";

describe("media-description", () => {
  test("extracts readable content from stringified json descriptions", () => {
    const value = JSON.stringify({
      summary: "一只橘猫趴在窗边晒太阳，神态放松。",
      ocrText: "窗外天气晴朗",
    });

    const content = getMediaDescriptionContent(value);

    assert.equal(content.summary, "一只橘猫趴在窗边晒太阳，神态放松。");
    assert.deepEqual(content.details, ["窗外天气晴朗"]);
    assert.equal(content.fullText, "一只橘猫趴在窗边晒太阳，神态放松。\n\n窗外天气晴朗");
  });

  test("creates a short summary for long descriptions while preserving the full text", () => {
    const longDescription =
      "画面中是一间明亮的咖啡馆，前景摆着一杯拿铁和一本摊开的书，靠窗位置坐着两个人正在交谈，背景还能看到绿植、吊灯和街景，整体氛围安静而温暖，像是在下午时分拍摄的生活方式照片。";

    const content = getMediaDescriptionContent({
      description: longDescription,
    });

    assert.notEqual(content.summary, longDescription);
    assert.match(content.summary ?? "", /^画面中是一间明亮的咖啡馆/);
    assert.deepEqual(content.details, [longDescription]);
    assert.equal(content.fullText, longDescription);
  });

  test("formats raw description json for dialog display", () => {
    const objectValue = {
      summary: "咖啡馆场景",
      tags: ["indoor", "latte"],
    };

    assert.equal(
      formatMediaDescriptionRaw(objectValue),
      JSON.stringify(objectValue, null, 2),
    );
    assert.equal(
      formatMediaDescriptionRaw(JSON.stringify(objectValue)),
      JSON.stringify(objectValue, null, 2),
    );
  });
});
