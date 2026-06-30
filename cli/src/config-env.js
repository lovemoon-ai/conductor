export function envForExplicitConfigFile(configFile, env = process.env) {
  if (!configFile) return env;

  const configEnv = { ...env };
  delete configEnv.CONDUCTOR_AGENT_TOKEN;
  delete configEnv.CONDUCTOR_BACKEND_URL;
  delete configEnv.CONDUCTOR_WS_URL;
  delete configEnv.CONDUCTOR_BACKEND_WS_URL;
  return configEnv;
}
