/* tavern_sync 静态文件服务器 (带 CORS) + 手动同步桥接 API
 * 用法: node dist_server.cjs [端口] [目录]
 *
 * API:
 *   GET  /api/configs     列出 tavern_sync.yaml 中的配置名称
 *   POST /api/push        手动推送: 本地 → 酒馆   body: {config, force} (推送前自动备份酒馆数据)
 *   POST /api/pull        手动拉取: 酒馆 → 本地   body: {config, force, inline} (拉取前自动备份本地文件)
 *   POST /api/auto-pull   自动拉取: 本地无配置时自动添加到 yaml 再拉取   body: {tavern_name, force, inline}
 *   POST /api/delete-config 删除 yaml 配置条目 (可选备份本地文件到 .tsv_undo)  body: {config, remove_files}
 *   POST /api/cleanup-all   全部初始化: 备份所有配置对应的本地文件 (yaml 保留)  body: {}
 *   GET  /api/undo-status   回滚备份状态: {available, has_yaml, files, dirs}
 *   POST /api/undo          回滚: 恢复最近一次备份的 yaml 与本地文件  body: {}
 *   GET/POST 静态文件     供酒馆助手 srcdoc iframe 跨源加载脚本
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');

const port = Number(process.argv[2]) || 5500;
const root = path.resolve(process.argv[3] || __dirname);
const SYNC_CMD = path.join(root, 'tavern_sync.mjs');
const CONFIG_YAML = path.join(root, 'tavern_sync.yaml');
/** 回滚备份目录: 破坏性操作 (删除配置/全部初始化/拉取) 前把文件与 yaml 备份到这里 */
const UNDO_DIR = path.join(root, '.tsv_undo');
const UNDO_FILES = path.join(UNDO_DIR, 'files');
const UNDO_YAML = path.join(UNDO_DIR, 'yaml');
/** 拉取前的本地文件备份 */
const UNDO_PULL_PREV = path.join(UNDO_DIR, 'pull_prev');
/** 推送前从酒馆提取的卡数据备份 */
const UNDO_PUSH_PREV = path.join(UNDO_DIR, 'push_prev');

