import { Resend } from "resend";

const resendApiKey = process.env.RESEND_API_KEY;

export const resend = resendApiKey ? new Resend(resendApiKey) : null;

export async function sendVerificationEmail(email: string, code: string) {
  if (!resend) {
    console.log(`[DEV] Email verification code for ${email}: ${code}`);
    return;
  }

  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || "noreply@example.com",
    to: email,
    subject: "Your verification code",
    text: `Your verification code is: ${code}`,
  });
}
