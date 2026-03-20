# @conductor/volc-sms

Volcengine SMS SDK.

## Install

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env`, then fill in your Volcengine credentials:

```bash
cp .env.example .env
```

```env
VOLC_ACCESS_KEY_ID=your_access_key_id
VOLC_SECRET_ACCESS_KEY=your_secret_access_key
```

## Usage

```typescript
import { SmsClient } from "@conductor/volc-sms";

const client = new SmsClient({
  accessKeyId: "your_access_key_id",
  secretAccessKey: "your_secret_access_key",
});

const response = await client.sendSms({
  smsAccount: "message_group_id",
  sign: "sign_name",
  templateId: "template_id",
  templateParam: { code: "123456" },
  phoneNumbers: "13000000000",
});
```

## Tests

Unit tests:

```bash
npm test
```

Integration test (sends a real SMS):

```bash
node --experimental-strip-types test/send.integration.ts
```
