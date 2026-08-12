import { compare } from 'compare-versions';
import { io, Socket } from 'socket.io-client';

/** tavern_sync.mjs 服务器地址 (push/pull 命令运行时临时监听) */
const SOCKET_URL = 'http://localhost:6620';
/** 需要的最低酒馆助手版本 */
const MIN_HELPER_VERSION = '4.7.9';

export type SocketStatus =
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'disconnected'; reason: string };

let socket: Socket | null = null;
let statusListener: ((status: SocketStatus) => void) | null = null;

/** 注册连接状态回调 (供 UI 显示服务器状态) */
export function onSocketStatus(listener: (status: SocketStatus) => void): void {
  statusListener = listener;
  if (socket) {
    listener(parseSocketStatus(socket));
  }
}

function parseSocketStatus(s: Socket): SocketStatus {
  if (s.connected) {
    return { state: 'connected' };
  }
  return { state: 'connecting' };
}

function setStatus(status: SocketStatus): void {
  statusListener?.(status);
}

/** 获取 socket 实例 (懒创建, 自动重连) */
function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, { transports: ['websocket'] });
    socket.on('connect', () => {
      console.info('[TavernSync] 成功连接至服务器');
      setStatus({ state: 'connected' });
    });
    socket.on('connect_error', error => {
      console.error(`[TavernSync] 连接服务器出错, 尝试重连! ${error.stack}`);
      setStatus({ state: 'disconnected', reason: error.message });
    });
    socket.on('disconnect', (reason, description) => {
      console.info(`[TavernSync] 与服务器断开连接: ${reason}\n${JSON.stringify(description)}`);
      setStatus({ state: 'disconnected', reason });
    });
  }
  return socket;
}

/** 检查酒馆助手版本是否满足要求 */
function checkVersion(): boolean {
  try {
    if (compare(getTavernHelperVersion(), MIN_HELPER_VERSION, '<')) {
      toastr.error(`'同步脚本' 需要酒馆助手版本 >= '${MIN_HELPER_VERSION}'`, '版本不兼容');
      return false;
    }
  } catch {
    // 版本获取失败时不阻塞
  }
  return true;
}

/** 把世界书条目的 key 统一转成字符串 (酒馆内是 RegExp, 协议要求字符串) */
function stringifyKeys(entries: WorldbookEntry[]): void {
  entries.forEach(entry => {
    entry.strategy.keys = entry.strategy.keys.map(_.toString);
    entry.strategy.keys_secondary.keys = entry.strategy.keys_secondary.keys.map(_.toString);
  });
}

function registerPullCharacter(s: Socket): void {
  s.on('pull_character', async (payload: { name: string }, callback: (data?: unknown) => void) => {
    console.info(`[TavernSync] 收到提取角色卡 '${payload.name}' 的请求`);
    try {
      const character = await getCharacter(payload.name);
      _.set(character, 'avatar', await fetch(getCharAvatarPath(payload.name) ?? '').then(response => response.blob()));
      // worldbook 为 null 表示卡未绑定世界书, 只有真正绑定了才需要检查并提取
      const worldbook_name = character.worldbook;
      if (worldbook_name !== null && !getWorldbookNames().includes(worldbook_name)) {
        throw new Error(`未能找到角色卡绑定的世界书 '${worldbook_name}', 请确认已经导入到酒馆中`);
      }
      _.set(character, 'worldbook', worldbook_name ?? payload.name);
      _.set(
        character,
        'entries',
        worldbook_name !== null
          ? await getWorldbook(worldbook_name).then(entries => {
              stringifyKeys(entries);
              return entries;
            })
          : [],
      );
      // 酒馆助手扩展数据可能是数组形式的键值对, 统一转成对象
      if (_.has(character, 'extensions.tavern_helper') && _.isArray(character.extensions.tavern_helper)) {
        _.update(character, 'extensions.tavern_helper', value => Object.fromEntries(value as [string, unknown][]));
      }
      console.info(`[TavernSync] 已提取角色卡 '${payload.name}' 到本地`);
      callback(character);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[TavernSync] 提取角色卡 '${payload.name}' 失败: ${message}`);
      callback(message);
      throw error;
    }
  });
}

function registerPushCharacter(s: Socket): void {
  s.on(
    'push_character',
    async (
      payload: { name: string; data: TypeFest.PartialDeep<Character> & Record<string, any> },
      callback: (error?: unknown) => void,
    ) => {
      console.info(`[TavernSync] 收到推送角色卡 '${payload.name}' 的请求`);
      try {
        const entries = payload.data.entries as TypeFest.PartialDeep<WorldbookEntry>[];
        // 目标卡已存在且有主世界书时, 用目标卡自己的主世界书; 否则用数据里的世界书
        let worldbook_name = RawCharacter.find({ name: payload.name }) ? getCharWorldbookNames(payload.name).primary : null;
        if (entries.length > 0 || worldbook_name !== null) {
          worldbook_name ??= payload.data.worldbook as string;
          await createOrReplaceWorldbook(worldbook_name, entries, { render: 'none' });
          _.set(payload.data, 'worldbook', worldbook_name);
        }
        _.set(payload.data, 'first_messages', (payload.data.first_messages as { content: string }[]).map(entry => entry.content));
        _.set(
          payload.data,
          'avatar',
          new Blob([new Uint8Array(payload.data.avatar as ArrayBuffer)], { type: 'application/octet-stream' }),
        );
        _.unset(payload.data, 'anchors');
        _.unset(payload.data, 'entries');
        if (getCharacterNames().includes(payload.name)) {
          await updateCharacterWith(payload.name, character =>
            _.isNil(payload.data.extensions) ? { ...payload.data, extensions: character.extensions } : payload.data,
          );
        } else {
          await createCharacter(payload.name, payload.data);
        }
        console.info(`[TavernSync] 已推送角色卡 '${payload.name}' 到酒馆`);
        callback();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[TavernSync] 推送角色卡 '${payload.name}' 失败: ${message}`);
        callback(message);
        throw error;
      }
    },
  );
}