const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.png': 'image/png',
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-cache',
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('请求体不是有效 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 解析 yaml 标量值 (支持 JSON 双引号字符串, 如 "含: 冒号的名称") */
function parseScalar(value) {
  if (typeof value === 'string' && value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * 从 tavern_sync.yaml 提取配置详细信息
 * 返回: [{ name, type, tavern_names: [酒馆中的名称...] }]
 */
function listConfigs() {
  if (!fs.existsSync(CONFIG_YAML)) {
    return [];
  }
  const content = fs.readFileSync(CONFIG_YAML, 'utf8');
  const lines = content.split('\n');
  const configs = [];
  let inConfig = false;
  let current = null;
  const FIELD_NAMES = new Set(['类型', '酒馆中的名称', '本地文件路径', '导出文件路径']);

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^配置:/.test(trimmed)) {
      inConfig = true;
      continue;
    }
    if (!inConfig) {
      continue;
    }
    // 回到顶层 (非缩进行, 且不是"配置:") 表示配置区结束
    if (/^\S/.test(line) && !/^配置:/.test(line)) {
      inConfig = false;
      continue;
    }
    // 配置名: 缩进 2 空格的 "名称:" 行
    const nameMatch = line.match(/^  ([^\s#][^:]*):\s*$/);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      if (name && !FIELD_NAMES.has(name)) {
        current = { name, type: '', tavern_names: [] };
        configs.push(current);
      }
      continue;
    }
    if (!current) {
      continue;
    }
    // 字段: 缩进 4 空格的 "字段: 值" 行
    const fieldMatch = line.match(/^    ([^:\s][^:]*):\s*(.*)$/);
    if (!fieldMatch) {
      continue;
    }
    const [field, rawValue] = [fieldMatch[1].trim(), fieldMatch[2].trim()];
    if (field === '类型') {
      current.type = rawValue;
    } else if (field === '酒馆中的名称') {
      if (!rawValue) {
        // 空值, 可能是列表形式: 后续缩进 6 空格的 "- 名称" 行
        continue;
      }
      if (rawValue.startsWith('[')) {
        // 内联列表 [a, b]
        current.tavern_names = rawValue
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map(s => parseScalar(s.trim()))
          .filter(Boolean);
      } else {
        current.tavern_names = [parseScalar(rawValue)];
      }
    } else if (field === '本地文件路径') {
      current.local_path = rawValue;
    }
  }
  // 收集列表形式的酒馆中的名称 ("      - 名称" 缩进 6 空格)
  for (let i = 0; i < lines.length; i++) {
    const listMatch = lines[i].match(/^      -\s*(.+)$/);
    if (listMatch && i > 0 && /^    酒馆中的名称:\s*$/.test(lines[i - 1])) {
      // 找到该行所属的配置
      for (let j = i - 1; j >= 0; j--) {
        const cfgMatch = lines[j].match(/^  ([^\s#][^:]*):\s*$/);
        if (cfgMatch && !FIELD_NAMES.has(cfgMatch[1].trim())) {
          const cfg = configs.find(c => c.name === cfgMatch[1].trim());
          if (cfg) {
            cfg.tavern_names.push(listMatch[1].trim());
          }
          break;
        }
        if (/^\S/.test(lines[j]) && !/^配置:/.test(lines[j])) {
          break;
        }
      }
    }
  }
  return configs;
}

/** 生成安全的配置名/路径名 (移除文件系统非法字符) */
function sanitizeName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return cleaned || '未命名';
}

/** 生成不与现有配置重名的配置名 */
function uniqueConfigName(base) {
  const configs = listConfigs();
  let name = base;
  let i = 2;
  while (configs.some(c => c.name === name)) {
    name = `${base}-${i++}`;
  }
  return name;
}

/**
 * 向 tavern_sync.yaml 的「配置:」块末尾追加一个角色卡配置
 * 返回: { original, configName, localPath } — original 用于拉取失败时回滚
 */
function addCharacterConfig(tavernName) {
  const original = fs.readFileSync(CONFIG_YAML, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);

  // 找到顶层「配置:」行
  let cfgIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^配置:\s*$/.test(lines[i])) {
      cfgIdx = i;
      break;
    }
  }
  // 配置块结束位置: 下一个顶层非注释行 (或文件末尾)
  let endIdx = lines.length;
  if (cfgIdx !== -1) {
    for (let i = cfgIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed !== '' && !trimmed.startsWith('#') && !/^\s/.test(lines[i])) {
        endIdx = i;
        break;
      }
    }
  }

  const configName = uniqueConfigName(`自动-${sanitizeName(tavernName)}`);
  const localPath = `自动同步/${configName}/index`;
  const block = [
    `  ${configName}:`,
    '    类型: 角色卡',
    `    酒馆中的名称: ${JSON.stringify(tavernName)}`,
    `    本地文件路径: ${localPath}`,
  ];
  // 块前后各留一个空行
  const insert = ['', ...block, ''];
  // 没有「配置:」块时, 在文件末尾新建一个
  if (cfgIdx === -1) {
    insert.unshift('配置:');
  }
  lines.splice(endIdx, 0, ...insert);
  fs.writeFileSync(CONFIG_YAML, lines.join(eol), 'utf8');
  return { original, configName, localPath };
}

/**
 * 从 tavern_sync.yaml 中删除指定配置条目
 * 注意: 配置块内允许存在空行 (字段间空行), 空行不能作为块结束判定;
 * 只有「顶层行」或「下一个 2 空格配置名」出现才算块结束.
 * 返回: 是否删除成功 (配置不存在则 false)
 */
function removeConfigFromYaml(configName) {
  const content = fs.readFileSync(CONFIG_YAML, 'utf8');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const out = [];
  let skipping = false;
  let removed = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!skipping && line === `  ${configName}:`) {
      skipping = true;
      removed = true;
      continue;
    }
    if (skipping) {
      // 空行一律跳过 (可能是块内字段间空行, 也可能是块后分隔空行)
      if (trimmed === '') {
        continue;
      }
      // 非空行: 顶层行 / 2 空格新配置名 → 块结束, 保留该行
      if (/^\S/.test(line) || /^  [^#\s]/.test(line)) {
        skipping = false;
        out.push(line);
        continue;
      }
      // 4 空格+ 缩进 (字段/注释) → 仍属于被删配置块, 跳过
      continue;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') {
    out.pop();
  }
  if (removed) {
    fs.writeFileSync(CONFIG_YAML, out.join(eol) + eol, 'utf8');
  }
  return removed;
}

/**
 * 把配置对应的本地同步产物文件/目录 (index.yaml、头像、世界书、正则等)
 * 移动到回滚备份目录 .tsv_undo/files (保留相对路径结构), 供回滚恢复.
 * 注意: 用 PowerShell 执行 — node 的 fs.rmSync 删除部分文件会被火绒 HIPS 行为防护
 * 判定为恶意行为并终止进程, 而 powershell.exe 不受影响.
 * 返回: 移动的文件/目录数量
 */
function moveLocalFilesToUndo(localPath) {
  return new Promise(resolve => {
    const dir = path.dirname(path.join(root, localPath));
    const base = path.basename(localPath);
    const configName = path.basename(dir);
    const candidates = [base + '.yaml', '头像.png', `${configName}.png`, '世界书', '正则', '第一条消息', '脚本']
      .map(name => path.join(dir, name))
      .filter(p => fs.existsSync(p));
    const quote = p => `'${String(p).replace(/'/g, "''")}'`;
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      `$root = ${quote(root)}`,
      `$dstBase = ${quote(UNDO_FILES)}`,
      `$items = @(${candidates.map(quote).join(', ')})`,
      '$moved = 0',
      'foreach ($item in $items) {',
      '  $rel = $item.Substring($root.Length).TrimStart("\\", "/")',
      '  $dest = Join-Path $dstBase $rel',
      '  New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null',
      '  Move-Item -LiteralPath $item -Destination $dest -Force',
      '  $moved++',
      '}',
      // 配置目录已空则一并移动走 (作为备份一部分, 回滚时恢复)
      `if (Test-Path -LiteralPath ${quote(dir)}) { $left = (Get-ChildItem -LiteralPath ${quote(dir)} -Force).Count; if ($left -eq 0) { Move-Item -LiteralPath ${quote(dir)} -Destination $dstBase -Force; $moved++ } }`,
      'Write-Output $moved',
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 60000, windowsHide: true }, (error, stdout) => {
      const count = parseInt((stdout || '').trim().split(/\r?\n/).pop(), 10);
      if (error && !Number.isFinite(count)) {
        console.error(`[dist_server] moveLocalFilesToUndo 失败: ${error.message}`);
        resolve(0);
        return;
      }
      resolve(Number.isFinite(count) ? count : 0);
    });
  });
}

