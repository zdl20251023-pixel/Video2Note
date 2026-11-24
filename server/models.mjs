import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSubtitleEncoding } from './captions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = process.env.POKER_MODELS_CONFIG || path.join(root, 'config/models.json');
const stateDirectory = process.env.POKER_MODEL_STATE_DIR || path.join(root, '.local');
const SECRET_FILE = path.join(stateDirectory, 'model-secrets.json');
const PREFS_FILE = path.join(stateDirectory, 'model-preferences.json');
const readOptional = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('模型本地设置文件无法读取，请检查 JSON 格式'); } };
let privateWrites = Promise.resolve();
async function savePrivate(file, value) {
  const next = privateWrites.catch(() => {}).then(() => writePrivate(file, value));
  privateWrites = next;
  return next;
}
async function writePrivate(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, file);
}
export function validateConfig(config) {
  if (config.version !== 1 || !Array.isArray(config.providers)) throw new Error('模型配置需要 version=1 和 providers 列表');
  const ids = new Set();
  for (const provider of config.providers) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(provider.id) || ids.has(provider.id)) throw new Error('服务商 ID 无效或重复');
    ids.add(provider.id);
    if (provider.protocol !== 'openai-chat') throw new Error(`服务商 ${provider.id} 的协议不受支持；当前支持 openai-chat`);
    const url = new URL(provider.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('模型 baseUrl 必须是无密钥、无查询参数的 HTTPS 地址');
    if (!/^[A-Z][A-Z0-9_]*$/.test(provider.apiKeyEnv)) throw new Error('apiKeyEnv 必须是环境变量名称');
    if (!provider.label || !Array.isArray(provider.models) || !provider.models.length) throw new Error('服务商需要名称与模型列表');
    if (provider.timeoutMs != null && (!Number.isInteger(provider.timeoutMs) || provider.timeoutMs < 1000 || provider.timeoutMs > 300000)) throw new Error('timeoutMs 需为 1000–300000 毫秒');
    if (provider.speech && (provider.speech.protocol !== 'deepseek-asr' || !/^\/[\w/-]+$/.test(provider.speech.path) || !Number.isInteger(provider.speech.segmentSeconds) || provider.speech.segmentSeconds < 10 || provider.speech.segmentSeconds > 120)) throw new Error('语音识别配置无效：当前支持 deepseek-asr，分段需为 10–120 秒');
    const forbidden = ['model', 'messages', 'stream', 'api_key', 'apiKey', 'headers', 'tools'];
    if (forbidden.some(key => Object.hasOwn(provider.requestDefaults || {}, key))) throw new Error('requestDefaults 不能覆盖模型、消息、鉴权或工具调用');
    const models = new Set();
    for (const model of provider.models) {
      if (typeof model.id !== 'string' || !/^[\w./:-]{1,120}$/.test(model.id) || model.id.includes('::') || models.has(model.id)) throw new Error('模型 ID 无效或重复');
      models.add(model.id);
      if (model.maxImagesPerBatch != null && (!Number.isInteger(model.maxImagesPerBatch) || model.maxImagesPerBatch < 1 || model.maxImagesPerBatch > 16)) throw new Error('maxImagesPerBatch 需为 1–16');
      if (model.maxImageBytes != null && (!Number.isInteger(model.maxImageBytes) || model.maxImageBytes < 1024 || model.maxImageBytes > 50000000)) throw new Error('maxImageBytes 需为 1024–50000000');
      if (!model.label || typeof model.vision !== 'boolean') throw new Error('模型需要名称和 vision 能力声明');
      if (!Number.isInteger(model.maxInputChars) || model.maxInputChars < 2000 || model.maxInputChars > 200000) throw new Error('maxInputChars 需为 2000–200000');
      if (!Number.isInteger(model.maxOutputTokens) || model.maxOutputTokens < 512 || model.maxOutputTokens > 32000) throw new Error('maxOutputTokens 需为 512–32000');
    }
  }
  resolveSelection(config, config.defaultSelection);
  return config;
}
export function resolveSelection(config, selection) {
  if (selection?.providerId === 'local' && selection.modelId === 'local') return null;
  const provider = config.providers.find(item => item.id === selection?.providerId && item.enabled !== false);
  const model = provider?.models.find(item => item.id === selection?.modelId);
  if (!provider || !model) throw new Error('所选模型不存在或已停用，请刷新模型配置');
  return { provider, model };
}
export async function loadConfig() {
  let value;
  try { value = JSON.parse(await readFile(CONFIG_FILE, 'utf8')); }
  catch { throw new Error('config/models.json 无法读取，请检查文件与 JSON 格式'); }
  return validateConfig(value);
}
async function keyFor(provider) {
  const secrets = await readOptional(SECRET_FILE);
  const saved = secrets.keys?.[provider.id];
  return { value: saved || process.env[provider.apiKeyEnv] || '', source: saved ? 'file' : process.env[provider.apiKeyEnv] ? 'environment' : null };
}
export async function modelCatalog() {
  const config = await loadConfig();
  const prefs = await readOptional(PREFS_FILE);
  let defaultSelection = config.defaultSelection;
  try { if (prefs.selection) { resolveSelection(config, prefs.selection); defaultSelection = prefs.selection; } } catch { /* Removed selections revert to the configured default. */ }
  const providers = [];
  for (const provider of config.providers.filter(item => item.enabled !== false)) {
    const key = await keyFor(provider);
    providers.push({ id: provider.id, label: provider.label, baseUrl: provider.baseUrl, hasKey: !!key.value, keySource: key.source, models: provider.models.map(model => ({ id: model.id, label: model.label, vision: model.vision })) });
  }
  const speechProviders = [];
  for (const provider of config.providers.filter(item => item.enabled !== false && item.speech)) speechProviders.push({ id: provider.id, label: provider.label, hasKey: !!(await keyFor(provider)).value, segmentSeconds: provider.speech.segmentSeconds });
  return { providers, speechProviders, defaultSelection, configFile: 'config/models.json' };
}
export async function snapshotSpeech(providerId = 'deepseek') {
  const provider = (await loadConfig()).providers.find(item => item.id === providerId && item.enabled !== false && item.speech);
  if (!provider) throw new Error('所选语音识别服务尚未配置');
  if (!(await keyFor(provider)).value) throw new Error(`请先配置 ${provider.label} API Key，或关闭无字幕语音识别`);
  return { providerId: provider.id, providerLabel: provider.label, apiKeyEnv: provider.apiKeyEnv, protocol: provider.speech.protocol, endpoint: new URL(provider.speech.path, provider.baseUrl).href, segmentSeconds: provider.speech.segmentSeconds, timeoutMs: Math.max(provider.timeoutMs || 120000, 120000) };
}
export async function modelCredential(snapshot) {
  return (await keyFor({ id: snapshot.providerId, apiKeyEnv: snapshot.apiKeyEnv })).value;
}
export async function savePreference(selection) {
  resolveSelection(await loadConfig(), selection);
  await savePrivate(PREFS_FILE, { selection: { providerId: selection.providerId, modelId: selection.modelId } });
}
export async function saveCredential(providerId, input) {
  const provider = (await loadConfig()).providers.find(item => item.id === providerId && item.enabled !== false);
  if (!provider) throw new Error('服务商不存在');
  const secrets = await readOptional(SECRET_FILE);
  secrets.keys ||= {};
  if (input.removeKey === true) delete secrets.keys[providerId];
  else {
    if (typeof input.apiKey !== 'string' || input.apiKey.trim().length < 6 || input.apiKey.length > 2000 || /[\r\n]/.test(input.apiKey)) throw new Error('请输入有效的 API Key');
    secrets.keys[providerId] = input.apiKey.trim();
  }
  await savePrivate(SECRET_FILE, secrets);
}
export async function snapshotModel(selection, requireKey = true) {
  const config = await loadConfig();
  const chosen = resolveSelection(config, selection || config.defaultSelection);
  if (!chosen) return null;
  const { provider, model } = chosen;
  if (requireKey && !(await keyFor(provider)).value) throw new Error(`请先在模型设置中配置 ${provider.label} 的 API Key，或选择本地整理`);
  return { providerId: provider.id, providerLabel: provider.label, modelId: model.id, modelLabel: model.label, protocol: provider.protocol, baseUrl: provider.baseUrl, apiKeyEnv: provider.apiKeyEnv, timeoutMs: provider.timeoutMs || 120000, requestDefaults: provider.requestDefaults || {}, vision: model.vision, maxInputChars: model.maxInputChars, maxOutputTokens: model.maxOutputTokens, maxImagesPerBatch: model.maxImagesPerBatch || 6, maxImageBytes: model.maxImageBytes || 12 * 1024 * 1024 };
}

