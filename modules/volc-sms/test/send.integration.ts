import { SmsClient } from "../src/client.ts";
import { loadEnv } from "./env.ts";

const env = loadEnv();
const phoneNumbers = process.env.CONDUCTOR_PHONE?.trim();

if (!phoneNumbers) {
  throw new Error("CONDUCTOR_PHONE is required for send.integration.ts");
}

const client = new SmsClient({
  accessKeyId: env.VOLC_ACCESS_KEY_ID,
  secretAccessKey: env.VOLC_SECRET_ACCESS_KEY,
});

const response = await client.sendSms({
  smsAccount: "8882eafa",
  sign: "北京爱喜当月",
  templateId: "S1T_1y2p2n541p2pu",
  templateParam: { code: "123456" },
  phoneNumbers,
});

console.log(JSON.stringify(response, null, 2));
