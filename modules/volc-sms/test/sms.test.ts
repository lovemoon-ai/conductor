import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { sign } from "../src/signer.ts";
import { SmsClient } from "../src/client.ts";

describe("sign", () => {
  it("should generate valid authorization header", () => {
    const fixedDate = new Date("2024-01-15T10:30:00.000Z");
    mock.timers.enable({ apis: ["Date"], now: fixedDate });

    const headers = sign(
      { accessKeyId: "AK123", secretAccessKey: "SK456" },
      "POST",
      "/",
      { Action: "SendSms", Version: "2020-01-01" },
      { host: "sms.volcengineapi.com", "content-type": "application/json" },
      '{"test":"data"}'
    );

    mock.timers.reset();

    assert.ok(headers.Authorization.startsWith("HMAC-SHA256 Credential=AK123/"));
    assert.ok(headers.Authorization.includes("SignedHeaders=content-type;host;x-content-sha256;x-date"));
    assert.ok(headers.Authorization.includes("Signature="));
    assert.strictEqual(headers["x-date"], "20240115T103000Z");
    assert.ok(headers["x-content-sha256"]);
  });
});

describe("SmsClient", () => {
  it("should construct request body correctly", async () => {
    let capturedBody: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ ResponseMetadata: { RequestId: "test" } }));
    };

    const client = new SmsClient({ accessKeyId: "AK", secretAccessKey: "SK" });
    await client.sendSms({
      smsAccount: "acc",
      sign: "签名",
      templateId: "TPL001",
      templateParam: { code: "1234" },
      phoneNumbers: ["13000000000", "13100000000"],
    });

    globalThis.fetch = originalFetch;

    const body = JSON.parse(capturedBody!);
    assert.strictEqual(body.SmsAccount, "acc");
    assert.strictEqual(body.Sign, "签名");
    assert.strictEqual(body.TemplateID, "TPL001");
    assert.strictEqual(body.TemplateParam, '{"code":"1234"}');
    assert.strictEqual(body.PhoneNumbers, "13000000000,13100000000");
  });
});