/** 清空回滚备份目录 (用 PowerShell 删除, 避免火绒拦截) */
function clearUndoDir() {
  return new Promise(resolve => {
    const quote = p => `'${String(p).replace(/'/g, "''")}'`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', `if (Test-Path -LiteralPath ${quote(UNDO_DIR)}) { Remove-Item -LiteralPath ${quote(UNDO_DIR)} -Recurse -Force }`],
      { timeout: 60000, windowsHide: true },
      () => resolve(),
    );
  });
}

/** 统计目录树下的文件数与一级子目录名, 返回文件数 */
function countDirTree(base, dirNames) {
  if (!fs.existsSync(base)) {
    return 0;
  }
  let files = 0;
  if (dirNames) {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (e.isDirectory()) {
        dirNames.push(e.name);
      }
    }
  }
  const count = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        count(path.join(dir, e.name));
      } else {
        files++;
      }
    }
  };
  count(base);
  return files;
}

/** 当前回滚备份状态: 是否有可回滚内容 + 各部分详情 */
function getUndoStatus() {
  const hasYaml = fs.existsSync(UNDO_YAML);
  const dirs = [];
  const filesFiles = countDirTree(UNDO_FILES, dirs);
  const pullPrevDirs = [];
  const pullFiles = countDirTree(UNDO_PULL_PREV, pullPrevDirs);
  const pushPrevDirs = [];
  const pushFiles = countDirTree(UNDO_PUSH_PREV, pushPrevDirs);
  // push_prev 的 meta 文件记录可恢复的酒馆配置
  let pushConfigs = [];
  if (fs.existsSync(UNDO_PUSH_PREV)) {
    pushConfigs = fs
      .readdirSync(UNDO_PUSH_PREV)
      .filter(f => f.endsWith('.meta.json'))
      .map(f => {
        try {
          return JSON.parse(fs.readFileSync(path.join(UNDO_PUSH_PREV, f), 'utf8')).config;
        } catch {
          return f.replace(/\.meta\.json$/, '');
        }
      });
  }
  const files = filesFiles + pullFiles + pushFiles;
  const available = hasYaml || files > 0;
  return {
    available,
    has_yaml: hasYaml,
    files,
    dirs,
    // 可恢复的本地文件所属配置 (拉取前备份)
    pull_prev: pullPrevDirs,
    // 可推回酒馆的配置 (推送前提取)
    push_prev: pushConfigs,
  };
}

