import { loadBootstrapEnv, parseBootstrapArgs, resolveBootstrapBaseUrl } from "./bootstrap-self-host-user-lib";

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  pnpm bootstrap:self-host --phone +8613800138000 [--base-url https://your-domain.com]",
      "",
      "Options:",
      "  --phone     Full international phone number including '+' and country code",
      "  --base-url  Optional public web URL; falls back to NEXT_PUBLIC_URL, PUBLIC_BACKEND_URL, API_BASE_URL, or http://localhost:6152",
      "",
    ].join("\n"),
  );
}

async function main() {
  loadBootstrapEnv();

  const { help, phone, baseUrl } = parseBootstrapArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }

  if (!phone?.trim()) {
    throw new Error("Missing required --phone");
  }

  const { bootstrapSelfHostUserByPhone, issueApiToken } = await import("../src/lib/auth/service");
  const bootstrap = await bootstrapSelfHostUserByPhone(phone);
  const issued = await issueApiToken(bootstrap.user.id, "self-host-bootstrap");
  const publicBaseUrl = resolveBootstrapBaseUrl(baseUrl);
  const loginUrl = new URL("/", publicBaseUrl);
  loginUrl.searchParams.set("token", issued.token);

  process.stdout.write(
    [
      "Bootstrap user ready",
      `Phone: ${bootstrap.normalizedPhone}`,
      `User ID: ${bootstrap.user.id}`,
      `Created: ${bootstrap.created ? "yes" : "no"}`,
      `Default Project: ${bootstrap.project.name}`,
      `API Token: ${issued.token}`,
      `Login URL: ${loginUrl.toString()}`,
      "",
      "Warning: treat the API token and login URL as secrets.",
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
