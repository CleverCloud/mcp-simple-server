import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createTextResult } from "../src/tools/result.ts";

describe("createTextResult", () => {
  const textResult = createTextResult({ apiToken: "secret-token", maxOutputLength: 100 });
  const textOf = (text: string) => {
    const [content] = textResult(text).content;
    assert.equal(content?.type, "text");
    return content.text;
  };

  test("wraps the text in a single content block, flagged when it reports an error", () => {
    assert.deepEqual(textResult("done"), { content: [{ type: "text", text: "done" }] });
    assert.deepEqual(textResult("failed", true), {
      content: [{ type: "text", text: "failed" }],
      isError: true,
    });
  });

  test("masks the API token", () => {
    assert.equal(textOf("token: secret-token, again secret-token"), "token: [REDACTED], again [REDACTED]");
  });

  test("cuts the text to the output budget, truncation notice included", () => {
    const text = textOf("x".repeat(1000));
    assert.equal(text.length, 100);
    assert.match(text, /^x+\n\n\.\.\. \(truncated to the 100 characters output budget\)$/);
  });

  test("stays within a budget smaller than the truncation notice", () => {
    const [content] = createTextResult({ apiToken: "secret-token", maxOutputLength: 10 })("x".repeat(100)).content;
    assert.equal(content?.type === "text" && content.text.length, 10);
  });

  test("masks the token before cutting, so a cut cannot reveal part of it", () => {
    const text = textOf(`${"x".repeat(20)}secret-token${"x".repeat(1000)}`);
    assert.ok(!text.includes("secret"));
    assert.ok(text.includes("[REDACTED]"));
  });
});
