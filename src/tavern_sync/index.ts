import { autoPull, checkBridge, cleanupAll, deleteConfig, fetchConfigs, pullConfig, pushConfig, undoLast, undoStatus, UndoStatus, SyncConfig } from './bridge';
import { initSyncSocket, onSocketStatus, SocketStatus } from './socket';
import { syncCharacter } from './sync';
import { SyncOptions } from './types';

const BUTTON_NAME = '同步';
const PANEL_ID = 'tavern-sync-v2-panel-wrapper';
const STYLE_ID = 'tavern-sync-v2-style';

// parent.toastr: 把通知弹到酒馆主页面 (iframe 自己的 toastr 渲染到 iframe DOM, 不可见)
declare global {
  interface Window {
    toastr: typeof toastr;
  }
}

const SYNC_FIELD_LABELS: { key: keyof SyncOptions; label: string; title: string }[] = [
  { key: 'worldbook', label: '世界书', title: '把源卡绑定的世界书内容同步到酒馆中的同名世界书' },
  { key: 'character_data', label: '角色卡数据', title: '描述、开场白、作者注释' },
  { key: 'regex', label: '局部正则', title: '源卡的局部正则脚本' },
  { key: 'scripts_variables', label: '脚本/变量', title: '酒馆助手脚本树与角色卡变量' },
];

