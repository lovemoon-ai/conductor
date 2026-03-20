// Alipay SDK - dynamically imported to avoid build issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let alipayInstance: any = null;

export async function getAlipay() {
  if (alipayInstance) return alipayInstance;

  const alipayAppId = process.env.ALIPAY_APP_ID;
  const alipayPrivateKey = process.env.ALIPAY_PRIVATE_KEY;
  const alipayPublicKey = process.env.ALIPAY_PUBLIC_KEY;

  if (!alipayAppId || !alipayPrivateKey || !alipayPublicKey) {
    return null;
  }

  try {
    const { AlipaySdk } = await import("alipay-sdk");
    alipayInstance = new AlipaySdk({
      appId: alipayAppId,
      privateKey: alipayPrivateKey,
      alipayPublicKey: alipayPublicKey,
      signType: "RSA2",
      gateway: "https://openapi.alipay.com/gateway.do",
    });
    return alipayInstance;
  } catch {
    return null;
  }
}
