/** 本地 dist_server 静态服务器 + 桥接 API 地址 */
const SERVER_BASE = 'http://127.0.0.1:5500';

/** 一个同步配置 (tavern_sync.yaml 中的配置项) */
export interface SyncConfig {
  name: string;
  /** 配置类型: 角色卡/世界书/预设 */
  type: string;
  /** 该配置对应的酒馆中的名称列表 */
  tavern_names: string[];
  /** 本地文件路径 */
  local_path: string;
}

/** push/pull 的执行结果 */
export interface SyncResult {
  ok: boolean;
  message: string;
  output: string;
}

async function requestJson<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(
    `${SERVER_BASE}${path}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const data = await response.json();
      message = data.message || message;
    } catch {
      // 响应体不是 JSON, 保留 HTTP 状态码信息
    }
    throw new Error(message);
  }
  return response.json();
}

/** 桥接服务器 (dist_server) 是否在线 */
export async function checkBridge(): Promise<boolean> {
  try {
    const response = await fetch(`${SERVER_BASE}/api/configs`);
    return response.ok;
  } catch {
    return false;
  }
}

/** 列出 tavern_sync.yaml 中的配置 */
export async function fetchConfigs(): Promise<SyncConfig[]> {
  const data = await requestJson<{ configs: SyncConfig[] }>('/api/configs');
  return data.configs ?? [];
}

/** 推送: 本地 → 酒馆 */
export async function pushConfig(config: string, force: boolean): Promise<SyncResult> {
  return requestJson<SyncResult>('/api/push', { config, force });
}

/** 自动拉取结果: 本地无配置时自动添加配置 */
export interface AutoPullResult extends SyncResult {
  /** 实际使用的配置名 (可能是自动添加的新配置) */
  config_name: string;
  /** 是否本次自动向 tavern_sync.yaml 添加了配置 */
  added: boolean;
}

/** 自动拉取: 酒馆 → 本地 (本地无配置时自动在 tavern_sync.yaml 中添加配置并拉取) */
export async function autoPull(tavern_name: string, force: boolean, inline: boolean): Promise<AutoPullResult> {
  return requestJson<AutoPullResult>('/api/auto-pull', { tavern_name, force, inline });
}

/** 删除配置的结果 */
export interface DeleteResult {
  ok: boolean;
  message: string;
  /** 删除的本地文件/目录数量 (remove_files 时) */
  files_deleted?: number;
}

/** 删除 yaml 配置条目 (可选同时删除本地同步产物文件) */
export async function deleteConfig(config: string, removeFiles: boolean): Promise<DeleteResult> {
  return requestJson<DeleteResult>('/api/delete-config', { config, remove_files: removeFiles });
}

/** 全部初始化的结果 */
export interface CleanupResult {
  ok: boolean;
  message: string;
  configs_cleaned?: number;
  files_deleted?: number;
}

/** 全部初始化: 备份所有配置对应的本地文件 (yaml 配置条目保留), 可回滚 */
export async function cleanupAll(): Promise<CleanupResult> {
  return requestJson<CleanupResult>('/api/cleanup-all', {});
}

/** 回滚备份状态 */
export interface UndoStatus {
  ok: boolean;
  available: boolean;
  has_yaml: boolean;
  files: number;
  dirs: string[];
  /** 可恢复的本地文件所属配置 (拉取前备份) */
  pull_prev: string[];
  /** 可推回酒馆的配置 (推送前提取) */
  push_prev: string[];
}

/** 查询是否有可回滚的备份 */
export async function undoStatus(): Promise<UndoStatus> {
  return requestJson<UndoStatus>('/api/undo-status');
}

/** 回滚的结果 */
export interface UndoResult {
  ok: boolean;
  message: string;
  files_restored?: number;
  yaml_restored?: boolean;
  tavern_restored?: string[];
}

/** 回滚: 恢复最近一次备份的 yaml 与本地文件 */
export async function undoLast(): Promise<UndoResult> {
  return requestJson<UndoResult>('/api/undo', {});
}

/** 拉取: 酒馆 → 本地 */
export async function pullConfig(config: string, force: boolean, inline: boolean): Promise<SyncResult> {
  return requestJson<SyncResult>('/api/pull', { config, force, inline });
}
