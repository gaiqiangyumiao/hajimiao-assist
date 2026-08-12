/** 卡间同步可勾选的同步内容 */
export interface SyncOptions {
  worldbook: boolean;
  character_data: boolean;
  regex: boolean;
  scripts_variables: boolean;
}

/** 同步请求 (从面板收集) */
export interface SyncRequest {
  source: string;
  target: string;
  sync: SyncOptions;
}

/** 同步结果 (用于面板汇报) */
export interface SyncResult {
  source: string;
  target: string;
  /** 已同步 (新建/更新) 的世界书名称列表 */
  worldbooks: string[];
  /** 角色卡数据是否已同步 */
  character_data: boolean;
  /** 已同步的局部正则条数 */
  regex_count: number;
  /** 脚本/变量是否已同步 */
  scripts_variables: boolean;
  /** 额外的提示信息 (如"附加世界书需手动切换绑定") */
  notes: string[];
}
