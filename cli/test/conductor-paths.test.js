import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  materializeConductorPathEnv,
  resolveConductorConfigPath,
  resolveConductorHome,
} from "../src/conductor-paths.js";

describe("conductor paths", () => {
  it("defaults to the .conductor directory under the user home", () => {
    assert.equal(
      resolveConductorHome({ HOME: "/tmp/user-home" }),
      path.resolve("/tmp/user-home/.conductor"),
    );
  });

  it("uses CONDUCTOR_HOME as the complete user data directory", () => {
    assert.equal(
      resolveConductorHome({ HOME: "/tmp/user-home", CONDUCTOR_HOME: "/tmp/custom-conductor" }),
      path.resolve("/tmp/custom-conductor"),
    );
    assert.equal(
      resolveConductorConfigPath(undefined, {
        HOME: "/tmp/user-home",
        CONDUCTOR_HOME: "/tmp/custom-conductor",
      }),
      path.resolve("/tmp/custom-conductor/config.yaml"),
    );
  });

  it("expands a tilde in CONDUCTOR_HOME against the real user home", () => {
    assert.equal(
      resolveConductorHome({ HOME: "/tmp/user-home", CONDUCTOR_HOME: "~/profiles/work" }),
      path.resolve("/tmp/user-home/profiles/work"),
    );
  });

  it("gives explicit config and CONDUCTOR_CONFIG precedence over CONDUCTOR_HOME", () => {
    const env = {
      HOME: "/tmp/user-home",
      CONDUCTOR_HOME: "/tmp/custom-conductor",
      CONDUCTOR_CONFIG: "/tmp/env-config.yaml",
    };
    assert.equal(resolveConductorConfigPath(undefined, env), path.resolve("/tmp/env-config.yaml"));
    assert.equal(
      resolveConductorConfigPath("/tmp/explicit-config.yaml", env),
      path.resolve("/tmp/explicit-config.yaml"),
    );
  });

  it("materializes relative paths before they cross a process cwd boundary", () => {
    const resolved = materializeConductorPathEnv("configs/daemon.yaml", {
      HOME: "/tmp/user-home",
      CONDUCTOR_HOME: "profiles/a",
      CONDUCTOR_CONFIG: "ignored.yaml",
    });

    assert.deepEqual(resolved, {
      CONDUCTOR_HOME: path.resolve("profiles/a"),
      CONDUCTOR_CONFIG: path.resolve("configs/daemon.yaml"),
    });
    assert.equal(path.isAbsolute(resolved.CONDUCTOR_HOME), true);
    assert.equal(path.isAbsolute(resolved.CONDUCTOR_CONFIG), true);
  });

  it("ignores blank overrides", () => {
    assert.equal(
      resolveConductorConfigPath(undefined, {
        HOME: "/tmp/user-home",
        CONDUCTOR_HOME: "  ",
        CONDUCTOR_CONFIG: "  ",
      }),
      path.resolve("/tmp/user-home/.conductor/config.yaml"),
    );
  });
});
