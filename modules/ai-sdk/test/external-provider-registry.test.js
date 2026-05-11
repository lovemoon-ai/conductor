import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getExternalProviderRegistry,
  resetExternalProviderRegistryForTests,
} from "../src/external-provider-registry.js";

function writeProviderModule(dir, name, body) {
  const filePath = path.join(dir, `${name}.js`);
  fs.writeFileSync(filePath, body, "utf8");
  return filePath;
}

async function withProviderPath(modulePath, fn) {
  const previous = process.env.AISDK_PROVIDER_PATH;
  process.env.AISDK_PROVIDER_PATH = modulePath;
  resetExternalProviderRegistryForTests();
  try {
    return await fn();
  } finally {
    resetExternalProviderRegistryForTests();
    if (previous === undefined) {
      delete process.env.AISDK_PROVIDER_PATH;
    } else {
      process.env.AISDK_PROVIDER_PATH = previous;
    }
  }
}

describe("external-provider-registry descriptor validation", () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-ext-registry-"));
  });

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("accepts descriptors that omit optional hook fields", async () => {
    const modulePath = writeProviderModule(
      tempDir,
      "minimal",
      `class S { async runTurn() { return { text: "" }; } async close() {} }
       export const providers = [{
         backend: "minimal-ext",
         variant: "minimal-ext-variant",
         async createSession(backend, options) { return new S(); },
       }];\n`,
    );

    await withProviderPath(modulePath, async () => {
      const registry = await getExternalProviderRegistry();
      const descriptor = registry.byBackend.get("minimal-ext");
      assert.ok(descriptor);
      assert.equal(descriptor.resolveResumeContext, null);
      assert.equal(descriptor.buildResumeArgs, null);
      assert.equal(descriptor.findSessionPath, null);
      assert.equal(descriptor.isSupported, null);
    });
  });

  it("preserves optional hook fields when provided as functions", async () => {
    const modulePath = writeProviderModule(
      tempDir,
      "full-hooks",
      `class S { async runTurn() { return { text: "" }; } async close() {} }
       export const providers = [{
         backend: "full-hooks-ext",
         variant: "full-hooks-variant",
         async createSession(backend, options) { return new S(); },
         async resolveResumeContext(sessionId) { return { provider: "full-hooks-ext", sessionId, cwd: process.cwd() }; },
         buildResumeArgs(sessionId) { return ["--resume", sessionId]; },
         async findSessionPath() { return null; },
         isSupported() { return true; },
       }];\n`,
    );

    await withProviderPath(modulePath, async () => {
      const registry = await getExternalProviderRegistry();
      const descriptor = registry.byBackend.get("full-hooks-ext");
      assert.ok(descriptor);
      assert.equal(typeof descriptor.resolveResumeContext, "function");
      assert.equal(typeof descriptor.buildResumeArgs, "function");
      assert.equal(typeof descriptor.findSessionPath, "function");
      assert.equal(typeof descriptor.isSupported, "function");
    });
  });

  for (const field of ["resolveResumeContext", "buildResumeArgs", "findSessionPath", "isSupported"]) {
    it(`rejects descriptors where ${field} is provided but not a function`, async () => {
      const modulePath = writeProviderModule(
        tempDir,
        `bad-${field}`,
        `class S { async runTurn() { return { text: "" }; } async close() {} }
         export const providers = [{
           backend: "bad-${field.toLowerCase()}-ext",
           variant: "bad-variant",
           async createSession(backend, options) { return new S(); },
           ${field}: "not-a-function",
         }];\n`,
      );

      await withProviderPath(modulePath, async () => {
        await assert.rejects(
          () => getExternalProviderRegistry(),
          new RegExp(`provider\\.${field} but it is not a function \\(got string\\)`),
        );
      });
    });
  }
});
