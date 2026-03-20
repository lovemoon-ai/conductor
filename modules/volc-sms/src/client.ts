import { sign, type SignerConfig } from "./signer.ts";

const HOST = "sms.volcengineapi.com";
const VERSION = "2020-01-01";

export interface SmsClientConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

export interface SendSmsRequest {
  smsAccount: string;
  sign: string;
  templateId: string;
  templateParam?: Record<string, string>;
  phoneNumbers: string | string[];
  tag?: string;
}

export interface SendSmsResponse {
  ResponseMetadata: {
    RequestId: string;
    Action: string;
    Version: string;
    Service: string;
    Region: string;
    Error?: { Code: string; Message: string };
  };
  Result?: {
    MessageID: string[];
  };
}

export class SmsClient {
  private config: SignerConfig;

  constructor(config: SmsClientConfig) {
    this.config = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region || "cn-north-1",
      service: "volcSMS",
    };
  }

  async sendSms(req: SendSmsRequest): Promise<SendSmsResponse> {
    const body = JSON.stringify({
      SmsAccount: req.smsAccount,
      Sign: req.sign,
      TemplateID: req.templateId,
      TemplateParam: req.templateParam
        ? JSON.stringify(req.templateParam)
        : undefined,
      PhoneNumbers: Array.isArray(req.phoneNumbers)
        ? req.phoneNumbers.join(",")
        : req.phoneNumbers,
      Tag: req.tag,
    });

    const query = { Action: "SendSms", Version: VERSION };
    const headers: Record<string, string> = {
      host: HOST,
      "content-type": "application/json; charset=utf-8",
    };

    const signedHeaders = sign(
      this.config,
      "POST",
      "/",
      query,
      headers,
      body
    );

    const queryString = `Action=${query.Action}&Version=${query.Version}`;
    const url = `https://${HOST}/?${queryString}`;

    const res = await fetch(url, {
      method: "POST",
      headers: signedHeaders,
      body,
    });

    return res.json() as Promise<SendSmsResponse>;
  }
}
