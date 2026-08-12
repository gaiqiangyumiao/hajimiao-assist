# 酒馆助手 变量 / 脚本 / 页面 开发避坑参考

> 基于师尊卡实际踩坑经验，2026-08-12 整理。

---

## 📋 迭代规则

**每次报错修复后，将问题症状 + 根因 + 解决方案以条目形式追加到下方「问题案例库」中。** 下次遇到同类问题直接检索，避免重复排查。

**这些方案不是万能药**——如果已有的方案不适用于当前场景（环境不同、版本不同、偶发因素），不要强行套用，从头排查、想出新的针对性方案。

**问题已解决 ≠ 方案可移除**——保留所有历史案例，即使后续重构了相关模块。旧方案可能对新模块的类似问题仍有参考价值。

---

## ⚠️ 禁止操作

- **严禁未经用户明确允许执行推送 (`push`) 或拉取 (`pull`)**。所有 tavern_sync 操作（推送、拉取、自动拉取、删除配置、全部初始化）必须用户口头确认后才能执行，不得擅自操作酒馆数据。
- yarn 构建后的 `dist/tavern_sync/index.js` 版本号 (`?v=N`) 需要用户手动递增，不得替用户改。

---

## 一、变量 (MVU) 相关

### 1. `{{user}}` 不能用作变量键名

`{{user}}` 是酒馆宏，会被渲染成玩家名。MVU 变量树里的键名是**字面量**，不会被宏替换。如果键名叫 `{{user}}`，AI 和状态栏看到的是渲染后的玩家名（如「晓叶」），但变量树键是字面 `{{user}}` → 路径断裂。

**正确做法**：变量键用中性名（如 `玩家`、`主角`、`user`），世界书/状态栏/更新规则里统一用这个中性名做路径，内容文本里照常用 `{{user}}`。

### 2. `z.record()` 初始化不可靠

`z.record(key, value).prefault({...})` 在 PC 端 MVU 能正常初始化默认值，但手机端/某些版本不会生成空对象 → 路径为 `undefined` → AI `insert` 操作报错：「路径保存的是原始值（undefined），无法向其中 assign」。

**正确做法**：固定键的字典用 `z.object({ key1: ..., key2: ... })` 显式定义，不要用 `z.record`。只有真正的动态键（如 NPC 列表）才用 record。

### 3. 改变量结构后必须重置

修改 `变量结构.js` 中的键名/结构后，推送到酒馆 → 点 MVU 的「重新读取初始变量」或开新对话，否则旧 `stat_data` 残留旧键，状态栏和 AI 都会读到 `undefined`。

### 4. 世界书 EJS 里的 `stat_data` 路径

世界书（如 `苏璃烟.txt`、`{{user}}.txt`）里的 `<% if (stat_data.xxx) %>` 使用的路径必须和变量结构键名**完全一致**。变量键改名时，世界书里的 EJS 引用要同步改。漏改会导致性格调色盘/NSFW 调色盘失效（读到 `undefined` 永远走第一个分支）。

### 5. 变量更新规则里不要出现不一致的路径

更新规则（变量更新规则_id4.txt）里写的路径（如 `玩家.互换状态.男体化程度`）必须和变量结构一致。路径铁律类规则（「互换后写 苏璃烟.*」）清晰即可。

---

## 二、状态栏 / 正则 HTML 页面

### 1. `{{user}}` 在 `<script>` 里会被宏处理破坏

酒馆消息管线会对消息全文做宏替换，包括 `<script>` 标签内的 `{{user}}`。如果玩家的名字含特殊字符（引号、反斜杠等），JS 语法断裂。

**正确做法**：JS 里运行时获取玩家名：
```js
var playerName = typeof SillyTavern !== 'undefined' && SillyTavern.name2 ? SillyTavern.name2 : '{{user}}';
```
HTML 显示文本里的 `{{user}}`（非 `<script>` 内）可以保留，宏替换是安全的。

