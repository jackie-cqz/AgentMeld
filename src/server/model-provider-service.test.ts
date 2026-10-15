import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests } from "@/db/client";
import { GET, POST, PATCH, DELETE } from "@/app/api/model-providers/route";
import { POST as testConnection } from "@/app/api/settings/test-connection/route";
import { POST as createAgentApi } from "@/app/api/agents/route";
import { createAgent, deleteAgent } from "@/server/agent-service";
import { listModelProviderProfiles, requireModelProviderProfile, saveModelProviderProfile } from "@/server/model-provider-service";
import { getSettings, resolveApiKey } from "@/server/settings-service";
import { resolveProviderBaseUrl } from "@/server/provider-endpoints";
import { PROVIDER_PRESETS, findProviderPreset, profileProviderId } from "@/shared/provider-presets";
import { modelProviderSchema, providerBaseUrlSchema } from "@/shared/model-provider-schema";

let tempDir: string;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-provider-profiles-"));
  vi.stubEnv("AGENTMELD_DATA_DIR", tempDir);
  vi.stubEnv("GLM_API_KEY", "");
  vi.stubEnv("GLM_PLAN_API_KEY", "");
  resetBootstrapForTests(); resetDatabaseForTests(); ensureDatabase();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetBootstrapForTests(); resetDatabaseForTests(); vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
