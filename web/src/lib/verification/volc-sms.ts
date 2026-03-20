import crypto from "crypto";

const HOST = "sms.volcengineapi.com";
const VERSION = "2020-01-01";

const accessKeyId = process.env.VOLC_ACCESS_KEY_ID;
const secretAccessKey = process.env.VOLC_SECRET_ACCESS_KEY;
const smsAccount = process.env.VOLC_SMS_ACCOUNT;
const signName = process.env.VOLC_SMS_SIGN_NAME;
const templateId = process.env.VOLC_SMS_TEMPLATE_ID;
const templateIdOverseas = process.env.VOLC_SMS_TEMPLATE_ID_OVERSEAS;

function hmacSha256(data: string, key: string | Buffer, encoding?: "hex"): string | Buffer {
  const hmac = crypto.createHmac("sha256", typeof key === "string" ? Buffer.from(key, "utf8") : key);
  hmac.update(data);
  return encoding ? hmac.digest(encoding) : hmac.digest();
}

function sign(method: string, path: string, query: Record<string, string>, headers: Record<string, string>, body: string): Record<string, string> {
  const region = "cn-north-1";
  const service = "volcSMS";
  const now = new Date();
  const xDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const shortDate = xDate.slice(0, 8);

  const signedHeaders = ["content-type", "host", "x-content-sha256", "x-date"];
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");

  const newHeaders: Record<string, string> = { ...headers, "x-date": xDate, "x-content-sha256": bodyHash };

  const canonicalHeaders = signedHeaders.map((k) => `${k}:${newHeaders[k].trim()}`).join("\n");
  const queryString = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join("&");

  const canonicalRequest = [method, path, queryString, canonicalHeaders + "\n", signedHeaders.join(";"), bodyHash].join("\n");
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ["HMAC-SHA256", xDate, credentialScope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");

  const kDate = hmacSha256(shortDate, secretAccessKey!);
  const kRegion = hmacSha256(region, kDate);
  const kService = hmacSha256(service, kRegion);
  const kSigning = hmacSha256("request", kService);
  const signature = hmacSha256(stringToSign, kSigning, "hex") as string;

  return { ...newHeaders, Authorization: `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}` };
}

export async function sendVerificationSms(phone: string, code: string, countryCode: string = "+86") {
  // Determine if this is an overseas number (not +86)
  const isOverseas = countryCode !== "+86";
  const selectedTemplateId = isOverseas ? templateIdOverseas : templateId;

  if (!accessKeyId || !secretAccessKey || !smsAccount || !signName || !selectedTemplateId) {
    console.log(`[DEV] SMS verification code for ${countryCode}${phone}: ${code}`);
    return;
  }

  // Format phone number: for overseas, include country code without +
  const formattedPhone = isOverseas ? `${countryCode.replace("+", "")}${phone}` : phone;

  const body = JSON.stringify({
    SmsAccount: smsAccount,
    Sign: signName,
    TemplateID: selectedTemplateId,
    TemplateParam: JSON.stringify({ code }),
    PhoneNumbers: formattedPhone,
  });

  const query = { Action: "SendSms", Version: VERSION };
  const headers: Record<string, string> = { host: HOST, "content-type": "application/json; charset=utf-8" };
  const signedHeaders = sign("POST", "/", query, headers, body);

  const url = `https://${HOST}/?Action=${query.Action}&Version=${query.Version}`;
  const res = await fetch(url, { method: "POST", headers: signedHeaders, body });
  const result = await res.json();

  if (result.ResponseMetadata?.Error) {
    console.error("[VOLC SMS Error]", result.ResponseMetadata.Error);
    throw new Error(result.ResponseMetadata.Error.Message || "SMS send failed");
  }
}
