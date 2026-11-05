/** Shared runtimes and browser workers must not retain a fire task's identity. */
export function runtimeProcessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !/^CONDUCTOR_/i.test(key)));
}