const input = () => ({ name: "GLM 国内", presetId: "glm-cn", protocol: "chat-completions" as const,
  baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-5.2", models: ["glm-5.2", "glm-4.7"], apiKey: "test-profile-private-secret" });
const request = (method: string, body: unknown) => new Request("http://localhost/api/model-providers", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("provider profiles", () => {
  it("bootstraps and persists profiles across database reopen without returning credentials", async () => {
    const response = await POST(request("POST", input()));
    expect(response.status).toBe(201);
    const { provider } = await response.json();
    expect(provider.id).toMatch(/^mp_[\w-]{12}$/);
    expect(provider.credentialSource).toBe("app_settings");
    resetBootstrapForTests(); resetDatabaseForTests();
    const result = await (await GET()).json();
    expect(result.providers).toEqual([provider]);
    expect(JSON.stringify(result)).not.toContain(input().apiKey);
    expect(result.providers[0]).not.toHaveProperty("apiKey");
  });

  it("retains a saved key on edits and keeps an agent reference attached", async () => {
    const profile = saveModelProviderProfile(input());
    const agent = createAgent({ name: "Test Profile", adapterName: "custom", modelProvider: profileProviderId(profile.id), modelId: profile.defaultModel, toolNames: [] });
    const fields = { ...input(), apiKey: undefined };
    const response = await PATCH(request("PATCH", { ...fields, id: profile.id, name: "Edited", defaultModel: "glm-4.7" }));
    expect(response.status).toBe(200);
    expect(requireModelProviderProfile(profile.id).apiKey).toBe(input().apiKey);
    expect(listModelProviderProfiles()[0]).toMatchObject({ name: "Edited", agentCount: 1 });
    expect(resolveApiKey(agent.modelProvider!, null, getSettings())).toBe(input().apiKey);
  });

  it("isolates different regional/plan configurations and supports multiple instances", () => {
    const first = saveModelProviderProfile(input());
    const second = saveModelProviderProfile({ ...input(), name: "Plan", presetId: "glm-coding-plan-cn", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", apiKey: "plan-secret" });
    expect(first.id).not.toBe(second.id);
    expect(resolveApiKey(profileProviderId(second.id), null, getSettings())).toBe("plan-secret");
    expect(resolveApiKey(profileProviderId(first.id), null, getSettings())).toBe(input().apiKey);
    expect(resolveApiKey(profileProviderId(first.id), "agent-override", getSettings())).toBe("agent-override");
    expect(resolveProviderBaseUrl(profileProviderId(second.id))).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
    expect(resolveProviderBaseUrl(profileProviderId(first.id), "https://override.example/v2")).toBe("https://override.example/v2");
  });

  it("allows only preset-scoped environment fallback and reports it without the secret", async () => {
    vi.stubEnv("GLM_API_KEY", "private-env-key");
    const fields = { ...input(), apiKey: undefined };
    const profile = saveModelProviderProfile(fields);
    expect(profile.credentialSource).toBe("environment");
    expect(resolveApiKey(profileProviderId(profile.id), null, getSettings())).toBe("private-env-key");
    const result = await (await GET()).json();
    expect(result.environmentPresets).toContain("glm-cn");
    expect(result.environmentPresets).not.toContain("glm-coding-plan-cn");
    expect(JSON.stringify(result)).not.toContain("private-env-key");
    vi.stubEnv("GLM_API_KEY", "");
    expect(listModelProviderProfiles()[0].credentialSource).toBe("missing");
    expect(resolveApiKey(profileProviderId(profile.id), null, getSettings())).toBeNull();
    expect(() => saveModelProviderProfile({ ...fields, presetId: null })).toThrow("API Key");
  });

  it("refuses deletion of an in-use profile, then permits deletion after reassignment", async () => {
    const profile = saveModelProviderProfile(input());
    const agent = createAgent({ name: "Using Profile", adapterName: "custom", modelProvider: profileProviderId(profile.id), modelId: profile.defaultModel, toolNames: [] });
    expect((await DELETE(request("DELETE", { id: profile.id }))).status).toBe(409);
    expect(listModelProviderProfiles()).toHaveLength(1);
    deleteAgent(agent.id);
    expect((await DELETE(request("DELETE", { id: profile.id }))).status).toBe(204);
    expect(listModelProviderProfiles()).toHaveLength(0);
    // Unknown references never fall back to the public OpenAI endpoint.
    expect(() => resolveProviderBaseUrl(profileProviderId(profile.id), "https://override.example/v1")).toThrow("不存在");
    expect(() => createAgent({ name: "Stale", adapterName: "custom", modelProvider: profileProviderId(profile.id), modelId: "model" })).toThrow("不存在");
  });

  it("accepts valid references through the Agent API and rejects unknown or malformed references", async () => {
    const profile = saveModelProviderProfile(input());
    const agentInput = { name: "Via API", adapterName: "custom", modelProvider: profileProviderId(profile.id), modelId: "glm-4.7", toolNames: [] };
    const success = await createAgentApi(request("POST", agentInput));
    expect(success.status).toBe(201);
    expect((await success.json()).agent.modelProvider).toBe(profileProviderId(profile.id));
    expect((await createAgentApi(request("POST", { ...agentInput, modelProvider: "profile:mp_aaaaaaaaaaaa" }))).status).toBe(400);
    expect(modelProviderSchema.safeParse("profile:bad-id").success).toBe(false);
  });

  it.each(["javascript:alert(1)", "file:///tmp/key", "https://user:password@example.com/v1", "https://host/v1?key=secret", "https://host/v1#secret", "not-a-url"])("rejects unsafe or invalid endpoint %s", async baseUrl => {
    expect(providerBaseUrlSchema.safeParse(baseUrl).success).toBe(false);
    expect((await POST(request("POST", { ...input(), baseUrl }))).status).toBe(400);
  });

  it("rejects unknown presets, unsupported protocols, arbitrary env fields and empty credentials", async () => {
    for (const patch of [{ presetId: "unregistered" }, { protocol: "anthropic" }, { protocol: "responses" }, { envKey: "PRIVATE_SYSTEM_TOKEN" }, { apiKey: "\n" }]) {
      expect((await POST(request("POST", { ...input(), ...patch }))).status).toBe(400);
    }
    const profile = saveModelProviderProfile(input());
    expect((await PATCH(request("PATCH", { ...input(), id: profile.id, presetId: "kimi-cn" }))).status).toBe(400);
    expect((await PATCH(request("PATCH", { ...input(), id: "mp_aaaaaaaaaaaa" }))).status).toBe(400);
  });

  it("tests the actual saved endpoint, model and credential without changing settings", async () => {
    const profile = saveModelProviderProfile(input());
    const mock = vi.fn(async () => Response.json({ choices: [{ message: { content: "OK" } }] }));
    vi.stubGlobal("fetch", mock);
    const result = await testConnection(request("POST", { provider: profileProviderId(profile.id), modelId: "glm-4.7" }));
    expect(result.status).toBe(200);
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${input().baseUrl}/chat/completions`);
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${input().apiKey}`);
    expect(JSON.parse(init.body as string).model).toBe("glm-4.7");
    expect(getSettings().deepseekApiKey).toBeNull();
  });

  it("tests a not-yet-saved preset via its own environment key, not a global provider key", async () => {
    vi.stubEnv("GLM_API_KEY", "glm-env-only");
    const mock = vi.fn(async () => Response.json({ choices: [] })); vi.stubGlobal("fetch", mock);
    const result = await testConnection(request("POST", { provider: "openai-compatible", presetId: "glm-cn", apiBaseUrl: input().baseUrl, modelId: "glm-5.2" }));
    expect(result.status).toBe(200);
    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer glm-env-only");
    expect(listModelProviderProfiles()).toHaveLength(0);
  });

  it("redacts credentials if an upstream connection error echoes them", async () => {
    vi.stubGlobal("fetch", async () => new Response(input().apiKey, { status: 401 }));
    const response = await testConnection(request("POST", { provider: "openai-compatible", apiBaseUrl: input().baseUrl, apiKey: input().apiKey, modelId: "glm-5.2" }));
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain(input().apiKey);
  });

  it("keeps a unique, editable Chat Completions catalog with separate plan endpoints", () => {
    expect(new Set(PROVIDER_PRESETS.map(preset => preset.id)).size).toBe(PROVIDER_PRESETS.length);
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(28);
    for (const preset of PROVIDER_PRESETS.filter(preset => preset.id !== "custom")) {
      expect(providerBaseUrlSchema.safeParse(preset.baseUrl).success).toBe(true);
      expect(preset.models.length).toBeGreaterThan(0);
      expect(preset.models.every(model => model.length <= 100)).toBe(true);
    }
    expect(findProviderPreset("kimi-coding-plan")).toBeUndefined(); // Anthropic-only route.
    expect(findProviderPreset("glm-cn")?.baseUrl).not.toBe(findProviderPreset("glm-coding-plan-cn")?.baseUrl);
  });
});