/** 面板样式 (注入 parent 页面 head) */
const PANEL_STYLE = `
#${PANEL_ID} {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  z-index: 2147483000;
  font-family: inherit;
  background: color-mix(in srgb, var(--SmartThemeBlurTintColor, #1e2433) 92%, transparent);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-top: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #555) 60%, transparent);
  box-shadow: 0 -12px 48px rgba(0, 0, 0, 0.45);
  animation: tsv-slide-up 0.22s ease-out;
}
@keyframes tsv-slide-up {
  from { transform: translateY(24px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
#${PANEL_ID} .tsv-inner {
  max-width: 1280px;
  margin: 0 auto;
  padding: 14px 24px 16px;
  box-sizing: border-box;
}
#${PANEL_ID} .tsv-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
#${PANEL_ID} .tsv-title {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 1.08rem;
  font-weight: 700;
  color: var(--SmartThemeBodyColor, #e2e8f0);
  letter-spacing: 0.02em;
}
#${PANEL_ID} .tsv-title i { color: #818cf8; font-size: 1.05rem; }
#${PANEL_ID} .tsv-subtitle {
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #e2e8f0) 55%, transparent);
  font-size: 0.85rem;
  margin-left: 2px;
}
#${PANEL_ID} .tsv-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 600;
  background: color-mix(in srgb, var(--white30a, #2a3040) 70%, transparent);
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #e2e8f0) 60%, transparent);
}
#${PANEL_ID} .tsv-badge i { font-size: 0.62rem; }
#${PANEL_ID} .tsv-badge.tsv-ok { color: #4ade80; }
#${PANEL_ID} .tsv-badge.tsv-ok i { color: #4ade80; }
#${PANEL_ID} .tsv-badge.tsv-bad { color: #f87171; }
#${PANEL_ID} .tsv-badge.tsv-bad i { color: #f87171; }
#${PANEL_ID} .tsv-badge.tsv-mid { color: #fbbf24; }
#${PANEL_ID} .tsv-badge.tsv-mid i { color: #fbbf24; }
#${PANEL_ID} .tsv-close {
  margin-left: auto;
  width: 30px; height: 30px;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 8px;
  background: transparent;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #e2e8f0) 70%, transparent);
  font-size: 1.15rem; line-height: 1;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
#${PANEL_ID} .tsv-close:hover {
  background: rgba(248, 113, 113, 0.15);
  color: #f87171;
}
#${PANEL_ID} .tsv-section {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9rem;
  font-weight: 700;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #e2e8f0) 80%, transparent);
  margin: 4px 0 10px;
  letter-spacing: 0.03em;
}
#${PANEL_ID} .tsv-section i { font-size: 0.82rem; }
#${PANEL_ID} .tsv-section small {
  font-weight: 500;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #e2e8f0) 45%, transparent);
}
#${PANEL_ID} .tsv-section::after {
  content: '';
  flex: 1;
  height: 1px;
  background: color-mix(in srgb, var(--SmartThemeBorderColor, #555) 40%, transparent);
  margin-left: 4px;
}
#${PANEL_ID} .tsv-body {
  display: flex;
  align-items: flex-end;
  gap: 14px;
  margin-bottom: 10px;
}
#${PANEL_ID} .tsv-select-group { flex: 1; min-width: 0; }
#${PANEL_ID} .tsv-label {
  font-size: 0.82rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #e2e8f0) 70%, transparent);
  margin-bottom: 6px;
  letter-spacing: 0.03em;
}
#${PANEL_ID} .tsv-select {
  width: 100%;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #555) 70%, transparent);
  background: color-mix(in srgb, var(--white30a, #2a3040) 85%, transparent);
  color: var(--SmartThemeBodyColor, #e2e8f0);
  font-size: 0.95rem;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
#${PANEL_ID} .tsv-select:focus {
  border-color: #818cf8;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
}
#${PANEL_ID} .tsv-arrow {
  flex-shrink: 0;
  display: flex; align-items: center;
  padding-bottom: 9px;
  color: #818cf8;
  font-size: 1.1rem;
}
#${PANEL_ID} .tsv-checks {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin-bottom: 10px;
}
#${PANEL_ID} .tsv-check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #555) 70%, transparent);
  background: color-mix(in srgb, var(--white30a, #2a3040) 50%, transparent);
  color: var(--SmartThemeBodyColor, #e2e8f0);
  font-size: 0.88rem;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}
#${PANEL_ID} .tsv-check input { accent-color: #6366f1; cursor: pointer; }
#${PANEL_ID} .tsv-check:hover { border-color: #818cf8; }
#${PANEL_ID} .tsv-check:has(input:checked) {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.28), rgba(168, 85, 247, 0.28));
  border-color: #818cf8;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12);
}
#${PANEL_ID} .tsv-actions {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 14px;
  margin-bottom: 4px;
}
#${PANEL_ID} .tsv-btn {
  flex-shrink: 0;
  padding: 9px 26px;
  border: none;
  border-radius: 10px;
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #fff;
  cursor: pointer;
  transition: filter 0.15s, transform 0.1s, box-shadow 0.15s;
}
#${PANEL_ID} .tsv-btn:hover { filter: brightness(1.12); box-shadow: 0 6px 20px rgba(99, 102, 241, 0.4); }
#${PANEL_ID} .tsv-btn:active { transform: translateY(1px); }
#${PANEL_ID} .tsv-btn:disabled {
  filter: grayscale(0.6) brightness(0.8);
  cursor: not-allowed;
  box-shadow: none;
}
#${PANEL_ID} .tsv-push {
  background: linear-gradient(135deg, #0ea5e9, #6366f1);
  box-shadow: 0 4px 16px rgba(14, 165, 233, 0.35);
}
#${PANEL_ID} .tsv-pull {
  background: linear-gradient(135deg, #10b981, #14b8a6);
  box-shadow: 0 4px 16px rgba(16, 185, 129, 0.35);
}
#${PANEL_ID} .tsv-execute {
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  box-shadow: 0 4px 16px rgba(99, 102, 241, 0.35);
  padding: 9px 36px;
}
#${PANEL_ID} .tsv-clear {
  background: linear-gradient(135deg, #64748b, #475569);
  box-shadow: 0 4px 16px rgba(71, 85, 105, 0.35);
}
#${PANEL_ID} .tsv-danger {
  background: linear-gradient(135deg, #ef4444, #b91c1c);
  box-shadow: 0 4px 16px rgba(239, 68, 68, 0.4);
}
#${PANEL_ID} .tsv-undo {
  background: linear-gradient(135deg, #f59e0b, #d97706);
  box-shadow: 0 4px 16px rgba(245, 158, 11, 0.35);
}
#${PANEL_ID} .tsv-undo:not(.tsv-undo-ready) {
  filter: grayscale(0.55) brightness(0.85);
  box-shadow: none;
}
#${PANEL_ID} .tsv-status {
  font-size: 0.88rem;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #e2e8f0) 60%, transparent);
  word-break: break-all;
  min-height: 1.2em;
  text-align: center;
  margin-top: 6px;
}
#${PANEL_ID} .tsv-status.tsv-success { color: #4ade80; }
#${PANEL_ID} .tsv-status.tsv-error { color: #f87171; }
#${PANEL_ID} .tsv-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483001;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
}
#${PANEL_ID} .tsv-modal {
  width: min(560px, 90vw);
  background: color-mix(in srgb, var(--SmartThemeBlurTintColor, #1e2433) 97%, transparent);
  border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #555) 60%, transparent);
  border-radius: 14px;
  padding: 18px 22px 20px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5);
  animation: tsv-slide-up 0.18s ease-out;
}
#${PANEL_ID} .tsv-modal-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--SmartThemeBodyColor, #e2e8f0);
  margin-bottom: 12px;
}
#${PANEL_ID} .tsv-modal-title i { color: #818cf8; }
#${PANEL_ID} .tsv-modal-row {
  display: flex;
  gap: 12px;
  padding: 7px 2px;
  font-size: 0.9rem;
  border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #555) 30%, transparent);
}
#${PANEL_ID} .tsv-modal-row span {
  flex-shrink: 0;
  width: 84px;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #e2e8f0) 55%, transparent);
}
#${PANEL_ID} .tsv-modal-row b {
  font-weight: 600;
  word-break: break-all;
  color: var(--SmartThemeBodyColor, #e2e8f0);
}
#${PANEL_ID} .tsv-modal-note {
  margin-top: 10px;
  font-size: 0.82rem;
  line-height: 1.6;
  color: #fbbf24;
}
#${PANEL_ID} .tsv-modal-note.tsv-danger-note {
  color: #f87171;
  font-weight: 600;
}
#${PANEL_ID} .tsv-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
#${PANEL_ID} .tsv-modal-actions .tsv-cancel-btn {
  background: color-mix(in srgb, var(--white30a, #2a3040) 85%, transparent);
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #e2e8f0) 80%, transparent);
}
`;

/** 注入面板样式 (总是更新, 避免旧样式残留) */
function ensureStyle(): void {
  const parent_doc = window.parent.document;
  let style = parent_doc.getElementById(STYLE_ID);
  if (!style) {
    style = parent_doc.createElement('style');
    style.id = STYLE_ID;
    parent_doc.head.appendChild(style);
  }
  style.textContent = PANEL_STYLE;
}

