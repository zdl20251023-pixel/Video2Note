import { useEffect, useRef, useState } from 'react';
import { Settings2, X, LoaderCircle, Check, RefreshCw, KeyRound } from 'lucide-react';

export type Selection = { providerId: string; modelId: string };
export type Catalog = {
  defaultSelection: Selection; configFile: string;
  speechProviders?: { id: string; label: string; hasKey: boolean; segmentSeconds: number }[];
  providers: { id: string; label: string; baseUrl: string; hasKey: boolean; keySource: string | null; models: { id: string; label: string; vision: boolean }[] }[];
};
export const selectionKey = (selection: Selection) => `${selection.providerId}::${selection.modelId}`;
export const fromKey = (key: string): Selection => { const [providerId, modelId] = key.split('::'); return { providerId, modelId }; };
export async function modelApi<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/models${route}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '模型设置操作失败');
  return result;
}

export function ModelControls({ catalog, selection, includeImages, onImages, onChange, onCatalog, onError }: {
  catalog: Catalog | null; selection: Selection; includeImages: boolean;
  onImages: (value: boolean) => void; onChange: (value: Selection) => void;
  onCatalog: (value: Catalog) => void; onError: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState('deepseek');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const provider = catalog?.providers.find(item => item.id === selection.providerId);
  const model = provider?.models.find(item => item.id === selection.modelId);
  const editing = catalog?.providers.find(item => item.id === providerId);
  useEffect(() => {
    if (open) { dialog.current?.showModal(); setKey(''); setNotice(null); }
    else dialog.current?.close();
  }, [open]);
  async function operation(name: string, action: () => Promise<void>) {
    setBusy(name); setNotice(null);
    try { await action(); } catch (error) { setNotice({ text: (error as Error).message, error: true }); }
    finally { setBusy(''); }
  }
  async function reload() {
    try { onCatalog(await modelApi<Catalog>('')); } catch (error) { onError((error as Error).message); }
  }
  return <>
    <div className="model-controls">
      <div className="model-select-row"><label htmlFor="summary-model"><Settings2 size={16} />整理模型</label>
        <select id="summary-model" value={selectionKey(selection)} disabled={!catalog} onChange={event => onChange(fromKey(event.target.value))}>
          {catalog?.providers.map(item => <optgroup label={item.label} key={item.id}>{item.models.map(model => <option key={model.id} value={selectionKey({ providerId: item.id, modelId: model.id })}>{model.label}{model.vision ? ' · 支持图片' : ' · 仅文字'}{!item.hasKey ? ' · 未配置密钥' : ''}</option>)}</optgroup>)}
          <optgroup label="本地"><option value="local::local">本地原文整理 · 无需密钥</option></optgroup>
        </select>
        <button type="button" className="small-button" onClick={() => { setProviderId(provider?.id || catalog?.providers[0]?.id || 'deepseek'); setOpen(true); }}><KeyRound size={14} />模型设置</button>
        <button type="button" className="icon-button refresh-models" title="重新读取模型配置" aria-label="刷新模型配置" onClick={reload}><RefreshCw size={15} /></button>
      </div>
      {selection.providerId === 'local' ? <p className="model-hint">本地筛选字幕原文并进行 OCR，不调用模型服务。</p> : <div className="model-disclosure">
        {<label className="check-label"><input type="checkbox" checked={includeImages} onChange={event => onImages(event.target.checked)} />分析全部截图</label>}
        {!model?.vision && <p className="missing-key">当前模型不支持图片。请切换至标有图片能力的模型，或取消“分析全部截图”后仅整理文字。</p>}
        <p className={!provider?.hasKey ? 'missing-key' : ''}>{!provider?.hasKey ? '请在模型设置中填写 API Key，或切换到本地整理。' : `字幕和 OCR${model?.vision && includeImages ? '、全部采样截图（分批分析，调用量随截图增加）' : ''}将发送至 ${provider.label}，生成结果保存在本机。`}</p>
      </div>}
    </div>
    <dialog ref={dialog} className="model-dialog" onCancel={() => setOpen(false)} onClick={event => { if (event.target === dialog.current) setOpen(false); }}>
      <div className="model-dialog-content">
        <header><div><span className="eyebrow">MODEL SETTINGS</span><h2>模型设置</h2></div><button aria-label="关闭模型设置" type="button" className="icon-button" onClick={() => setOpen(false)}><X size={20} /></button></header>
        <p className="settings-description">选择服务商并保存密钥。模型列表读取配置文件，不需要修改网页代码。</p>
        <div className="provider-tabs">{catalog?.providers.map(item => <button type="button" className={providerId === item.id ? 'active' : ''} key={item.id} onClick={() => { setProviderId(item.id); setKey(''); setNotice(null); }}>{item.label}</button>)}</div>
        {editing && <>
          <div className="provider-status"><span>{editing.hasKey ? <Check size={16} /> : <KeyRound size={16} />}{editing.hasKey ? `已配置${editing.keySource === 'environment' ? '（环境变量）' : '（本机保存）'}` : '尚未配置 API Key'}</span><code>{editing.baseUrl}</code></div>
          <label className="field-label" htmlFor="model-api-key">{editing.label} API Key</label>
          <input id="model-api-key" className="secret-input" type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder={editing.hasKey ? '输入新密钥以替换；不会回显已保存密钥' : '粘贴 API Key'} />
          <p className="secret-help">密钥仅保存于本机后端，不写入任务、笔记或浏览器存储。</p>
          <div className="settings-actions">
            <button type="button" className="primary" disabled={!!busy || !key.trim()} onClick={() => operation('save', async () => { const updated = await modelApi<Catalog>('/credentials', { providerId, apiKey: key }); onCatalog(updated); setKey(''); setNotice({ text: '密钥已保存，可测试连接。', error: false }); })}>{busy === 'save' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存密钥</button>
            <button type="button" className="secondary" disabled={!!busy || !editing.hasKey} onClick={() => operation('test', async () => { const modelId = selection.providerId === providerId ? selection.modelId : editing.models[0].id; const result = await modelApi<{ message: string }>('/test', { selection: { providerId, modelId } }); setNotice({ text: result.message, error: false }); })}>{busy === 'test' && <LoaderCircle size={16} className="spin" />}测试连接</button>
            <button type="button" className="text-button" disabled={!!busy || editing.keySource !== 'file'} onClick={() => operation('remove', async () => { onCatalog(await modelApi<Catalog>('/credentials', { providerId, removeKey: true })); setNotice({ text: '本机保存的密钥已移除。若仍有环境变量配置，会继续使用环境变量。', error: false }); })}>移除保存的密钥</button>
          </div>
          <p className="secret-help">测试连接会发送一条简短请求，不包含课程资料。</p>
        </>}
        {notice && <div className={`notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>}
        <div className="config-help"><strong>通过配置扩展模型</strong><p>编辑 <code>{catalog?.configFile || 'config/models.json'}</code>，增加兼容服务商或模型，然后点击“刷新模型配置”。每项可声明名称、接口地址及图片能力。</p><button type="button" className="small-button" onClick={() => operation('reload', async () => { onCatalog(await modelApi<Catalog>('')); setNotice({ text: '模型配置已重新读取。', error: false }); })} disabled={!!busy}><RefreshCw size={14} />刷新模型配置</button></div>
      </div>
    </dialog>
  </>;
}