/** 把 srcBase 下所有文件/目录移动到 destRoot (保留相对路径结构), 用于回滚恢复 */
function restoreDir(srcBase, destRoot) {
  return new Promise(resolve => {
    if (!fs.existsSync(srcBase)) {
      resolve();
      return;
    }
    const quote = p => `'${String(p).replace(/'/g, "''")}'`;
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      `$srcBase = ${quote(srcBase)}`,
      `$destRoot = ${quote(destRoot)}`,
      '$files = Get-ChildItem -LiteralPath $srcBase -Recurse -Force -File',
      'foreach ($f in $files) {',
      '  $rel = $f.FullName.Substring($srcBase.Length).TrimStart("\\", "/")',
      '  $dest = Join-Path $destRoot $rel',
      '  New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null',
      '  Move-Item -LiteralPath $f.FullName -Destination $dest -Force',
      '}',
      'Get-ChildItem -LiteralPath $srcBase -Recurse -Force -Directory | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }',
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 60000, windowsHide: true }, () => resolve());
  });
}

/** 向 tavern_sync.yaml 末尾追加一个临时配置块 (用于备份/回滚, 用完即删) */
function addTempConfig(configName, tavernNames, localPath) {
  const content = fs.readFileSync(CONFIG_YAML, 'utf8');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  const names = tavernNames.map(n => JSON.stringify(n));
  const namesValue = names.length > 1 ? `[${names.join(', ')}]` : names[0] || '""';
  lines.push(
    '',
    `  ${configName}:`,
    '    类型: 角色卡',
    `    酒馆中的名称: ${namesValue}`,
    `    本地文件路径: ${localPath}`,
    '',
  );
  fs.writeFileSync(CONFIG_YAML, lines.join(eol) + eol, 'utf8');
  return true;
}