### 2. 正则注入的 HTML 可能被二次处理

酒馆消息管线可能对同一消息多次执行宏替换/正则 → 注入的 HTML 里的 JS 和宏标记被反复处理 → content 损坏。

**防护**：
- JS 内不用宏
- 整个渲染函数外包 `try-catch`（异常跳过不毁 DOM）
- 状态栏如果渲染失败静默降级，不要往 DOM 里塞原始数据

### 3. 弹出遮罩/lightbox 挂载位置

消息内的 `position: fixed` 可能被消息容器（overflow/transform/iframe）裁剪。遮罩必须挂到最外层页面：
```js
const topDoc = (window.top && window.top.document) || document;
topDoc.body.appendChild(mask);
```

### 4. 移动端适配

- `grid-template-columns: 1fr 1fr` 在小屏（<600px）改为单列
- 头像/字号缩放（`@media` 分段）
- 手机端 `getAllVariables()`/`getVariables()` 可能不可用（沙箱限制），`readStat()` 需要 fallback 链
- 手机端 MVU 脚本执行环境 ≠ PC，复杂自执行 IIFE 可能被拦

### 5. `<details>` 折叠块兼容

- `<details>` 内容在折叠时 DOM 仍存在，`getElementById` 正常命中
- 定期刷新（`setInterval`）保证展开瞬间有最新数据
- 注意不要因为 `details` 内外样式差异导致渲染断裂

---

## 三、YAML 相关

### 1. `{{` 开头值 == YAML 解析错误

YAML 把 `{` 当作 flow mapping 开头。索引/列表/键值中以 `{{` 开头的裸值会炸：
```yaml
# ✗ 错误
名称: {{user}}_id2
- {{user}}，徒儿

# ✓ 正确
名称: "{{user}}_id2"
- "{{user}}，徒儿"
```

### 2. dist_server 手写 YAML 解析器

`dist_server.cjs` 的 `listConfigs()` 和 `removeConfigFromYaml()` 是手写行解析，不是用 yaml 库。注意：
- 双引号字符串（`酒馆中的名称: "含特殊字符的卡名"`）需要用 `JSON.parse` 或等价方式解析
- **空行不能作为配置块结束标志**（块内字段间可能有空行）→ 只有「顶层行」或下一个「2 空格配置名」才算块结束

### 3. tavern_sync 报 `YAMLParseError` == yaml 被写坏

tavern_sync.mjs 内部用 yaml 库解析。如果报这个错，说明 dist_server 的 `addCharacterConfig` 或 `removeConfigFromYaml` 把 yaml 写坏了。立即停止操作、检查 yaml、修复解析器。

---

## 四、dist_server 相关

### 1. 火绒杀进程

火绒 HIPS 会在 node.exe 删除特定文件时直接 kill 进程（无 JS 异常栈）。**所有文件删除操作改用 PowerShell**：
```js
execFile('powershell.exe', ['-NoProfile', '-Command', script], ...)
```
不用 `fs.rmSync` 做大范围删除，不用 `exec('cmd ...')` 避免 GBK 乱码。

### 2. 进程残留

`tavern_sync.mjs` 的 `watch` 模式占用 6620（socket.io）。`dist_server` 的 push/pull/auto-pull 前自动 `ensurePortFree(6620)`，用 PowerShell 校验命令行含 `tavern_sync.mjs` 才杀。

### 3. 零依赖

`dist_server.cjs` 只使用 Node 内置模块（http/fs/path/child_process），可独立部署。

---

## 五、卡间共享注意事项

推送前确认：
- 无私人信息（玩家名 `{{user}}` 代替）
- YAML 4/4 解析通过
- 状态栏头像 URL 用可靠 CDN（GitHub raw / catbox 等）
- MVU 脚本启用（`启用: true`）
- 备份原卡数据再推送（推送不可逆）