function setStatus($status: JQuery<HTMLElement>, text: string, cls: '' | 'tsv-success' | 'tsv-error' = ''): void {
  $status.removeClass('tsv-success tsv-error').text(text);
  if (cls) {
    $status.addClass(cls);
  }
}

/** 把 tavern_sync CLI 失败信息转成用户可读的提示 */
function describeSyncError(result: { message: string; output: string }): string {
  if (result.output.includes('--force') || result.output.includes('条目差异')) {
    return '酒馆与本地文本不一, 请打开强制覆盖';
  }
  return result.message;
}

/** 是否为「条目差异」类错误 (需要 -f 强制覆盖) */
function isDiffError(result: { output: string }): boolean {
  return result.output.includes('--force') || result.output.includes('条目差异');
}

/** 预测 auto-pull 自动生成的配置名与本地路径 (与 dist_server 生成规则一致) */
function predictAutoConfig(tavern_name: string): { configName: string; localPath: string } {
  const cleaned =
    tavern_name
      .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40) || '未命名';
  const configName = `自动-${cleaned}`;
  return { configName, localPath: `自动同步/${configName}/index` };
}

/** 通用确认框 (弹出在面板之上, 不遮挡酒馆页面其他区域) */
function showConfirm(options: {
  title: string;
  iconClass: string;
  rows: { label: string; value: string }[];
  note?: string;
  /** 警示 note 使用红色样式 */
  dangerNote?: boolean;
  /** 额外的原始 HTML 内容块 (如勾选项), 插在 note 之后 */
  extra?: string;
  okText: string;
  okClass: string;
  /** 点击确认时调用, 传入模态句柄供读取 extra 内容; 由调用方自行移除模态 */
  onOk: ($modal: JQuery<HTMLElement>) => void;
}): void {
  const parent_doc = window.parent.document;
  const $mask = $(
    `<div class="tsv-modal-mask"><div class="tsv-modal">
      <div class="tsv-modal-title"><i class="fa-solid ${options.iconClass}"></i>&nbsp;${_.escape(options.title)}</div>
      <div class="tsv-modal-body">
        ${options.rows
          .map(row => `<div class="tsv-modal-row"><span>${_.escape(row.label)}</span><b>${_.escape(row.value)}</b></div>`)
          .join('')}
      </div>
      ${options.note ? `<div class="tsv-modal-note${options.dangerNote ? ' tsv-danger-note' : ''}">${_.escape(options.note)}</div>` : ''}
      ${options.extra ?? ''}
      <div class="tsv-modal-actions">
        <button class="tsv-btn tsv-cancel-btn">取消</button>
        <button class="tsv-btn ${options.okClass} tsv-ok">${_.escape(options.okText)}</button>
      </div>
    </div></div>`,
  );
  $(parent_doc)
    .find(`#${PANEL_ID}`)
    .append($mask);
  $mask.find('.tsv-cancel-btn').on('click', () => $mask.remove());
  $mask.find('.tsv-ok').on('click', () => options.onOk($mask));
}

function updateSocketBadge($badge: JQuery<HTMLElement>, status: SocketStatus): void {
  $badge.removeClass('tsv-ok tsv-bad tsv-mid');
  if (status.state === 'connected') {
    $badge.addClass('tsv-ok').html('<i class="fa-solid fa-circle"></i>&nbsp;同步服务器已连接 (6620)');
  } else if (status.state === 'connecting') {
    $badge.addClass('tsv-mid').html('<i class="fa-solid fa-circle-notch fa-spin"></i>&nbsp;正在连接同步服务器…');
  } else {
    $badge.addClass('tsv-bad').html(`<i class="fa-solid fa-circle"></i>&nbsp;同步服务器未连接 (${status.reason})`);
  }
}