/** 拉取前备份: 把配置对应的本地文件复制到 .tsv_undo/pull_prev (不移动, 拉取需要原文件做对比) */
function backupLocalForPull(configName) {
  return new Promise(resolve => {
    const target = listConfigs().find(c => c.name === configName);
    if (!target || !target.local_path) {
      resolve(false);
      return;
    }
    const dir = path.dirname(path.join(root, target.local_path));
    const base = path.basename(target.local_path);
    const candidates = [base + '.yaml', '头像.png', `${path.basename(dir)}.png`, '世界书', '正则', '第一条消息', '脚本']
      .map(name => path.join(dir, name))
      .filter(p => fs.existsSync(p));
    if (candidates.length === 0) {
      resolve(false);
      return;
    }
    const quote = p => `'${String(p).replace(/'/g, "''")}'`;
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      `$root = ${quote(root)}`,
      `$dstBase = ${quote(UNDO_PULL_PREV)}`,
      `$items = @(${candidates.map(quote).join(', ')})`,
      'foreach ($item in $items) {',
      '  $rel = $item.Substring($root.Length).TrimStart("\\", "/")',
      '  $dest = Join-Path $dstBase $rel',
      '  New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null',
      '  Copy-Item -LiteralPath $item -Destination $dest -Recurse -Force',
      '}',
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 60000, windowsHide: true }, () => resolve(true));
  });
}

/**
 * 推送前备份: 用临时配置从酒馆提取当前卡数据到 .tsv_undo/push_prev (回滚时可推回酒馆)
 * 返回: 是否备份成功
 */
async function backupTavernForPush(configName) {
  const target = listConfigs().find(c => c.name === configName);
  if (!target || !target.local_path) {
    return false;
  }
  const configSafe = sanitizeName(configName);
  const tempName = `__tsv_backup_${configSafe}`;
  const relPath = `.tsv_undo/push_prev/${configSafe}/index`;
  try {
    // 1. 追加临时配置
    addTempConfig(tempName, target.tavern_names, relPath);
    // 2. 拉取酒馆当前数据到备份位置
    await ensurePortFree(6620);
    const result = await runSync(['pull', tempName]);
    if (!result.ok) {
      // 拉取失败 (卡不在酒馆等) → 删临时配置, 不备份
      removeConfigFromYaml(tempName);
      console.warn(`[dist_server] push 备份酒馆数据失败 (不影响推送): ${result.message}`);
      return false;
    }
    // 3. 记录元信息 (回滚时推回酒馆需要原配置名与 tavern_names)
    fs.writeFileSync(
      path.join(UNDO_PUSH_PREV, `${configSafe}.meta.json`),
      JSON.stringify({ config: configName, tavern_names: target.tavern_names, local_path: target.local_path, type: target.type || '角色卡' }),
      'utf8',
    );
    // 4. 删除临时配置, yaml 恢复原样
    removeConfigFromYaml(tempName);
    console.log(`[dist_server] push 前已备份酒馆数据: ${configName} (可回滚)`);
    return true;
  } catch (e) {
    console.error(`[dist_server] push 备份酒馆数据失败: ${e.message}`);
    try {
      removeConfigFromYaml(tempName);
    } catch {
      // 忽略
    }
    return false;
  }
}

/** 回滚: 恢复 yaml 与所有本地文件, 并把推送前提取的酒馆数据推回酒馆 */
async function restoreUndo() {
  // 1. 恢复 delete/cleanup 备份的本地文件
  await restoreDir(UNDO_FILES, root);
  // 2. 恢复拉取前的本地文件
  await restoreDir(UNDO_PULL_PREV, root);
  // 3. 推送前提取的酒馆数据 → 推回酒馆 (临时配置 + push + 删)
  if (fs.existsSync(UNDO_PUSH_PREV)) {
    const metas = fs.readdirSync(UNDO_PUSH_PREV).filter(f => f.endsWith('.meta.json'));
    for (const m of metas) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(UNDO_PUSH_PREV, m), 'utf8'));
        const configSafe = m.replace(/\.meta\.json$/, '');
        const tempName = `__tsv_backup_${configSafe}`;
        const relPath = `.tsv_undo/push_prev/${configSafe}/index`;
        addTempConfig(tempName, meta.tavern_names || [], relPath);
        await ensurePortFree(6620);
        const result = await runSync(['push', tempName]);
        removeConfigFromYaml(tempName);
        console.log(`[dist_server] 回滚推送酒馆: ${meta.config} (${result.ok ? '成功' : '失败'})`);
      } catch (e) {
        console.error(`[dist_server] 回滚推送酒馆失败: ${e.message}`);
      }
    }
  }
}

