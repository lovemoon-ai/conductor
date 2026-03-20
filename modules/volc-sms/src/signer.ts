import crypto from "crypto";

export interface SignerConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  service?: string;
}

export function sign(
  config: SignerConfig,
  method: string,
  path: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  body: string
): Record<string, string> {
  const region = config.region || "cn-north-1";
  const service = config.service || "volcSMS";
  const now = new Date();
  const xDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const shortDate = xDate.slice(0, 8);

  const signedHeaders = ["content-type", "host", "x-content-sha256", "x-date"];
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");

  const newHeaders: Record<string, string> = {
    ...headers,
    "x-date": xDate,
    "x-content-sha256": bodyHash,
  };

  const canonicalHeaders = signedHeaders
    .map((k) => `${k}:${newHeaders[k].trim()}`)
    .join("\n");

  const queryString = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");

  const canonicalRequest = [
    method,
    path,
    queryString,
    canonicalHeaders + "\n",
    signedHeaders.join(";"),
    bodyHash,
  ].join("\n");

  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = [
    "HMAC-SHA256",
    xDate,
    credentialScope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const kDate = hmacSha256(shortDate, `${config.secretAccessKey}`);
  const kRegion = hmacSha256(region, kDate);
  const kService = hmacSha256(service, kRegion);
  const kSigning = hmacSha256("request", kService);
  const signature = hmacSha256(stringToSign, kSigning, "hex") as string;

  const authorization = `HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`;

  return {
    ...newHeaders,
    Authorization: authorization,
  };
}

function hmacSha256(
  data: string,
  key: string | Buffer,
  encoding?: "hex"
): string | Buffer {
  const hmac = crypto.createHmac(
    "sha256",
    typeof key === "string" ? Buffer.from(key, "utf8") : key
  );
  hmac.update(data);
  return encoding ? hmac.digest(encoding) : hmac.digest();
}
