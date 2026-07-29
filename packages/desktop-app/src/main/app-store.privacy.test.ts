import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  userData: "",
  decryptString: vi.fn(() => "sk-test-example"),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPath: () => electronState.userData,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    decryptString: electronState.decryptString,
    encryptString: vi.fn((value: string) => Buffer.from(value)),
  },
}));

import {
  applyCodeAgentProviderCredentialsToEnv,
  getCodeAgentProviderSettingsStatus,
  loadCodeAgentProviderCredentials,
  loadRemoteConnectorSettings,
} from "./app-store";

describe("desktop privacy-safe status reads", () => {
  beforeEach(() => {
    electronState.userData = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-native-privacy-"),
    );
    electronState.decryptString.mockClear();
    fs.writeFileSync(
      path.join(electronState.userData, "code-agent-providers.json"),
      JSON.stringify({
        version: 1,
        credentials: {
          BUILDER_PRIVATE_KEY: {
            encoding: "safeStorage-v1",
            value: "ZmFrZQ==",
          },
          BUILDER_PUBLIC_KEY: {
            encoding: "safeStorage-v1",
            value: "ZmFrZQ==",
          },
        },
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(electronState.userData, { recursive: true, force: true });
  });

  it("reports saved provider keys without unlocking Keychain", () => {
    const status = getCodeAgentProviderSettingsStatus();

    expect(status.configuredProviders).toContain("Builder.io");
    expect(electronState.decryptString).not.toHaveBeenCalled();
  });

  it("unlocks saved keys only for an explicit credential load", () => {
    loadCodeAgentProviderCredentials();
    expect(electronState.decryptString).toHaveBeenCalledTimes(2);
  });

  it("defaults the background connector to disabled", () => {
    expect(loadRemoteConnectorSettings()).toEqual({ enabled: false });
  });

  it("injects a decrypted saved key into process.env so the provider gate passes", () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    fs.writeFileSync(
      path.join(electronState.userData, "code-agent-providers.json"),
      JSON.stringify({
        version: 1,
        credentials: {
          ANTHROPIC_API_KEY: { encoding: "safeStorage-v1", value: "ZmFrZQ==" },
        },
      }),
    );

    try {
      const result = applyCodeAgentProviderCredentialsToEnv();

      // Regression: apply must actually mutate process.env, not merely report it.
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-test-example");
      expect(result.ok).toBe(true);
      expect(result.appliedKeys).toContain("ANTHROPIC_API_KEY");
      expect(result.failedKeys).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});