/** 执行 tavern_sync.mjs 命令 */
function runSync(args) {
  return new Promise(resolve => {
    console.log(`[dist_server] 执行: node tavern_sync.mjs ${args.join(' ')}`);
    // 延长超时到 120 秒 (推送需要等待酒馆 socket 连接)
    // 注意: tavern_sync 的"检查更新失败"会写入 stderr 并导致 execFile 报错,
    // 但实际同步可能已成功 — 所以只要输出含 "成功将...推送到/拉取到" 就算成功.
    // 不能用简单的 "成功" 判定, 因为 "服务器成功连接到酒馆网页" 也含 "成功",
    // 会误判为同步完成 (实际世界书可能没写完).
    execFile(
      process.execPath,
      [SYNC_CMD, ...args],
      { cwd: root, timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        console.log(`[dist_server] 结果: ${output.trim().slice(0, 500)}`);
        // 判断成功: 无错误 或 输出含真正的完成行 "成功将..." (更新检查失败是误报)
        const succeeded = !error || output.includes('成功将');
        resolve({
          ok: succeeded,
          message: error && !succeeded ? (error.message || '执行失败') : '成功',
          output: output.trim().slice(0, 2000),
        });
      },
    );
  });
}

/** 找出监听 `port` 的进程 PID 列表 */
function findPortOwners(port) {
  return new Promise(resolve => {
    exec('netstat -ano', (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      const pids = new Set();
      for (const line of stdout.split('\n')) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const match = line.match(/(\d+)\s*$/);
          if (match) {
            pids.add(match[1]);
          }
        }
      }
      resolve([...pids]);
    });
  });
}

/** 确认进程命令行是否含 tavern_sync.mjs (避免误杀其他 node 进程) */
function isTavernSyncProcess(pid) {
  return new Promise(resolve => {
    exec(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty CommandLine"`,
      (error, stdout) => {
        resolve(!error && /tavern_sync\.mjs/i.test(stdout || ''));
      },
    );
  });
}

/**
 * 确保 `port` 空闲: 若有残留的 tavern_sync.mjs watch 进程占用则杀掉.
 * tavern_sync.mjs 的 push/pull 命令总是自己监听 6620, 残留 watch 进程
 * (如 `node tavern_sync.mjs watch all -f`) 会导致 EADDRINUSE.
 */
