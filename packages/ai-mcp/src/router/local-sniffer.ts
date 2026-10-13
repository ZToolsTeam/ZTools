import { SniffedLocalProvider, SniffResult, ModelProviderConfig, SniffOptions } from '../types/ai.js';

/**
 * 自动嗅探本地运行的 Ollama 服务
 */
export async function sniffOllama(
  baseUrl: string = 'http://127.0.0.1:11434',
  timeoutMs: number = 1500
): Promise<SniffedLocalProvider> {
  const normalizedUrl = baseUrl.replace(/\/+$/, '');
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(`${normalizedUrl}/api/tags`, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timer);

    const latencyMs = Date.now() - startTime;

    if (!res.ok) {
      return {
        type: 'ollama',
        url: normalizedUrl,
        online: false,
        latencyMs,
        models: [],
        error: `HTTP ${res.status}: ${res.statusText}`
      };
    }

    const data = await res.json() as { models?: Array<{ name?: string; model?: string }> };
    const models: string[] = [];
    if (Array.isArray(data?.models)) {
      for (const m of data.models) {
        const name = m.name || m.model;
        if (name) models.push(name);
      }
    }

    // 尝试获取版本信息
    let version: string | undefined;
    try {
      const vRes = await fetch(`${normalizedUrl}/api/version`, { method: 'GET' });
      if (vRes.ok) {
        const vData = await vRes.json() as { version?: string };
        version = vData.version;
      }
    } catch {
      // 忽略版本探测次要异常
    }

    return {
      type: 'ollama',
      url: normalizedUrl,
      online: true,
      version,
      latencyMs,
      models
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      type: 'ollama',
      url: normalizedUrl,
      online: false,
      latencyMs,
      models: [],
      error: errorMsg.includes('abort') ? 'Connection timed out' : errorMsg
    };
  }
}

/**
 * 自动嗅探本地运行的 LM Studio 服务 (OpenAI 兼容端点)
 */
export async function sniffLMStudio(
  baseUrl: string = 'http://127.0.0.1:1234',
  timeoutMs: number = 1500
): Promise<SniffedLocalProvider> {
  const normalizedUrl = baseUrl.replace(/\/+$/, '');
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(`${normalizedUrl}/v1/models`, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timer);

    const latencyMs = Date.now() - startTime;

    if (!res.ok) {
      return {
        type: 'lmstudio',
        url: normalizedUrl,
        online: false,
        latencyMs,
        models: [],
        error: `HTTP ${res.status}: ${res.statusText}`
      };
    }

    const data = await res.json() as { data?: Array<{ id?: string }> };
    const models: string[] = [];
    if (Array.isArray(data?.data)) {
      for (const m of data.data) {
        if (m.id) models.push(m.id);
      }
    }

    return {
      type: 'lmstudio',
      url: normalizedUrl,
      online: true,
      latencyMs,
      models
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      type: 'lmstudio',
      url: normalizedUrl,
      online: false,
      latencyMs,
      models: [],
      error: errorMsg.includes('abort') ? 'Connection timed out' : errorMsg
    };
  }
}

/**
 * 并发探测本地 Ollama 与 LM Studio 服务
 */
export async function sniffLocalProviders(options: SniffOptions = {}): Promise<SniffResult> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const ollamaUrl = options.ollamaUrl ?? 'http://127.0.0.1:11434';
  const lmStudioUrl = options.lmStudioUrl ?? 'http://127.0.0.1:1234';

  const [ollama, lmStudio] = await Promise.all([
    sniffOllama(ollamaUrl, timeoutMs),
    sniffLMStudio(lmStudioUrl, timeoutMs)
  ]);

  const allOnline: SniffedLocalProvider[] = [];
  if (ollama.online) allOnline.push(ollama);
  if (lmStudio.online) allOnline.push(lmStudio);

  return {
    ollama,
    lmStudio,
    allOnline
  };
}

/**
 * 将探测到的本地 Provider 转化为标准 ModelProviderConfig
 */
export function createLocalProviderConfig(sniffed: SniffedLocalProvider): ModelProviderConfig {
  if (sniffed.type === 'ollama') {
    return {
      id: 'local-ollama',
      name: `Ollama (${sniffed.version || 'Local'})`,
      type: 'ollama',
      baseUrl: `${sniffed.url}/v1`,
      models: sniffed.models,
      defaultModel: sniffed.models.length > 0 ? sniffed.models[0] : 'llama3:latest'
    };
  }

  return {
    id: 'local-lmstudio',
    name: 'LM Studio (Local)',
    type: 'lmstudio',
    baseUrl: `${sniffed.url}/v1`,
    models: sniffed.models,
    defaultModel: sniffed.models.length > 0 ? sniffed.models[0] : 'default'
  };
}
