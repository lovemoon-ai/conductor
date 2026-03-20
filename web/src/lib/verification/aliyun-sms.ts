import Dysmsapi20170525, * as $Dysmsapi20170525 from "@alicloud/dysmsapi20170525";
import * as $OpenApi from "@alicloud/openapi-client";

const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
const signName = process.env.ALIYUN_SMS_SIGN_NAME;
const templateCode = process.env.ALIYUN_SMS_TEMPLATE_CODE;

let client: Dysmsapi20170525 | null = null;

if (accessKeyId && accessKeySecret) {
  const config = new $OpenApi.Config({
    accessKeyId,
    accessKeySecret,
    endpoint: "dysmsapi.aliyuncs.com",
  });
  client = new Dysmsapi20170525(config);
}

export async function sendVerificationSms(phone: string, code: string) {
  if (!client || !signName || !templateCode) {
    console.log(`[DEV] SMS verification code for ${phone}: ${code}`);
    return;
  }

  const request = new $Dysmsapi20170525.SendSmsRequest({
    phoneNumbers: phone,
    signName,
    templateCode,
    templateParam: JSON.stringify({ code }),
  });

  await client.sendSms(request);
}