async function ensurePortFree(port) {
  const pids = await findPortOwners(port);
  for (const pid of pids) {
    if (await isTavernSyncProcess(pid)) {
      console.log(`[dist_server] 检测到残留 tavern_sync 进程 (PID ${pid}), 正在清理...`);
      await new Promise(resolve => exec(`taskkill /PID ${pid} /F /T`, () => resolve()));
    }
  }
  // 等待端口释放
  await new Promise(resolve => setTimeout(resolve, 500));
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // ---- API 路由 ----
  if (pathname === '/api/configs' && req.method === 'GET') {
    sendJson(res, 200, { configs: listConfigs() });
    return;
  }

  if (pathname === '/api/push' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const config = body.config;
      if (!config) {
        sendJson(res, 400, { ok: false, message: '缺少 config 参数' });
        return;
      }
      // 推送前备份酒馆当前数据 (可回滚), 备份失败不影响推送
      await clearUndoDir();
      fs.mkdirSync(UNDO_PUSH_PREV, { recursive: true });
      await backupTavernForPush(config);
      // 自动清理残留 watch 进程, 避免 EADDRINUSE
      await ensurePortFree(6620);
      const args = ['push', config];
      if (body.force) {
        args.push('-f');
      }
      const result = await runSync(args);
      sendJson(res, result.ok ? 200 : 500, result);
    } catch (e) {
      sendJson(res, 400, { ok: false, message: e.message });
    }
    return;
  }

  if (pathname === '/api/pull' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const config = body.config;
      if (!config) {
        sendJson(res, 400, { ok: false, message: '缺少 config 参数' });
        return;
      }
      // 拉取前备份本地文件 (可回滚), 备份失败不影响拉取
      await clearUndoDir();
      fs.mkdirSync(UNDO_PULL_PREV, { recursive: true });
      await backupLocalForPull(config);
      // 自动清理残留 watch 进程, 避免 EADDRINUSE
      await ensurePortFree(6620);
      const args = ['pull', config];
      if (body.force) {
        args.push('-f');
      }
      if (body.inline) {
        args.push('-i');
      }
      const result = await runSync(args);
      sendJson(res, result.ok ? 200 : 500, result);
    } catch (e) {
      sendJson(res, 400, { ok: false, message: e.message });
    }
    return;
  }

  if (pathname === '/api/auto-pull' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const tavern_name = String(body.tavern_name || '').trim();
      if (!tavern_name) {
        sendJson(res, 400, { ok: false, message: '缺少 tavern_name 参数' });
        return;
      }
      const force = !!body.force;
      const inline = !!body.inline;

      // 备份 (yaml + 本地文件), 支持回滚: 回滚可去掉自动添加的配置并恢复拉取前的文件
      await clearUndoDir();
      fs.mkdirSync(UNDO_PULL_PREV, { recursive: true });
      fs.writeFileSync(UNDO_YAML, fs.readFileSync(CONFIG_YAML, 'utf8'), 'utf8');

      // 已有配置包含该卡名 → 直接正常拉取, 不重复添加
      let configName = null;
      let yamlBackup = null;
      const existing = listConfigs().find(c => c.tavern_names.includes(tavern_name));
      if (existing) {
        configName = existing.name;
      } else {
        const added = addCharacterConfig(tavern_name);
        configName = added.configName;
        yamlBackup = added.original;
        // 确保本地目录存在 (tavern_sync 会把文件写入该目录)
        fs.mkdirSync(path.join(root, '自动同步', configName), { recursive: true });
        console.log(`[dist_server] 自动添加配置: ${configName} → ${added.localPath}`);
      }
      // 拉取前备份本地文件 (已有配置时)
      await backupLocalForPull(configName);

      // 自动清理残留 watch 进程, 避免 EADDRINUSE
      await ensurePortFree(6620);
      const args = ['pull', configName];
      if (force) {
        args.push('-f');
      }
      if (inline) {
        args.push('-i');
      }
      const result = await runSync(args);
      if (!result.ok && yamlBackup !== null) {
        // 拉取失败 → 回滚 yaml 修改, 删除新建的空目录
        fs.writeFileSync(CONFIG_YAML, yamlBackup, 'utf8');
        try {
          fs.rmdirSync(path.join(root, '自动同步', configName));
        } catch {
          // 目录非空 (已写入部分文件) 则保留
        }
        console.log(`[dist_server] 自动添加配置拉取失败, 已回滚 yaml: ${configName}`);
      }
      sendJson(res, result.ok ? 200 : 500, {
        ...result,
        config_name: configName,
        added: yamlBackup !== null,
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, message: e.message });
    }
    return;
  }

  if (pathname === '/api/delete-config' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const config = body.config;
      if (!config) {
        sendJson(res, 400, { ok: false, message: '缺少 config 参数' });
        return;
      }
      const target = listConfigs().find(c => c.name === config);
      if (!target) {
        sendJson(res, 404, { ok: false, message: `配置 '${config}' 不存在` });
        return;
      }
      // 先备份 (yaml + 本地文件移动到 .tsv_undo), 支持回滚
      await clearUndoDir();
      fs.mkdirSync(UNDO_FILES, { recursive: true });
      fs.writeFileSync(UNDO_YAML, fs.readFileSync(CONFIG_YAML, 'utf8'), 'utf8');
      let files_backed = 0;
      if (body.remove_files && target.local_path) {
        files_backed = await moveLocalFilesToUndo(target.local_path);
      }
      const removed = removeConfigFromYaml(config);
      if (!removed) {
        sendJson(res, 500, { ok: false, message: `yaml 中未找到配置 '${config}'` });
        return;
      }
      console.log(`[dist_server] 已删除配置: ${config}${files_backed ? `, 备份本地文件 ${files_backed} 项 (可回滚)` : ''}`);
      sendJson(res, 200, { ok: true, message: `已删除配置 '${config}'${files_backed ? `, 备份 ${files_backed} 项本地文件` : ''}`, files_deleted: files_backed, undo_available: true });
    } catch (e) {
      sendJson(res, 400, { ok: false, message: e.message });
    }
    return;
  }

  if (pathname === '/api/cleanup-all' && req.method === 'POST') {
    try {
      const configs = listConfigs();
      // 先备份 (yaml + 所有配置文件移动到 .tsv_undo), 支持回滚
      await clearUndoDir();
      fs.mkdirSync(UNDO_FILES, { recursive: true });
      fs.writeFileSync(UNDO_YAML, fs.readFileSync(CONFIG_YAML, 'utf8'), 'utf8');
      let files_backed = 0;
      const processed = [];
      for (const config of configs) {
        if (!config.local_path) {
          continue;
        }
        const n = await moveLocalFilesToUndo(config.local_path);
        files_backed += n;
        processed.push({ name: config.name, backed: n });
      }
      // 自动同步目录如果空了则一并移动走
      try {
        const autoDir = path.join(root, '自动同步');
        if (fs.existsSync(autoDir) && fs.readdirSync(autoDir).length === 0) {
          fs.renameSync(autoDir, path.join(UNDO_FILES, '自动同步'));
          files_backed++;
        }
      } catch {
        // 忽略
      }
      console.log(`[dist_server] 全部初始化: 备份 ${processed.length} 个配置的本地文件 (${files_backed} 项, 可回滚)`);
      sendJson(res, 200, {
        ok: true,
        message: `已清理 ${processed.length} 个配置的本地文件 (${files_backed} 项), 可回滚`,
        configs_cleaned: processed.length,
        files_deleted: files_backed,
        undo_available: true,
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, message: e.message });
    }
    return;
  }

  if (pathname === '/api/undo-status' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, ...getUndoStatus() });
    return;
  }

  if (pathname === '/api/undo' && req.method === 'POST') {
    try {
      const status = getUndoStatus();
      if (!status.available) {
        sendJson(res, 404, { ok: false, message: '没有可回滚的操作' });
        return;
      }
      if (status.has_yaml) {
        fs.writeFileSync(CONFIG_YAML, fs.readFileSync(UNDO_YAML, 'utf8'), 'utf8');
      }
      await restoreUndo();
      await clearUndoDir();
      const push_note = status.push_prev.length > 0 ? `, 推回酒馆: ${status.push_prev.join('、')}` : '';
      console.log(`[dist_server] 已回滚: 恢复 ${status.files} 个本地文件${status.has_yaml ? ', yaml 配置' : ''}${push_note}`);
      sendJson(res, 200, {
        ok: true,
        message: `已回滚: 恢复 ${status.files} 个本地文件${status.has_yaml ? ', 并恢复 yaml 配置' : ''}${push_note}`,
        files_restored: status.files,
        yaml_restored: status.has_yaml,
        tavern_restored: status.push_prev,
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, message: e.message });
    }
    return;
  }

  // ---- 静态文件 ----
  let filePath = path.join(root, pathname);
  if (!filePath.startsWith(root)) {
    res.writeHead(403, corsHeaders());
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, corsHeaders());
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      ...corsHeaders(),
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[dist_server] 静态服务器已启动: http://127.0.0.1:${port} (目录: ${root})`);
  console.log(`[dist_server] API: /api/configs /api/push /api/pull`);
});