/** 构建选择面板 HTML */
function buildPanelHtml(): string {
  const character_names = getCharacterNames();
  const options_html = character_names.map(name => `<option value="${_.escape(name)}">${_.escape(name)}</option>`).join('');

  const checkboxes = SYNC_FIELD_LABELS.map(
    field =>
      `<label class="tsv-check" title="${_.escape(field.title)}">
        <input type="checkbox" value="${field.key}" checked />
        <span>${_.escape(field.label)}</span>
      </label>`,
  ).join('');

  return `
    <div id="${PANEL_ID}">
      <div class="tsv-inner">
        <div class="tsv-header">
          <div class="tsv-title"><i class="fa-solid fa-arrows-rotate"></i>同步</div>
          <div class="tsv-subtitle">tavern_sync 整合版</div>
          <span class="tsv-badge tsv-mid" id="tsv-socket-badge"><i class="fa-solid fa-circle-notch fa-spin"></i>&nbsp;连接状态…</span>
          <span class="tsv-badge tsv-mid" id="tsv-bridge-badge"><i class="fa-solid fa-circle-notch fa-spin"></i>&nbsp;桥接状态…</span>
          <button class="tsv-close" title="关闭">×</button>
        </div>

        <div class="tsv-section"><i class="fa-solid fa-arrow-up-from-bracket"></i>本地文件同步<small>tavern_sync.yaml 配置 ↔ 酒馆</small></div>
        <div class="tsv-body">
          <div class="tsv-select-group">
            <div class="tsv-label">酒馆中的角色卡</div>
            <select id="tsv-config" class="tsv-select">
              <option value="">加载中...</option>
            </select>
          </div>
        </div>
        <div class="tsv-checks">
          <label class="tsv-check" title="名称或数量不一致时也强制覆盖">
            <input type="checkbox" id="tsv-force" />
            <span>强制覆盖 (-f)</span>
          </label>
          <label class="tsv-check" title="拉取时, 新增条目的提示词内嵌在配置文件中而不是外链文件">
            <input type="checkbox" id="tsv-inline" />
            <span>内嵌提示词 (-i, 仅拉取)</span>
          </label>
        </div>
        <div class="tsv-actions">
          <button id="tsv-push" class="tsv-btn tsv-push"><i class="fa-solid fa-arrow-up-from-bracket"></i>&nbsp;推送到酒馆</button>
          <button id="tsv-pull" class="tsv-btn tsv-pull"><i class="fa-solid fa-arrow-down-to-line"></i>&nbsp;拉取到本地</button>
          <button id="tsv-clear" class="tsv-btn tsv-clear"><i class="fa-solid fa-trash-can"></i>&nbsp;清除本地配置</button>
          <button id="tsv-cleanup" class="tsv-btn tsv-danger"><i class="fa-solid fa-skull"></i>&nbsp;全部初始化</button>
          <button id="tsv-undo" class="tsv-btn tsv-undo" title="没有可回滚的操作"><i class="fa-solid fa-rotate-left"></i>&nbsp;回滚</button>
        </div>

        <div class="tsv-section"><i class="fa-solid fa-right-left"></i>卡间同步<small>源卡数据同步到目标卡</small></div>
        <div class="tsv-body">
          <div class="tsv-select-group">
            <div class="tsv-label">源卡</div>
            <select id="tsv-source" class="tsv-select">
              <option value="">— 选择源卡 —</option>${options_html}
            </select>
          </div>
          <div class="tsv-arrow"><i class="fa-solid fa-arrow-right-long"></i></div>
          <div class="tsv-select-group">
            <div class="tsv-label">目标卡</div>
            <select id="tsv-target" class="tsv-select">
              <option value="">— 选择目标卡 —</option>${options_html}
            </select>
          </div>
        </div>
        <div class="tsv-checks">${checkboxes}</div>
        <div class="tsv-actions">
          <button id="tsv-execute" class="tsv-btn tsv-execute"><i class="fa-solid fa-play" style="font-size:0.85em;"></i>&nbsp;执行同步</button>
        </div>

        <div id="tsv-status" class="tsv-status"></div>
      </div>
    </div>`;
}