// One adapter serves any provider exposing the OpenAI Chat Completions contract.
// Credentials are resolved only at execution, never persisted in task metadata.
export function networkErrorMessage(providerLabel, error) {
  const codes = [error?.code, error?.cause?.code, ...(error?.cause?.errors || []).map(item => item.code)];
  if (codes.some(code => ['EACCES', 'EPERM'].includes(code))) return `${providerLabel}：本地服务的网络访问被系统限制（EACCES/EPERM）。请在正常终端启动服务，或允许该服务联网；这不是密钥错误。`;
  if (codes.some(code => ['ENOTFOUND', 'EAI_AGAIN'].includes(code))) return `${providerLabel}：域名解析失败，请检查网络和 DNS 设置。`;
  if (codes.some(code => ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code))) return `${providerLabel}：HTTPS 证书验证失败，请检查系统时间或网络代理的证书配置。`;
  if (error?.name === 'TimeoutError' || codes.some(code => ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code))) return `${providerLabel}：请求超时，请检查网络，或稍后重试。`;
  if (codes.includes('ECONNREFUSED')) return `${providerLabel}：连接被拒绝，请检查服务地址和代理端口。`;
  if (codes.some(code => ['ECONNRESET', 'UND_ERR_SOCKET'].includes(code))) return `${providerLabel}：连接被中断，请检查网络或代理后重试。`;
  return `${providerLabel}：无法建立网络连接，请检查网络和服务地址。`;
}
export async function callModel(snapshot, messages, { signal, maxTokens, fetchImpl = fetch, apiKey } = {}) {
  const key = apiKey || (await keyFor({ id: snapshot.providerId, apiKeyEnv: snapshot.apiKeyEnv })).value;
  if (!key) throw new Error(`${snapshot.providerLabel} 尚未配置 API Key`);
  let response;
  try {
    response = await fetchImpl(`${snapshot.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...snapshot.requestDefaults, model: snapshot.modelId, messages, max_tokens: maxTokens || snapshot.maxOutputTokens, stream: false }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(snapshot.timeoutMs)]) : AbortSignal.timeout(snapshot.timeoutMs),
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('CANCELLED');
    throw new Error(networkErrorMessage(snapshot.providerLabel, error));
  }
  if (!response.ok) {
    const reasons = { 400: '请求参数不兼容，请检查模型配置', 401: 'API Key 无效', 402: '账户余额不足', 403: '无访问权限或地区不可用', 404: '模型或接口不存在', 429: '调用过于频繁或额度受限' };
    const error = new Error(`${snapshot.providerLabel}：${reasons[response.status] || `服务返回 HTTP ${response.status}`}`);
    error.httpStatus = response.status;
    throw error;
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('模型未返回有效 JSON 响应'); }
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('模型输出被截断，请调整 maxOutputTokens 或缩短输入');
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回总结正文，可能存在拒绝或参数不兼容');
  const usage = data.usage ? Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'].filter(key => Number.isFinite(data.usage[key])).map(key => [key, data.usage[key]])) : null;
  return { text: normalizeSubtitleEncoding(content), usage };
}