function registerPullPreset(s: Socket): void {
  s.on('pull_preset', (payload: { name: string }, callback: (data?: unknown) => void) => {
    console.info(`[TavernSync] 收到提取预设 '${payload.name}' 的请求`);
    try {
      callback(getPreset(getLoadedPresetName() === payload.name ? 'in_use' : payload.name));
      console.info(`[TavernSync] 已提取预设 '${payload.name}' 到本地`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[TavernSync] 提取预设 '${payload.name}' 失败: ${message}`);
      callback(message);
      throw error;
    }
  });
}

function registerPushPreset(s: Socket): void {
  s.on(
    'push_preset',
    async (
      payload: { name: string; data: TypeFest.PartialDeep<Preset> & Record<string, any> },
      callback: (error?: unknown) => void,
    ) => {
      console.info(`[TavernSync] 收到推送预设 '${payload.name}' 的请求`);
      try {
        if (getPresetNames().includes(payload.name)) {
          await updatePresetWith(payload.name, preset =>
            _.isNil(payload.data.extensions) ? { ...payload.data, extensions: preset.extensions } : payload.data,
          );
        } else {
          await createPreset(payload.name, payload.data);
        }
        if (getLoadedPresetName() === payload.name) {
          loadPreset(payload.name);
        }
        console.info(`[TavernSync] 已推送预设 '${payload.name}' 到酒馆`);
        callback();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[TavernSync] 推送预设 '${payload.name}' 失败: ${message}`);
        callback(message);
        throw error;
      }
    },
  );
}

function registerPullWorldbook(s: Socket): void {
  s.on('pull_worldbook', async (payload: { name: string }, callback: (data?: unknown) => void) => {
    console.info(`[TavernSync] 收到提取世界书 '${payload.name}' 的请求`);
    try {
      const entries = await getWorldbook(payload.name);
      stringifyKeys(entries);
      console.info(`[TavernSync] 已提取世界书 '${payload.name}' 到本地`);
      callback(entries);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[TavernSync] 提取世界书 '${payload.name}' 失败: ${message}`);
      callback(message);
      throw error;
    }
  });
}

function registerPushWorldbook(s: Socket): void {
  s.on(
    'push_worldbook',
    async (
      payload: { name: string; data: { entries: TypeFest.PartialDeep<WorldbookEntry>[] } },
      callback: (error?: unknown) => void,
    ) => {
      console.info(`[TavernSync] 收到推送世界书 '${payload.name}' 的请求`);
      try {
        await createOrReplaceWorldbook(payload.name, payload.data.entries, { render: 'none' });
        console.info(`[TavernSync] 已推送世界书 '${payload.name}' 到酒馆`);
        callback();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[TavernSync] 推送世界书 '${payload.name}' 失败: ${message}`);
        callback(message);
        throw error;
      }
    },
  );
}

/** 初始化同步 socket (替代官方「角色卡/世界书/预设同步脚本」连接脚本, 无阻塞弹窗) */
export function initSyncSocket(): void {
  if (!checkVersion()) {
    return;
  }
  const s = getSocket();
  registerPullCharacter(s);
  registerPushCharacter(s);
  registerPullPreset(s);
  registerPushPreset(s);
  registerPullWorldbook(s);
  registerPushWorldbook(s);
  console.info('[TavernSync] 同步 socket 已初始化 (连接: ' + SOCKET_URL + ')');
}