/** 弹出同步面板 */
function showSyncPanel(): void {
  // 已有面板则先关闭
  const parent_doc = window.parent.document;
  $(`#${PANEL_ID}`).remove();
  ensureStyle();

  $(parent_doc.body).append(buildPanelHtml());

  const $panel = $(`#${PANEL_ID}`);
  const $status = $panel.find('#tsv-status');
  const $socketBadge = $panel.find('#tsv-socket-badge');
  const $bridgeBadge = $panel.find('#tsv-bridge-badge');

  // 关闭按钮
  $panel.find('.tsv-close').on('click', () => $panel.remove());

  // ---- 状态指示 ----
  updateSocketBadge($socketBadge, { state: 'connecting' });
  onSocketStatus(status => {
    updateSocketBadge($socketBadge, status);
  });

  checkBridge()
    .then(online => {
      $bridgeBadge
        .removeClass('tsv-ok tsv-bad tsv-mid')
        .addClass(online ? 'tsv-ok' : 'tsv-bad')
        .html(
          online
            ? '<i class="fa-solid fa-circle"></i>&nbsp;桥接服务在线 (5500)'
            : '<i class="fa-solid fa-circle"></i>&nbsp;桥接服务离线 (5500)',
        );
      return online;
    })
    .then(online => {
      if (!online) {
        setStatus($status, '⚠ 桥接服务 (dist_server) 未运行, 本地文件同步不可用', 'tsv-error');
      }
    })
    .catch(() => {
      $bridgeBadge.removeClass('tsv-ok tsv-bad tsv-mid').addClass('tsv-bad');
      $bridgeBadge.html('<i class="fa-solid fa-circle"></i>&nbsp;桥接服务离线 (5500)');
    });

  // ---- 本地文件同步 ----
  const $configSelect = $panel.find('#tsv-config');
  /** 最近一次加载的本地配置 (供确认框显示本地路径) */
  let cachedConfigs: SyncConfig[] = [];

  /** 加载酒馆角色卡 + 本地配置, 重建下拉选项 (selected: 重建后保持选中的卡名) */
  const loadCharacterOptions = async (selected?: string) => {
    const [configs, character_names] = await Promise.all([fetchConfigs(), Promise.resolve(getCharacterNames())]);
    cachedConfigs = configs;
    // 建立映射: 酒馆中的名称 -> 配置名
    const configByTavern = new Map<string, string>();
    for (const config of configs) {
      for (const tavern_name of config.tavern_names) {
        if (!configByTavern.has(tavern_name)) {
          configByTavern.set(tavern_name, config.name);
        }
      }
    }

    if (character_names.length === 0) {
      setStatus($status, '酒馆中没有找到任何角色卡', 'tsv-error');
      return;
    }
    $configSelect.empty();
    character_names.forEach(name => {
      const config_name = configByTavern.get(name);
      const label = config_name ? `${name} ⚙${config_name}` : `${name} (本地未配置)`;
      $configSelect.append(
        `<option value="${_.escape(name)}"${config_name ? ` data-config="${_.escape(config_name)}"` : ''}>${_.escape(label)}</option>`,
      );
    });
    if (selected) {
      $configSelect.val(selected);
    }
    const configured_count = character_names.filter(name => configByTavern.has(name)).length;
    setStatus($status, `已加载 ${character_names.length} 张角色卡 (${configured_count} 张有本地配置)`);
  };

  loadCharacterOptions().catch(error => {
    console.error('[tavern_sync] 加载角色卡/配置失败:', error);
    setStatus($status, `加载角色卡/配置失败: ${error.message} (桥接服务是否运行?)`, 'tsv-error');
  });

  const $syncButtons = $panel.find('#tsv-push, #tsv-pull');
  const busy = (disabled: boolean) => $syncButtons.prop('disabled', disabled);

  /** 执行本地同步 (已有配置); allowRetry=false 时差异错误不再弹重试框 */
  const doLocalSync = async (
    action: 'push' | 'pull',
    config_name: string,
    tavern_name: string,
    force: boolean,
    inline: boolean,
    allowRetry: boolean,
  ) => {
    const action_name = action === 'push' ? '推送(本地→酒馆)' : '拉取(酒馆→本地)';
    setStatus($status, `正在${action_name} '${tavern_name}' (配置: ${config_name})...`);
    busy(true);
    try {
      const result =
        action === 'push' ? await pushConfig(config_name, force) : await pullConfig(config_name, force, inline);

      if (result.ok) {
        setStatus($status, `✅ ${action_name}成功: ${tavern_name}`, 'tsv-success');
        parent.toastr.success(`${action_name}成功: ${tavern_name}`, 'tavern_sync');
        console.info(`[tavern_sync] ${action} 成功: ${config_name} (${tavern_name})`);
        console.info(`[tavern_sync] 输出:\n${result.output}`);
      } else if (allowRetry && isDiffError(result)) {
        // 条目差异: 弹「强制覆盖重试」确认框
        console.warn(`[tavern_sync] ${action} 条目差异: ${result.message}`);
        showConfirm({
          title: '需要强制覆盖 (-f)',
          iconClass: 'fa-triangle-exclamation',
          rows: [
            { label: '动作', value: action_name },
            { label: '角色卡', value: tavern_name },
          ],
          note: '酒馆与本地文本不一, 请打开强制覆盖重试',
          okText: '强制覆盖重试',
          okClass: 'tsv-pull',
          onOk: $modal => {
            $modal.remove();
            doLocalSync(action, config_name, tavern_name, true, inline, false);
          },
        });
      } else {
        setStatus($status, `❌ ${action_name}失败: ${describeSyncError(result)}`, 'tsv-error');
        console.error(`[tavern_sync] ${action} 失败: ${result.message}`);
        console.error(`[tavern_sync] 输出:\n${result.output}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus($status, `❌ ${action_name}出错: ${message}`, 'tsv-error');
      console.error(`[tavern_sync] ${action} 出错: ${message}`);
    } finally {
      busy(false);
      refreshUndoState();
    }
  };

  /** 执行自动拉取 (本地无配置); allowRetry=false 时差异错误不再弹重试框 */
  const doAutoPull = async (tavern_name: string, force: boolean, inline: boolean, allowRetry: boolean) => {
    setStatus($status, `⏳ '${tavern_name}' 本地未配置, 正在自动添加配置并拉取...`);
    busy(true);
    try {
      const result = await autoPull(tavern_name, force, inline);
      if (result.ok) {
        await loadCharacterOptions(tavern_name);
        setStatus($status, `✅ 已自动添加配置 '${result.config_name}' 并拉取成功: ${tavern_name}`, 'tsv-success');
        parent.toastr.success(`已自动添加配置 '${result.config_name}' 并拉取成功`, 'tavern_sync');
        console.info(`[tavern_sync] auto-pull 成功: ${result.config_name} (${tavern_name})`);
        console.info(`[tavern_sync] 输出:\n${result.output}`);
      } else if (allowRetry && isDiffError(result)) {
        console.warn(`[tavern_sync] auto-pull 条目差异: ${result.message}`);
        showConfirm({
          title: '需要强制覆盖 (-f)',
          iconClass: 'fa-triangle-exclamation',
          rows: [
            { label: '动作', value: '自动拉取(酒馆→本地)' },
            { label: '角色卡', value: tavern_name },
          ],
          note: '酒馆与本地文本不一, 请打开强制覆盖重试',
          okText: '强制覆盖重试',
          okClass: 'tsv-pull',
          onOk: $modal => {
            $modal.remove();
            doAutoPull(tavern_name, true, inline, false);
          },
        });
      } else {
        setStatus($status, `❌ 自动添加配置并拉取失败: ${describeSyncError(result)}`, 'tsv-error');
        console.error(`[tavern_sync] auto-pull 失败: ${result.message}`);
        console.error(`[tavern_sync] 输出:\n${result.output}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus($status, `❌ 自动添加配置出错: ${message}`, 'tsv-error');
      console.error(`[tavern_sync] auto-pull 出错: ${message}`);
    } finally {
      busy(false);
      refreshUndoState();
    }
  };

  /** 点击推送/拉取: 先弹确认框 (写明从哪到哪), 确认后执行 */
  const runLocalSync = (action: 'push' | 'pull', force: boolean, inline: boolean) => {
    const tavern_name = String($configSelect.val() ?? '');
    const config_name = $configSelect.find(':selected').attr('data-config') || '';

    if (!tavern_name) {
      setStatus($status, '请选择酒馆中的角色卡', 'tsv-error');
      return;
    }
    const option_flags = [force ? '强制覆盖 (-f)' : '', inline ? '内嵌提示词 (-i)' : ''].filter(Boolean).join('、');

    if (!config_name) {
      if (action === 'push') {
        setStatus($status, `❌ '${tavern_name}' 本地暂无配置, 无法推送; 请先点击「拉取到本地」自动添加配置`, 'tsv-error');
        return;
      }
      // 本地无配置: 确认自动添加配置并拉取
      const predicted = predictAutoConfig(tavern_name);
      showConfirm({
        title: '拉取到本地 (酒馆 → 本地)',
        iconClass: 'fa-arrow-down-to-line',
        rows: [
          { label: '角色卡', value: tavern_name },
          { label: '配置', value: `自动添加 (${predicted.configName})` },
          { label: '本地文件', value: `${predicted.localPath}.yaml` },
          ...(option_flags ? [{ label: '选项', value: option_flags }] : []),
        ],
        okText: '确认拉取',
        okClass: 'tsv-pull',
        onOk: $modal => {
          $modal.remove();
          doAutoPull(tavern_name, force, inline, true);
        },
      });
      return;
    }

    // 已有配置: 确认框显示本地路径
    const local_path = cachedConfigs.find(config => config.name === config_name)?.local_path || '(未知)';
    const is_push = action === 'push';
    showConfirm({
      title: is_push ? '推送到酒馆 (本地 → 酒馆)' : '拉取到本地 (酒馆 → 本地)',
      iconClass: is_push ? 'fa-arrow-up-from-bracket' : 'fa-arrow-down-to-line',
      rows: [
        { label: '角色卡', value: tavern_name },
        { label: '配置', value: config_name },
        { label: '本地文件', value: local_path },
        ...(option_flags ? [{ label: '选项', value: option_flags }] : []),
      ],
      okText: is_push ? '确认推送' : '确认拉取',
      okClass: is_push ? 'tsv-push' : 'tsv-pull',
      onOk: $modal => {
        $modal.remove();
        doLocalSync(action, config_name, tavern_name, force, inline, true);
      },
    });
  };

  /** 清除本地配置: 弹确认框 (写明删除哪张卡哪个配置), 确认后删除 yaml 条目 */
  const runClearLocal = () => {
    const tavern_name = String($configSelect.val() ?? '');
    const config_name = $configSelect.find(':selected').attr('data-config') || '';

    if (!tavern_name) {
      setStatus($status, '请选择酒馆中的角色卡', 'tsv-error');
      return;
    }
    if (!config_name) {
      setStatus($status, `'${tavern_name}' 没有本地配置可清除`, 'tsv-error');
      return;
    }
    const local_path = cachedConfigs.find(config => config.name === config_name)?.local_path || '(未知)';
    showConfirm({
      title: '清除本地配置',
      iconClass: 'fa-trash-can',
      rows: [
        { label: '角色卡', value: tavern_name },
        { label: '配置', value: config_name },
        { label: '本地文件', value: local_path },
      ],
      note: `将从 tavern_sync.yaml 中删除配置 '${config_name}' 的条目, 该卡将变回「本地未配置」。`,
      extra: `<label class="tsv-check" style="margin-top:12px;"><input type="checkbox" id="tsv-clear-files" /><span>同时删除本地文件 (${_.escape(local_path)} 目录下的同步产物: index.yaml、头像、世界书等)</span></label>`,
      okText: '确认删除',
      okClass: 'tsv-clear',
      onOk: async $modal => {
        const remove_files = $modal.find('#tsv-clear-files').prop('checked');
        $modal.remove();
        setStatus($status, `正在清除配置 '${config_name}'...`);
        busy(true);
        try {
          const result = await deleteConfig(config_name, remove_files);
          if (result.ok) {
            await loadCharacterOptions(tavern_name);
            const file_note = result.files_deleted ? `, 已备份 ${result.files_deleted} 项本地文件 (可回滚)` : '';
            setStatus($status, `✅ 已清除配置 '${config_name}' (${tavern_name})${file_note}`, 'tsv-success');
            parent.toastr.success(`已清除配置 '${config_name}'${file_note}`, 'tavern_sync');
            console.info(`[tavern_sync] 已清除配置: ${config_name}${file_note}`);
          } else {
            setStatus($status, `❌ 清除配置失败: ${result.message}`, 'tsv-error');
            console.error(`[tavern_sync] 清除配置失败: ${result.message}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setStatus($status, `❌ 清除配置出错: ${message}`, 'tsv-error');
          console.error(`[tavern_sync] 清除配置出错: ${message}`);
        } finally {
          busy(false);
          refreshUndoState();
        }
      },
    });
  };

  /** 全部初始化: 删除所有配置对应的本地文件 (yaml 条目保留), 红色骷髅警示确认 */
  const runCleanupAll = () => {
    const configured = cachedConfigs.filter(config => config.local_path);
    showConfirm({
      title: '全部初始化',
      iconClass: 'fa-skull',
      rows: [
        {
          label: '影响配置',
          value: configured.length > 0 ? `${configured.length} 个: ${configured.map(config => config.name).join('、')}` : '无',
        },
        { label: '删除内容', value: '所有本地同步文件 (index.yaml、头像、世界书、正则等)' },
      ],
      note: '将从本地删除所有配置对应的同步文件与目录, tavern_sync.yaml 中的配置条目会保留。此操作不可恢复!',
      dangerNote: true,
      okText: '确认全部删除',
      okClass: 'tsv-danger',
      onOk: async $modal => {
        $modal.remove();
        setStatus($status, '正在删除所有本地同步文件...');
        busy(true);
        try {
          const result = await cleanupAll();
          if (result.ok) {
            await loadCharacterOptions(String($configSelect.val() ?? ''));
            setStatus($status, `✅ 全部初始化完成: 已清理 ${result.configs_cleaned} 个配置的本地文件 (${result.files_deleted} 项, 可回滚)`, 'tsv-success');
            parent.toastr.success(`全部初始化完成, 已备份 ${result.files_deleted} 项本地文件, 可回滚`, 'tavern_sync');
            console.info(`[tavern_sync] cleanup-all 完成: ${result.message}`);
          } else {
            setStatus($status, `❌ 全部初始化失败: ${result.message}`, 'tsv-error');
            console.error(`[tavern_sync] cleanup-all 失败: ${result.message}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setStatus($status, `❌ 全部初始化出错: ${message}`, 'tsv-error');
          console.error(`[tavern_sync] cleanup-all 出错: ${message}`);
        } finally {
          busy(false);
          refreshUndoState();
        }
      },
    });
  };

  /** 刷新回滚按钮状态: 有备份时高亮提示, 无备份时暗淡 (按钮始终可点, 点击后有提示) */
  const refreshUndoState = async () => {
    const $undo = $panel.find('#tsv-undo');
    try {
      const status = await undoStatus();
      const parts: string[] = [];
      if (status.files > 0) {
        parts.push(`${status.files} 个本地文件`);
      }
      if (status.push_prev.length > 0) {
        parts.push(`推回酒馆 ${status.push_prev.join('、')}`);
      }
      if (status.has_yaml) {
        parts.push('yaml 配置');
      }
      $undo
        .toggleClass('tsv-undo-ready', status.available)
        .attr('title', status.available ? `可回滚: ${parts.join(', ')}` : '没有可回滚的操作');
    } catch {
      $undo.removeClass('tsv-undo-ready').attr('title', '桥接服务离线, 无法查询回滚状态');
    }
  };

  /** 回滚: 恢复最近一次备份的 yaml 与本地文件 */
  const runUndo = async () => {
    let status: UndoStatus | null = null;
    try {
      status = await undoStatus();
    } catch {
      setStatus($status, '无法查询回滚状态 (桥接服务离线?)', 'tsv-error');
      return;
    }
    if (!status.available) {
      setStatus($status, '没有可回滚的操作', 'tsv-error');
      return;
    }
    const dir_names = status.dirs.length > 0 ? ` (${status.dirs.join('、')})` : '';
    const rows: { label: string; value: string }[] = [{ label: '恢复文件', value: `${status.files} 个本地文件${dir_names}` }];
    if (status.pull_prev.length > 0) {
      rows.push({ label: '拉取前备份', value: status.pull_prev.join('、') });
    }
    if (status.push_prev.length > 0) {
      rows.push({ label: '推回酒馆', value: status.push_prev.join('、') });
    }
    if (status.has_yaml) {
      rows.push({ label: '恢复配置', value: 'tavern_sync.yaml 配置条目' });
    }
    showConfirm({
      title: '回滚上次操作',
      iconClass: 'fa-rotate-left',
      rows,
      note: '将撤销最近一次「推送 / 拉取 / 清除 / 全部初始化」, 恢复被备份的文件与数据。若之后手动改过 yaml, 本次回滚会将其覆盖。',
      okText: '确认回滚',
      okClass: 'tsv-undo',
      onOk: async $modal => {
        $modal.remove();
        setStatus($status, '正在回滚...');
        busy(true);
        try {
          const result = await undoLast();
          if (result.ok) {
            await loadCharacterOptions(String($configSelect.val() ?? ''));
            setStatus($status, `✅ ${result.message}`, 'tsv-success');
            parent.toastr.success(result.message, 'tavern_sync');
            console.info(`[tavern_sync] undo 完成: ${result.message}`);
          } else {
            setStatus($status, `❌ 回滚失败: ${result.message}`, 'tsv-error');
            console.error(`[tavern_sync] undo 失败: ${result.message}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setStatus($status, `❌ 回滚出错: ${message}`, 'tsv-error');
          console.error(`[tavern_sync] undo 出错: ${message}`);
        } finally {
          busy(false);
          refreshUndoState();
        }
      },
    });
  };

  $panel.find('#tsv-push').on('click', () =>
    runLocalSync('push', $panel.find('#tsv-force').prop('checked'), $panel.find('#tsv-inline').prop('checked')),
  );
  $panel.find('#tsv-pull').on('click', () =>
    runLocalSync('pull', $panel.find('#tsv-force').prop('checked'), $panel.find('#tsv-inline').prop('checked')),
  );
  $panel.find('#tsv-clear').on('click', () => runClearLocal());
  $panel.find('#tsv-cleanup').on('click', () => runCleanupAll());
  $panel.find('#tsv-undo').on('click', () => runUndo());

  // 面板打开时查询回滚备份状态
  refreshUndoState();

  // ---- 卡间同步 ----
  $panel.find('#tsv-execute').on('click', async () => {
    const source = String($panel.find('#tsv-source').val() ?? '');
    const target = String($panel.find('#tsv-target').val() ?? '');
    const sync: SyncOptions = {
      worldbook: $panel.find('input[value="worldbook"]').prop('checked'),
      character_data: $panel.find('input[value="character_data"]').prop('checked'),
      regex: $panel.find('input[value="regex"]').prop('checked'),
      scripts_variables: $panel.find('input[value="scripts_variables"]').prop('checked'),
    };

    if (!source || !target) {
      setStatus($status, '请选择源卡和目标卡', 'tsv-error');
      return;
    }
    if (source === target) {
      setStatus($status, '源卡与目标卡不能相同', 'tsv-error');
      return;
    }
    if (!Object.values(sync).some(value => value)) {
      setStatus($status, '请至少勾选一项同步内容', 'tsv-error');
      return;
    }

    const $execute = $panel.find('#tsv-execute');
    $execute.prop('disabled', true).html('<i class="fa-solid fa-circle-notch fa-spin"></i>&nbsp;同步中...');

    try {
      console.info(`[tavern_sync] 开始卡间同步: '${source}' → '${target}'`);
      const result = await syncCharacter(source, target, sync);

      const lines = [`源卡: ${result.source}`, `目标卡: ${result.target}`];
      if (result.worldbooks.length > 0) {
        lines.push(`世界书: ${result.worldbooks.join('、')}`);
      }
      if (result.character_data) {
        lines.push('角色卡数据: 已同步');
      }
      if (result.regex_count > 0) {
        lines.push(`局部正则: ${result.regex_count} 条`);
      }
      if (result.scripts_variables) {
        lines.push('脚本/变量: 已同步');
      }
      for (const note of result.notes) {
        lines.push(note);
      }
      console.info(`[tavern_sync] 卡间同步完成: ${lines.join(' | ')}`);
      setStatus($status, lines.join('　|　'), 'tsv-success');
      parent.toastr.success(`卡间同步完成: ${lines[0]} → ${lines[1]}`, 'tavern_sync');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tavern_sync] 卡间同步失败: ${message}`);
      setStatus($status, `同步失败: ${message}`, 'tsv-error');
      parent.toastr.error(`同步失败: ${message}`, 'tavern_sync');
    } finally {
      $execute.prop('disabled', false).html('<i class="fa-solid fa-play" style="font-size:0.85em;"></i>&nbsp;执行同步');
    }
  });
}

/** 自动清理开场白回复的 MVU 状态栏: 监听 MVU 变量更新完成事件,
 *  把聊天中第一条 AI 回复 (对开场白的回应) 的状态栏占位符移除.
 *  后续回复正常带状态栏. 无需手动操作. */
function initStatusBarCleanup(): void {
  (async () => {
    try {
      const parent_win = window.parent as Window & { getCurrentChat?: () => any[]; saveChat?: () => Promise<void> };
      const mvu = await waitGlobalInitialized('Mvu');
      eventOn(mvu.events.VARIABLE_UPDATE_ENDED, async () => {
        try {
          const chat = parent_win.getCurrentChat?.();
          if (!chat) {
            return;
          }
          // 第一条 AI 回复 (开场白后的首条非用户消息)
          const idx = chat.findIndex((m: { is_user?: boolean }) => !m.is_user);
          if (idx === -1) {
            return;
          }
          const msg = chat[idx];
          if (!msg?.mes?.includes('<StatusPlaceHolderImpl/>')) {
            return;
          }
          // 清除占位符并保存
          msg.mes = msg.mes.replace(/<StatusPlaceHolderImpl\/>/g, '');
          await parent_win.saveChat?.();
          // 移除 DOM 中已渲染的状态栏 (正则替换产物)
          const parent_doc = window.parent.document;
          $(parent_doc).find(`.mes[data-mesid="${idx}"] .mes_text .mvu-glass-wrapper`).remove();
          console.info('[tavern_sync] 已清除开场白回复的状态栏');
        } catch (error) {
          console.warn('[tavern_sync] 清除开场白状态栏失败:', error);
        }
      });
    } catch {
      // MVU 未安装时忽略
    }
  })();
}

$(() => {
  replaceScriptButtons([{ name: BUTTON_NAME, visible: true }]);

  // 修正按钮容器: 默认 script_container 占满整行导致按钮靠左, 改为按内容自适应并居中
  const fix_container = () => {
    const $container = $(`#script_container_${getScriptId()}`);
    $container.css({ width: 'auto', 'flex-shrink': '0' });
  };
  fix_container();
  // 按钮渲染有延迟, 稍后再修正一次
  setTimeout(fix_container, 200);

  eventOn(getButtonEvent(BUTTON_NAME), () => {
    showSyncPanel();
  });

  // 初始化同步 socket (替代官方连接脚本, 无阻塞弹窗)
  initSyncSocket();
  // 自动清除开场白回复的 MVU 状态栏
  initStatusBarCleanup();

  console.info('[tavern_sync] 已加载同步整合版全局脚本');
});

$(window).on('pagehide', () => {
  $(`#${PANEL_ID}`).remove();
});
