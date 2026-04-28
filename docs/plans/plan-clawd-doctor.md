# Plan: Clawd Doctor

> 状态：Draft v10，Step 2 落地后 review notes 已记录
> 日期：2026-04-28
> 目标分支建议：`feat/clawd-doctor`
> 上游文档：`docs/project/github-market-position-and-growth-priorities.md` 中的 P0 项

## 0. 修订记录

### v10 相对 v9（Step 2 落地后 review notes）

1. **LOW：`doctor:test-connection` IPC 缺少主进程并发护栏**：当前 Settings modal 有 `connectionTesting` UI 侧防重入，但 `src/main.js` 的 `doctor:test-connection` handler 每次调用都会新起一个 `runConnectionTest()` 10s 窗口。未来如果复制报告、自动诊断或其他入口复用该 IPC，可能并行运行多个测试并互相覆盖 `lastDoctorConnectionTest`。建议后续在 main 进程加 `pendingConnectionTest` Promise 去重：已有测试运行时直接返回同一个 Promise，`finally` 后清空。
2. **LOW：ringbuffer record 调用点多于原计划，后续维护需留意**：v8 plan 用"5 个逻辑出口"描述，但实际 `/permission` 有 opencode / Codex / Claude 多分支，以及 headless / passthrough / bubble-disabled 等 accepted 变体，落地后约 17 个 `recordHookEvent(...)` 调用点。当前实现有单测覆盖关键路径，不阻塞发版；后续如果 server.js 增加新 permission 分支，要同步补 record，否则连接测试可能把该路径误判成"无 HTTP 活动"。不建议发版前为此大重构；后续可先抽小 helper 降低重复，避免一次性 decorator 重写 700-1200 行带来额外风险。

### v9 相对 v8（开工前边界校准）

1. **Step 1 / Step 2 边界收紧**：ringbuffer、Test connection、`doctor:open-clawd-log` 明确归 Step 2。Step 1 只实现 4 项静态检查、报告复制和 Settings 入口，不改 `/state` / `/permission` 事件水位记录。
2. **permission bubble policy 复用现有运行时策略**：Doctor 不直接只看 `prefs.permissionBubblesEnabled`。应通过现有 bubble policy 语义判断全局 permission bubble 是否启用，覆盖 `hideBubbles` 兼容字段；agent 级 `permissionsEnabled` 不作为 4.3 全局检查失败条件，而在 `agent-integrations` detail / report 中提示，避免"全局可弹但某 agent 子开关关闭"被误报成全局故障。
3. **Kimi command parser 支持单 / 双引号**：虽然 installer 当前写 `command = '...'`，历史配置和容错测试要求 `findKimiHookCommands(text, marker)` 同时支持 `command = "..."`，并处理 `\"` 转义；实现可复用 `hooks/kimi-install.js` 现有 `lineRegex` 思路。
4. **prefs 默认 agents 补齐 `kimi-cli`**：registry 已是 9 个 agent，`src/prefs.js` 默认 agents 也必须包含 `kimi-cli`。Doctor 自身仍用 default-true gate helper 读 enabled，避免旧 prefs 缺项被误判禁用。
5. **i18n key 使用现有语言 id**：Settings 现有语言 id 是 `en` / `zh` / `ko`，完成定义从 `zh-CN / ko-KR` 改为 `zh / ko`。

### v8 相对 v7（采纳 codex 第七轮 review）

1. **Kimi 也要抽出 command 跑 4.2.3 完整校验**：v7 用 `containsClawdHookCommand(text, marker)` 只返 boolean——不够。`hooks/kimi-install.js:190-194` 写入的 command 里包含完整 nodeBin / scriptPath / env prefix，hook 注册正常但 scriptPath 失效（如 Clawd 移动安装目录）也会被 v7 判 ok。v8 把 Kimi helper 改成 `findKimiHookCommands(text, marker)` 返回所有 `command = '...'` 内层字符串数组，每条复用 4.2.3 完整校验（同其他 file mode agent）。
2. **cmd wrapper regex 第三个 switch 是 `/c`**：v7 写 `^cmd /[ds]/[ds]/[ds] ""(.+)""$`——错。`hooks/json-utils.js:65` 真实输出 `cmd /d /s /c "${command}"`，第三个固定是 `/c`（exit-and-return-after-running）不是任意 `d|s`。v8 改为 `^cmd /d /s /c "(.+)"$`，捕获组拿内层 command（双引号包裹）。golden roundtrip 单测会抓到错误 regex，但 plan 里的算法描述本身要先修对。
3. **ringbuffer outcome 不能单点记录**：v7 写"在 JSON parse 后、所有 gate 前一次 record"——错。outcome 只有走过具体 gate / setState 才知道：
   - `/state` 的 agent enabled gate 在 `src/server.js:667`（return 204）
   - `/state` 的 setState DND 在 **`src/state.js:266`**（更深层，server 看不到）
   - `/permission` 的 DND gate 在 `src/server.js:880`
   - `/permission` 的 agent enabled gate 在 `src/server.js:886`

   单点记录要求"未来才知道的事现在写"，无解。v8 改为**每个出口分支前独立 record**：
   - return 204 (agent disabled) 前 → record outcome='dropped-by-disabled'
   - 调 setState 前先查 `ctx.doNotDisturb`（重复 state.js 内的判定）→ DND=true 时 record outcome='dropped-by-dnd'，否则 record outcome='accepted'
   - permission DND gate 前 → 'dropped-by-dnd'
   - permission agent gate 前 → 'dropped-by-disabled'
   - permission accepted 路径末端 → 'accepted'

   每条命令路径上**只 record 一次**（不会重复入 ringbuffer）。

### v7 相对 v6（已落地）

> opencode entry 完整校验（4 reasons）/ cmd wrapper 真实双引号外壳 / `findHookCommands` 替换 `extractExistingNodeBin` / PowerShell `$env:` / permission ringbuffer 路由归一化。

### v6 / v5 / v4 / v3 / v2（已落地）

> scriptPath 校验 / Kiro 复用完整校验 / Codex tri-state / theme cache 副作用规避 / Step 2 三分支 / Gemini 放回 HTTP / parentDir+configFile 两层 / Cursor `~/.cursor/hooks.json` / 9 agent / 纯文字 textHint。

### 工作量演变

| 版本 | 工作量 | 主要新增 |
|---|---|---|
| v1 | 2.3 天 | 初稿（错很多）|
| v2 | 3.7 天 | agent 数 7→9、Step 1 真只读 |
| v3 | 4.8 天 | 9 agent descriptor 重写、Windows 命令解析 |
| v4 | 5.2 天 | installer 导出常量、TOML 不引依赖 |
| v5 | 6.0 天 | Codex features check、Kiro dir scan、theme `_resolveAssetPath` |
| v6 | 6.5 天 | scriptPath 校验、`_externalAssetsSourceDir`、tri-state、通用 env、Step 2 三分支 |
| v7 | 7.1 天 | cmd wrapper 双引号外壳、PowerShell env、opencode validator、`findHookCommands`、golden roundtrip |
| v8 | **~7.2 天** | Kimi helper 改 API、ringbuffer 多点记录（增量很小）|
| v9 | **~7.2 天** | Step 边界收紧、bubble policy 对齐现有实现、Kimi 双引号容错、prefs/i18n 校准 |

每次涨工作量都是在 review 中暴露的真实风险，不是新需求。这条 plan 越长越保守，但实现时踩坑次数会成倍下降。

---

## 1. 背景

GitHub issue 区"装完用不起来"占据真实排障量大头：

| 类别 | 占比 | 典型 issue | 用户视角 |
|---|---|---|---|
| Hook 没接上 / 状态不更新 | ~50% | #4 #7 #19 #147 #163 #193 | "桌宠不动" |
| 代理 / 端口 / 防火墙拦截 | ~15% | #37 + 企业 EDR | "感叹号有，卡片无" |
| 找不到现成功能 | ~20% | #94 #114 | "怎么换主题" |
| 平台特定 bug | ~15% | #59 #93 #109 #66 | macOS/HiDPI/Linux |

Doctor 目标：回答 **"为什么我的桌宠不动？"**。第三类不归 Doctor，第四类不归 Doctor。

## 2. 目标 / 非目标

### 目标

- 用户自助判断"桌宠不动"故障点
- 维护者收 issue 时拿到结构化诊断报告
- 不引入扫描/上报后台任务

### 非目标

- 不做更新通道、远程 SSH、平台 bug 自动修
- 不做诊断结果上报、遥测
- **Step 1 不引入任何 fix 按钮**
- 不做项目级 `.claude/settings.local.json` 检测（issue #107；无 cwd 上下文）
- Doctor 自身**不**修改 prefs / 不重启 server / **不动主题**

## 3. UX 与入口

### 3.1 入口位置

Settings sidebar 顶部增加常驻"健康指示器"行：

```
sidebar
├── [新增] DoctorIndicator     ← 圆点 + 文案，整行点击打开 modal
├── General
├── Agents
├── ...
└── About
```

### 3.2 Doctor 面板（modal）

```
┌─────────────────────────────────────────────┐
│ Clawd Doctor                          [×]    │
├─────────────────────────────────────────────┤
│ Overall: ⚠️ 1 warning                        │
│ ✓ Local server (port 23333)                  │
│ ⚠️ Agent integrations: 1 not connected       │
│      ▶ claude-code (hook): ok                │
│      ▶ cursor-agent (hook): not-connected    │
│      ▶ ... (9 entries total)                 │
│ ⚠️ Permission bubbles: globally disabled     │
│ ✓ Theme: clawd (validated)                  │
│ [Copy diagnostic report]  [Re-run checks]    │
│ Privacy notice: ...                          │
└─────────────────────────────────────────────┘
```

### 3.3 状态点颜色规则

| 颜色 | 触发条件 |
|---|---|
| 红 | 任意 `level=critical` 失败 |
| 黄 | 至少一项 `level=warning` 失败 |
| 绿 | 全部通过（`level=info` 不影响整体）|

## 4. Step 1 检查项规格（4 项）

### 4.1 `local-server`

**检查**：
1. server 在 listen（`server.address()` 非空）
2. `~/.clawd/runtime.json` 存在且 `port` 与本进程实际 listen 端口一致

| 条件 | level | 状态 |
|---|---|---|
| server 没在 listen | critical | fail |
| server 在 listen，runtime.json 缺失 / port 不一致 | warning | fail |
| 都 ok | — | pass |

**textHint**：
- critical：`"Restart Clawd. If the issue persists, check ~/.clawd/ permissions."`
- warning：`"Restart Clawd to regenerate the runtime file."`

**实现**：`src/server.js` 暴露 `getRuntimeStatus()`。

### 4.2 `agent-integrations`

#### 4.2.1 9 个 agent descriptor 表

集中在 `src/doctor-detectors/agent-descriptors.js`：

| agentId | parentDir | configPath / configMode | autoInstall | detection 方法 | supplementary |
|---|---|---|---|---|---|
| `claude-code` | `~/.claude` | file `~/.claude/settings.json` | ✓ | `findHookCommands(settings, "clawd-hook.js", {nested:true})` → 每条跑 4.2.3 | — |
| `codex` | `~/.codex` | file `~/.codex/hooks.json` | ✓ | `findHookCommands(settings, "codex-hook.js", {nested:true})` | `[features].codex_hooks` tri-state（4.2.6）|
| `copilot-cli` | — | none-global | ✗ | 仅检查 hook 脚本可执行 | — |
| `cursor-agent` | `~/.cursor` | file `~/.cursor/hooks.json` | ✓ | `findHookCommands(settings, "cursor-hook.js")` | — |
| `gemini-cli` | `~/.gemini` | file `~/.gemini/settings.json` | ✓ | `findHookCommands(settings, "gemini-hook.js")` | — |
| `codebuddy` | `~/.codebuddy` | file `~/.codebuddy/settings.json` | ✓ | `findHookCommands(settings, "codebuddy-hook.js", {nested:true})` | — |
| `kiro-cli` | `~/.kiro` | dir `~/.kiro/agents/` | ✓ | 扫每个 *.json 跑 `findHookCommands(...)` → 每条跑 4.2.3（4.2.5）| — |
| `kimi-cli` | `~/.kimi` | toml-text `~/.kimi/config.toml` | ✓ | **`findKimiHookCommands(text, "kimi-hook.js")`** → 每条跑 4.2.3（v9）| — |
| `opencode` | `~/.config/opencode` | file `~/.config/opencode/opencode.json` | ✓ | `plugin` 数组找 abs basename → `validateOpencodeEntry`（4.2.8）| — |

**新增 helper**：

- `findHookCommands(settings, marker, opts)` → `string[]`：在 `hooks/json-utils.js` 旁，遍历 settings.hooks 各 event 数组（含 nested），返回所有 command 字符串中含 marker 的完整命令
- **`findKimiHookCommands(tomlText, marker)`** → `string[]`（v9 替代 `containsClawdHookCommand`）：扫 `command = '...'` / `command = "..."`，返回内层 command 字符串数组；双引号分支需处理 `\"` 转义；对含 marker 的命中保留。

#### 4.2.2 单 agent 判定流程

```
1. prefs.agents[agentId].enabled === false?
   → status: "disabled", level: info

2. agentId === "claude-code" && prefs.manageClaudeHooksAutomatically === false?
   → status: "manual-managed", level: info

3. configMode === "none-global" (Copilot)?
   → status: "manual-only", level: info

4. parentDir 不存在 → status: "not-installed", level: info

5. 按 configMode 分支:

   configMode === "file":
     文件不存在:
       autoInstall=true  → "not-connected", warning
       autoInstall=false → "manual-only", info
     文件存在但解析失败 → "config-corrupt", warning
     文件存在 + 解析成功:
       cmds = findHookCommands(settings, marker, {nested})
       (按下方公共流程处理 cmds)

   configMode === "toml-text" (Kimi):
     文件不存在 → "not-connected" (autoInstall=true), warning
     文件存在:
       cmds = findKimiHookCommands(text, marker)
       (按下方公共流程处理 cmds)

   configMode === "dir" (Kiro): 见 4.2.5

公共流程处理 cmds:
   - cmds.length === 0 → "not-connected", warning
   - 对每条 cmd 跑 4.2.3 完整校验:
       - 至少一条 fully-valid → 进入 supplementary check (4.2.6) 或直接 ok
       - 0 条 fully-valid 但全有 marker → "broken-path", warning
         detail 注明第一条失败的具体 hookCommandIssue

仅 opencode 走特殊路径：
   读 settings.plugin[]，找 abs path basename = "opencode-plugin"
   - 没找到 → "not-connected", warning
   - 找到 → validateOpencodeEntry(entry) (4.2.8)
```

#### 4.2.3 Hook 命令完整校验（v8 修正 cmd regex）

输入是单条命令字符串。可能形态：

```
# POSIX 绝对路径
"/usr/local/bin/node" "/path/to/clawd-hook.js"

# Windows PowerShell wrapper
& "node" "C:\path\to\clawd-hook.js"

# Windows cmd wrapper（v7 已修：双引号外壳）
cmd /d /s /c ""C:\Program Files\nodejs\node.exe" "D:/app/hooks/codex-debug-hook.js""

# Kimi POSIX env prefix
CLAWD_KIMI_PERMISSION_MODE=suspect "/usr/local/bin/node" "/path/to/kimi-hook.js"

# Codex Windows PowerShell env prefix
$env:CLAWD_REMOTE='1'; & "node" "C:\path\to\codex-hook.js"
```

**解析步骤**（v8）：

1. **识别 cmd wrapper**：若命令匹配 `^cmd /d /s /c "(.+)"$`（v8 关键修正：第三个固定 `/c`，不是任意 `d|s`），取捕获组作为内层命令
2. 剥离 PowerShell env 前缀：`^(?:\$env:[A-Za-z_]\w*=[^;]+;\s*)*`
3. 剥离 POSIX env 前缀：`^\s*(?:[A-Za-z_]\w*=\S+\s+)*`
4. 剥离 PowerShell `&` 调用前缀：`^&\s+`
5. 抽第一个 quoted token（或第一个 non-flag non-empty token）= `nodeBin`
6. 抽第二个 quoted token = `scriptPath`

**完整判定矩阵**：

| 维度 | 平台 | 值 | 判定 |
|---|---|---|---|
| nodeBin | Windows | `"node"` 或 `node` | trust |
| nodeBin | Windows | 绝对路径 | `fs.accessSync(path)` 检查存在 |
| nodeBin | macOS / Linux | 绝对路径 | `fs.accessSync(path, fs.constants.X_OK)` |
| nodeBin | macOS / Linux | 裸 `node` | **broken-path** |
| scriptPath | 所有平台 | 必须**绝对路径** | 否则 broken-path |
| scriptPath | 所有平台 | 必须 `fs.existsSync(path)` | 否则 broken-path |

任一失败 → `broken-path`，detail 注明 `hookCommandIssue`：
- `'nodeBin-invalid'` + nodeBin 实际值
- `'scriptPath-missing'` + scriptPath 实际值
- `'parse-failed'` + 截断后的命令片段（128 字符）

#### 4.2.4 整体聚合

| 条件 | 整体 status |
|---|---|
| 9 个全部 `not-installed` / `disabled` / `manual-only` | critical |
| 至少 1 个 `not-connected` / `broken-path` / `config-corrupt` | warning |
| 至少 1 个 `ok`（仅 supplementary `uncertain` 不算 fail）且无 warning | pass |

#### 4.2.5 Kiro dir-mode 流程

```
1. parentDir ~/.kiro 不存在 → "not-installed", info
2. agentsDir ~/.kiro/agents/ 不存在 → "not-connected", warning
3. 列 *.json（跳过 *.example.json）；超 50 截断
4. 对每个 .json：
   a. 解析失败 → "config-corrupt"
   b. cmds = findHookCommands(settings, "kiro-hook.js", {nested:true})
      cmds.length === 0 → "no-marker"
      对每条跑 4.2.3:
        至少一条 fully-valid → "fully-valid"
        全 broken → "all-broken"
5. 聚合:
   至少一个 "fully-valid" → "ok"
     detail: "{N} hooked agent(s)... Use 'kiro-cli --agent <name>' to activate."
   0 fully-valid + 至少一个 all-broken → "broken-path", warning
   全 no-marker / config-corrupt → "not-connected" / "config-corrupt"
```

#### 4.2.6 Codex supplementary（tri-state）

```
读 ~/.codex/config.toml（不存在 → uncertain）
扫描 [features] 段:
  codex_hooks = true   → "enabled"，主 status ok
  codex_hooks = false  → "disabled"，主 status 改 not-connected/warning
  缺段 / 缺 key / 解析失败 → "uncertain"，主 status 仍 ok 但 supplementary uncertain
```

#### 4.2.7 textHint

| status / 子情况 | textHint |
|---|---|
| `not-connected`（autoInstall=true）| `"Open Settings → Agents and toggle this agent on (auto-installer will register the hook)."` |
| `not-connected`（autoInstall=false）| `"Manually register Clawd's hook. See docs/guides/setup-guide.md."` |
| `not-connected`（codex_hooks=false）| `"Set [features].codex_hooks = true in ~/.codex/config.toml, or reinstall Codex hooks via Settings → Agents."` |
| `not-connected`（kiro 0 hooked）| `"Open Settings → Agents and toggle Kiro on; then run 'kiro-cli --agent clawd' or '/agent swap clawd' inside Kiro."` |
| `broken-path`（nodeBin invalid）| `"Hook command points to a non-executable node binary at {path}. Reinstall via Settings → Agents."` |
| `broken-path`（scriptPath missing）| `"Hook command points to {path} but the script no longer exists. Clawd may have been moved or reinstalled. Reinstall via Settings → Agents."` |
| `broken-path`（opencode plugin）| 按 4 种 reason 区分（见 4.2.8）|
| `broken-path`（parse-failed）| `"Could not parse hook command: {fragment}. Reinstall via Settings → Agents."` |
| `config-corrupt` | `"Config file at {path} could not be parsed. Restore from backup or remove it."` |
| `manual-only` | `"This agent uses project-level config. See docs/guides/setup-guide.md."` |
| `disabled` | `"You disabled this agent in Settings. Toggle it on to receive events."` |
| supplementary `uncertain` (codex) | `"Cannot confirm [features].codex_hooks is enabled. Open ~/.codex/config.toml to verify, or reinstall Codex hooks via Settings → Agents."` |

#### 4.2.8 opencode plugin entry 校验

```js
function validateOpencodeEntry(entry) {
  if (!path.posix.isAbsolute(entry) && !path.win32.isAbsolute(entry)) {
    return { ok: false, reason: 'not-absolute' };
  }
  let stat;
  try { stat = fs.statSync(entry); } catch { return { ok: false, reason: 'directory-missing' }; }
  if (!stat.isDirectory()) return { ok: false, reason: 'not-a-directory' };
  if (!fs.existsSync(path.join(entry, 'index.mjs'))) return { ok: false, reason: 'index-mjs-missing' };
  return { ok: true };
}
```

### 4.3 `permission-bubble-policy`

**检查**：现有 permission bubble policy + `doNotDisturb`

实现要求：
- 用与运行时一致的语义判断全局 permission bubble 是否启用（等价于 `getBubblePolicy(snapshot, "permission").enabled`），所以 `hideBubbles=true` 也必须判为全局 bubble 关。
- per-agent `agents[agentId].permissionsEnabled=false` 不让 4.3 失败；该信息在 4.2 agent detail / report 中提示，例如 `permission bubbles disabled for this agent`。

| 条件 | level | 状态 |
|---|---|---|
| 全局 bubble 关 | warning | fail |
| DND 开 | info | "DND is on; bubbles are suppressed" |
| 都开 | — | pass |

**textHint**：
- warning：`"Open Settings → General and turn on permission bubbles."`
- info：`"Right-click the pet and toggle DND off if you want bubbles back."`

### 4.4 `theme-health`

`src/theme-loader.js` 新增导出 `validateThemeShape`，使用 `_externalAssetsSourceDir` 只读 helper（不调 `_resolveExternalAssetsDir` 避免触发 cache rebuild）。

```js
function validateThemeShape(themeId, opts = {}) {
  const variant = typeof opts.variant === "string" ? opts.variant : "default";
  const overrides = _isPlainObject(opts.overrides) ? opts.overrides : null;

  const { raw, isBuiltin, themeDir } = _readThemeJson(themeId);
  if (!raw) return { ok: false, errors: [`Theme "${themeId}" not found`] };

  const rawErrors = validateTheme(raw);
  const { resolvedId, spec } = _resolveVariant(raw, variant);
  const afterVariant = spec ? _applyVariantPatch(raw, spec, themeId, resolvedId) : raw;
  const patched = overrides ? _applyUserOverridesPatch(afterVariant, overrides) : afterVariant;
  const effective = mergeDefaults(patched, themeId, isBuiltin);

  effective._builtin = isBuiltin;
  effective._themeDir = themeDir;
  if (!isBuiltin) effective._assetsDir = _externalAssetsSourceDir(themeDir);

  const effectiveErrors = validateTheme(patched);
  const resourceErrors = _validateRequiredAssets(effective);

  return {
    ok: rawErrors.length + effectiveErrors.length + resourceErrors.length === 0,
    errors: [...rawErrors, ...effectiveErrors, ...resourceErrors],
  };
}
```

**约束**：不写 `activeTheme` / 不调 `_resolveExternalAssetsDir` / 不触发任何 fs 写入。

| 条件 | level | 状态 |
|---|---|---|
| `result.ok === false` | warning | fail |
| 通过 | — | pass |

**textHint**：`"Open Settings → Theme and switch to the default 'clawd' theme."`

## 5. Step 2 计划：Hook 事件水位检查

### 5.1 链路与断点

```
[agent 触发 hook / plugin / 写日志]
        ↓                     ← ①: settings 没 hook 注册（4.2 已覆盖）
[Clawd hook 脚本被调起]
        ↓                     ← ②: node/script 路径错（4.2 已覆盖）
[POST 127.0.0.1:port  /  文件读]
        ↓                     ← ③: 防火墙 / EDR 拦截
                              ← ④: 端口写错（4.1 已覆盖）
[src/server.js / log poller 收到]
        ↓                     ← ⑤: DND / agent gate / setState DND 吞了
[更新 _state，桌宠动起来]
```

Step 1 覆盖 ①②④。**③⑤ 是 Step 2 核心。**

### 5.2 事件源分类

| 类型 | agent | 入口 |
|---|---|---|
| **HTTP 入口（进 ringbuffer）**| 9 个全部 | `src/server.js` `/state` `/permission` |
| **文件 mtime（副路径）**| gemini-cli (~/.gemini/tmp)、codex rollout (~/.codex/sessions/) | 仅 detector 用 |

### 5.3 ringbuffer 实现（v8：多点 record，每路径只 record 一次）

```js
// src/server.js
const HOOK_EVENT_RING_SIZE_PER_AGENT = 50;
const recentHookEvents = new Map();

function recordHookEvent(data, route, outcome) {
  const agentId = typeof data.agent_id === "string" ? data.agent_id : "claude-code";
  const eventType = route === "permission"
    ? "PermissionRequest"
    : (typeof data.event === "string" ? data.event : null);

  const list = recentHookEvents.get(agentId) || [];
  list.push({ timestamp: Date.now(), eventType, route, outcome });
  if (list.length > HOOK_EVENT_RING_SIZE_PER_AGENT) list.shift();
  recentHookEvents.set(agentId, list);
}
```

**调用点**（v8 关键：每个出口分支单独 record，不在 parse 后单点）：

| 路由 | 调用位置 | outcome |
|---|---|---|
| `/state` | agent gate fail（return 204）前 | `'dropped-by-disabled'` |
| `/state` | 调 `setState` 前先查 `ctx.doNotDisturb` | DND=true → `'dropped-by-dnd'`；否则 `'accepted'` |
| `/permission` | DND gate fail 前 | `'dropped-by-dnd'` |
| `/permission` | agent gate fail 前 | `'dropped-by-disabled'` |
| `/permission` | accepted 路径末端 | `'accepted'` |

**注意**：因为 `setState` 内的 DND 判定（state.js:266）在 server 看不到，server 必须在调用 setState **前**自己查一次 `ctx.doNotDisturb`，复制判定。这是 v8 的设计取舍——避免改 setState 签名。

`recordHookEvent` 包裹 try/catch，自身错误不影响主流程。

per-agent 各 50 × 9 = 450 条 < 100KB。

### 5.4 Test connection 流程

1. instruction：`"Send a message in any AI coding agent. Come back in 10 seconds."`
2. 倒计时结束后判定：

   | 条件 | 结果 |
   |---|---|
   | HTTP 至少 1 个 outcome=accepted | ✅ HTTP path verified |
   | HTTP 至少 1 个 outcome=dropped-* | ⚠️ HTTP works but events dropped (DND/agent toggle) |
   | HTTP 零 + 文件 mtime 有更新 | ⚠️ HTTP blocked (firewall/EDR/proxy likely) |
   | 全无 | ⚠️ No activity in 10 seconds |

3. "Open Clawd debug log" 按钮（IPC `doctor:open-clawd-log`，白名单 `~/.clawd/*.log`）

### 5.5 工作量

| 部分 | 估时 |
|---|---|
| `server.js` 多点 ringbuffer record（5 个调用点）+ IPC | 0.8 天 |
| Doctor UI Test connection + 倒计时 + 三分支 | 0.5 天 |
| ringbuffer 聚合逻辑 + 文件 mtime fallback | 0.7 天 |
| 新 IPC `doctor:open-clawd-log` + 白名单 | 0.3 天 |
| 误报兜底 | 0.4 天 |

合计 **~2.7 天**。

## 6. 诊断报告（Markdown 复制）

### 6.1 报告格式

```markdown
# Clawd Diagnostic Report

- Generated: 2026-04-28T14:32:00Z
- Clawd version: 0.6.2
- Platform: win32 (10.0.26200)
- Locale: zh-CN

## Health Summary

Overall: WARNING (2 issues)

| Check | Status | Detail |
|---|---|---|
| Local server | OK | Listening on 127.0.0.1:23333 |
| Agent integrations | WARNING | 5 ok, 1 not-connected, 2 not-installed, 1 manual-only |
| Permission bubble | WARNING | Globally disabled |
| Theme | OK | clawd (effective theme validated) |

## Agent Integrations

| Agent | Source | Status | Detail |
|---|---|---|---|
| claude-code | hook | ok | ~/.claude/settings.json hook registered, scriptPath verified |
| codex | hook+log-poll | ok | ~/.codex/hooks.json registered; supplementary: codex_hooks=true |
| cursor-agent | hook | not-connected | ~/.cursor/ exists but ~/.cursor/hooks.json missing |
| copilot-cli | hook | manual-only | Project-level hooks.json; cannot be auto-detected |
| gemini-cli | hook+log-poll | not-installed | ~/.gemini/ home directory missing |
| codebuddy | hook | ok | ~/.codebuddy/settings.json registered, scriptPath verified |
| kiro-cli | hook | ok | 2 fully-valid in ~/.kiro/agents/: clawd.json, custom.json |
| kimi-cli | hook | ok | ~/.kimi/config.toml registered, scriptPath verified |
| opencode | plugin-event | ok | ~/.config/opencode/opencode.json plugin entry, directory + index.mjs verified |
```

v8 报告变化：Kimi detail 也注明 `scriptPath verified`（不再仅 `env prefix detected`）。

### 6.2 隐私脱敏规则

| 原始 | 替换为 |
|---|---|
| `C:\Users\<name>\` / `/Users/<name>/` / `/home/<name>/` | `~/` |
| API key / token / secret 字段 | `[REDACTED]` |
| 用户文档名 | 不收集 |
| IP 地址 | `127.0.0.1` 保留，其他 → `[IP]` |

**强制 redact 兜底正则**：
```
sk-[a-zA-Z0-9]{20,}                  → [REDACTED]
Bearer\s+\S+                          → Bearer [REDACTED]
xoxb-\S+                              → [REDACTED]
ghp_[a-zA-Z0-9]{36}                   → [REDACTED]
github_pat_\S+                        → [REDACTED]
AKIA[0-9A-Z]{16}                      → [REDACTED]
"password"\s*:\s*"[^"]+"              → "password": "[REDACTED]"
"api[_-]?key"\s*:\s*"[^"]+"           → "api_key": "[REDACTED]"
```

### 6.3 隐私声明

> **Privacy notice**: This report is generated locally. Clawd does **not** upload any data. User paths are replaced with `~`. The report contains no API keys, tokens, conversation content, or document filenames.

中文：

> **隐私说明**：诊断报告只在你的电脑生成，Clawd 不会上传任何信息。报告中的用户路径已替换为 `~`，不包含 API key、token、对话内容或文件名。

## 7. 实现拆解（Step 1）

### 7.0 前置工作

- 9 个 installer 显式导出 `DEFAULT_PARENT_DIR` / `DEFAULT_CONFIG_PATH`（Codex 加 `DEFAULT_FEATURES_CONFIG`，Kiro 改 `DEFAULT_AGENTS_DIR`）
- `hooks/json-utils.js` 新增 export `findHookCommands(settings, marker, opts)` 返回完整命令字符串数组
- **`hooks/kimi-install.js` 新增 export `findKimiHookCommands(text, marker)`**（v9：支持单 / 双引号 command；替代 v7 的 `containsClawdHookCommand`）
- `src/prefs.js` 默认 `agents` 补齐 `kimi-cli`

### 7.1 文件清单

| 文件 | 改动 |
|---|---|
| `src/doctor.js` | 新建 |
| `src/doctor-detectors/local-server.js` | 新建。4.1 |
| `src/doctor-detectors/agent-descriptors.js` | 新建。9 agent，import installer 常量 |
| `src/doctor-detectors/agent-integrations.js` | 新建。4.2 |
| `src/doctor-detectors/agent-node-bin-parser.js` | 新建。4.2.3：cmd `/d /s /c` regex / PowerShell env / POSIX env / scriptPath |
| `src/doctor-detectors/codex-features-check.js` | 新建。tri-state |
| `src/doctor-detectors/opencode-entry-validator.js` | 新建。4.2.8 |
| `src/doctor-detectors/permission-bubble-policy.js` | 新建。4.3 |
| `src/doctor-detectors/theme-health.js` | 新建。4.4 |
| `src/doctor-report.js` | 新建。`redact()` + Markdown formatter |
| `src/theme-loader.js` | 新增 `validateThemeShape` / `_resolveAssetPath` / `_externalAssetsSourceDir`；`getAssetPath()` reuse |
| `src/server.js` | `getRuntimeStatus()` 导出（Step 1 只读）；ringbuffer 5 个调用点留到 Step 2 |
| `src/main.js` | IPC `doctor:run-checks` / `doctor:get-report` |
| `src/preload-settings.js` | 暴露 `window.doctor.*` |
| `src/settings-renderer.js` | sidebar 顶部 DoctorIndicator |
| `src/settings-doctor-modal.js` | 新建。modal UI |
| `src/settings.html` | sidebar / modal styles；`id="doctorModal"` |
| `src/settings-i18n.js` | Doctor 文案三语 |
| **9 个 hooks/*-install.js** | 7.0 前置：导出常量 |
| **`hooks/json-utils.js`** | 新增 export `findHookCommands` |
| **`hooks/kimi-install.js`** | 新增 export `findKimiHookCommands`（v9：支持单 / 双引号 command）|
| `test/doctor.test.js` | 新建 |
| `test/doctor-node-bin-parser.test.js` | 新建。**golden roundtrip** ≥ 8 形态 |
| `test/doctor-find-hook-commands.test.js` | 新建。flat / nested / 多匹配 |
| `test/doctor-find-kimi-hook-commands.test.js` | 新建。v8：单引号 toml block / 多 hook block / 仅含 marker 的 command 命中 |
| `test/doctor-agent-descriptors.test.js` | 新建 |
| `test/doctor-codex-features.test.js` | 新建。tri-state |
| `test/doctor-kiro-scan.test.js` | 新建 |
| `test/doctor-opencode-entry.test.js` | 新建。4 reasons |
| `test/doctor-report.test.js` | 新建。redact 兜底 |
| `test/theme-loader-validate-shape.test.js` | 新建。不污染 activeTheme + 不触发 cache write |
| `test/server-ringbuffer.test.js` | Step 2：5 个调用点 / 3 outcome / route normalization（不属于 Step 1） |

**v8 仍不引入新依赖。**

### 7.2 IPC 契约

```ts
type AgentIntegrationDetail = {
  agentId: string;
  agentName: string;
  eventSource: string;
  status: 'ok' | 'not-connected' | 'broken-path' | 'not-installed'
        | 'config-corrupt' | 'disabled' | 'manual-managed' | 'manual-only';
  parentDirExists?: boolean;
  configFileExists?: boolean;
  configPath?: string;
  detail?: string;
  hookCommandIssue?: 'nodeBin-invalid' | 'scriptPath-missing' | 'parse-failed' | null;
  opencodeEntryIssue?: 'not-absolute' | 'directory-missing' | 'not-a-directory' | 'index-mjs-missing' | null;
  supplementary?: { key: 'codex_hooks'; value: 'enabled' | 'disabled' | 'uncertain'; detail?: string };
  kiroScan?: { fullyValidFiles: string[]; brokenFiles: string[]; noMarkerFiles: string[] };
};
```

### 7.3 测试计划

- **redact()**：3 平台 home + 全部兜底正则
- **每个 detector** ok / fail / skip 分支
- **agent-descriptors**：9 个 descriptor `===` installer 导出常量
- **node-bin-parser golden roundtrip**（v7 关键，v8 验证 cmd regex）：用真实 helper 生成下列形态再反向解：
  1. POSIX 绝对路径
  2. Windows powershell wrapper（裸 node）
  3. Windows powershell wrapper（绝对路径）
  4. **Windows cmd wrapper（v8 验证 `/d /s /c` regex 命中）**
  5. POSIX env prefix
  6. PowerShell env prefix（单 `$env:`）
  7. PowerShell 多重 env prefix（`$env:A; $env:B`）
  8. scriptPath 不存在 → broken-path
- **`findHookCommands`**：flat / nested / 多匹配 / command 字段缺失
- **`findKimiHookCommands`**（v9 新）：
  - 单 hook block + 含 marker → 1 命中
  - 多 hook block + 全含 marker → 多命中
  - hook block command 不含 marker → 0 命中
  - command 用双引号（容错，含 `\"` 转义）/ 多行注释干扰
  - 假阳：`marker` 出现在 event = 字段值内 → 不应命中
- **agent-integrations**：
  - parentDir 不存在 → not-installed/info
  - parentDir 存在 + config 缺失（autoInstall=true）→ not-connected/warning
  - parentDir 存在 + config 缺失（autoInstall=false=Copilot）→ manual-only/info
  - **Kimi config.toml 含 marker 但 scriptPath 不存在 → broken-path**（v8 关键回归）
  - hook 注册但 nodeBin 不存在 → broken-path
  - settings.local.json 全局路径**不被扫**
- **doctor-codex-features**：≥ 5 toml 形态
- **doctor-kiro-scan**：0 / 1 / 多 fully-valid + 全 all-broken + 混合
- **doctor-opencode-entry**：4 reasons
- **theme-loader-validate-shape**：
  - 调用前后 module-internal `activeTheme` 不变
  - 调用前后 theme cache 目录无新增/修改
  - variant / override 改 states 抓到
  - clawd 内置 fallback 不误报
- **server-ringbuffer**（Step 2）：
  - `/state` agent gate fail → outcome='dropped-by-disabled'
  - `/state` setState 前 DND=true → outcome='dropped-by-dnd'
  - `/state` setState 前 DND=false → outcome='accepted'
  - `/permission` DND gate → outcome='dropped-by-dnd'
  - `/permission` agent gate → outcome='dropped-by-disabled'
  - `/permission` accepted 末端 → outcome='accepted'
  - 同一 HTTP 请求 record 一次（不重复）
  - eventType normalization：`/state` 取 data.event；`/permission` 固定 'PermissionRequest'

E2E 手测：

- Windows + cmd wrapper：手改 hook 命令成 `cmd /d /s /c "..."` → Doctor 正常解析
- Windows PowerShell 多重 env：`$env:A='1'; $env:B='2'; & "node" "..."` → 正常
- 删 Clawd 安装目录 → opencode 报 broken-path（directory-missing），所有 hook agent 报 broken-path（scriptPath-missing），含 Kimi
- `~/.config/opencode/opencode.json` plugin 改成相对路径 → opencode 报 not-absolute
- DND 开启 + 触发 hook → ringbuffer 显示 outcome='dropped-by-dnd'

### 7.4 工作量估算（Step 1）

| 任务 | 估时 |
|---|---|
| 7.0 前置：installer 常量 + `findHookCommands` + **`findKimiHookCommands`** | 0.5 天 |
| `doctor.js` 框架 + IPC | 0.3 天 |
| 4.1 local-server | 0.2 天 |
| 4.2.1 descriptors | 0.2 天 |
| 4.2.2 主流程（含 Kimi toml-text 分支）| 0.7 天 |
| 4.2.3 node-bin-parser（cmd regex 修正 + golden roundtrip）| 0.9 天 |
| 4.2.5 Kiro dir scan | 0.5 天 |
| 4.2.6 Codex tri-state | 0.4 天 |
| 4.2.8 opencode validator | 0.3 天 |
| 4.3 permission-bubble | 0.1 天 |
| 4.4 theme validate + helpers | 0.7 天 |
| `doctor-report.js` + redact | 0.5 天 |
| Doctor modal UI + i18n | 0.6 天 |
| sidebar DoctorIndicator | 0.3 天 |
| 联调 + bug + E2E 手测 | 0.8 天 |
| **合计** | **~7.2 天** |

## 8. 风险

### 8.1 sidebar 视觉

加"健康行"会让 General 视觉下沉。**缓解**：先做静态视觉稿确认。

### 8.2 7.0 前置 installer 改动连锁

9 个 installer 加常量；`json-utils.js` 加 `findHookCommands`；`kimi-install.js` 加 `findKimiHookCommands`。

**缓解**：refactor behavior-preserving；原 installer 单测全绿；新 helper 单测覆盖边界。

### 8.3 命令解析 golden roundtrip

cmd wrapper / PowerShell env / Kimi env 都是真实 installer 输出。

**缓解**：parser 单测**强制**通过 `formatNodeHookCommand` / `withCommandEnv` / kimi-install 真实 helper 生成 command 再反向解；不允许字面量。

### 8.4 误报伤害用户信任

**缓解**：每项 fail 必须在 detail 展示当前实际值。

### 8.5 i18n 工作量

动态拼接用占位符；翻译只翻骨架。

### 8.6 报告复制隐私泄漏

**缓解**：隐私声明在复制按钮**正上方**；redact 单测覆盖；不收集 prompt/文件名/对话历史。

### 8.7 effective theme validate 误报

`fs.accessSync` fs 短暂不可用时可能误判。**缓解**：errors 透传具体路径。

### 8.8 Codex tri-state 字符串扫描

**缓解**：单测 ≥ 5 toml；解析失败 → uncertain 不 crash。

### 8.9 Kiro / Kimi dir/text scan 性能

agentsDir 通常 < 10；config.toml 通常 < 1KB。**缓解**：50 文件上限；toml 文件大小上限 256KB。

### 8.10 ringbuffer record 在 server 内部异常时丢失

**缓解**：`recordHookEvent` try/catch；自身错误不影响主流程。

### 8.11 Doctor 复制 setState DND 判定逻辑

server 在调 setState 前查 `ctx.doNotDisturb` 是 v8 设计取舍。如果 state.js 改了 DND 判定逻辑（如增加额外条件），server 这边不会同步——会让 outcome 标错。

**缓解**：把 DND 判定抽成 ctx 上的 `shouldDropForDnd()` 方法，server 和 state 都调它；v8 实施时把这个 helper 创建出来。

### 8.12 opencode plugin path stale

dev↔package 切换会让 plugin path 失效——是真故障。**缓解**：textHint 引导 reinstall。

### 8.13 permission ringbuffer 与 /state ringbuffer 共用

permission eventType 固定 "PermissionRequest"。如果 permission payload 增加 event 字段需相应调整。**缓解**：单测 assert 回归。

### 8.14 Step 2 ringbuffer 内存

per-agent 各 50 × 9 = 450 条 < 100KB。可控。

### 8.15 `doctor:test-connection` 并发调用

Step 2 当前由 Settings modal 的 `connectionTesting` 标志防重入；主进程 IPC 没有 `pendingConnectionTest` 去重。现有 UI 路径不会并发触发，但未来新增自动诊断、复制报告时刷新等入口时，可能同时启动多个 10s 连接测试窗口，并让最后结束的测试覆盖 `lastDoctorConnectionTest`。

**缓解**：后续在 `src/main.js` 增加 `pendingConnectionTest` Promise guard。已有测试在运行时直接返回同一个 Promise，完成后 `finally` 清空。

### 8.16 ringbuffer record 调用点维护负担

Step 2 设计中用 5 个逻辑出口描述 record，但真实 `/permission` 分支包含 opencode / Codex / Claude，以及 bubble disabled、headless、passthrough、elicitation 等 accepted 变体，落地后调用点更多。未来新增 server 分支时如果忘记 record，该路径会在 ringbuffer 中"消失"，导致 Test connection 误判为无 HTTP 活动或只能依赖 mtime fallback。

**缓解**：短期靠 `test/server-ringbuffer.test.js` 覆盖关键路径；后续可抽 `recordAndReturn` / `recordAccepted` 等小 helper 降低重复。完整 decorator 化需要重构 `src/server.js` 大段分支逻辑，建议放到 0.6.2 后续维护，不作为当前发版阻塞项。

## 9. Step 1 完成定义

- 9 个 installer 全部导出 `DEFAULT_PARENT_DIR` / `DEFAULT_CONFIG_PATH`（Codex `DEFAULT_FEATURES_CONFIG`，Kiro `DEFAULT_AGENTS_DIR`）
- `hooks/json-utils.js` 新增 export `findHookCommands`
- `hooks/kimi-install.js` 新增 export `findKimiHookCommands`（v9：支持单 / 双引号 command）
- `src/prefs.js` 默认 agents 含 9 个 agent（包含 `kimi-cli`）
- 4 项检查全部实现并有单测
- agent-integrations 覆盖 9 agent
- agent-integrations 含 parentDir / configFile 拆分 + scriptPath 缺失 + nodeBin 不存在 + opencode 4 reasons + **Kimi scriptPath 缺失**（v8）分支单测
- Codex tri-state 单测覆盖 ≥ 5 toml 形态
- Kiro dir scan 单测覆盖 0 / 1 / 多 fully-valid + 全 all-broken + 混合
- agent descriptor 路径与 installer 导出常量字面相等单测通过
- node-bin-parser **golden roundtrip** ≥ 8 形态（含 cmd `/d /s /c` regex 验证）
- `findHookCommands` 与 `findKimiHookCommands` 单测覆盖 flat / nested / 多匹配 / 假阳
- `validateThemeShape` 单测：(a) 不污染 activeTheme；(b) 不触发 cache write；(c) variant / override 抓到；(d) clawd 内置 fallback 不误报
- Doctor modal 在 Settings sidebar 可访问
- 报告复制按钮工作，redact 通过单测
- 隐私声明在 modal 顶部和复制按钮旁各贴一次
- zh / en 完整，ko 至少覆盖 4 项 label + 8 种 status 标签
- `node --test test/*.test.js` 全绿
- Windows 手测一次完整流程；macOS 路径用 code-review-first，并在可用 macOS 环境补手测

## 10. Step 2 / Step 3 占位

- **Step 2**：第 5 节 hook 事件水位（5 个 ringbuffer 调用点 + `route` + `outcome` + permission 归一化）+ Test connection（三分支）+ IPC `doctor:open-clawd-log`，~2.7 天
- **Step 3**：每项 fail 附"一键修"按钮，复用 `commandRegistry`；缺失的 per-agent reinstall 命令需先在 `commandRegistry` 补齐——前置工作。~2.5 天

## 11. 不做清单

- 不做更新通道、远程 SSH、平台 bug 自动修
- 不做诊断结果上报、遥测
- 不做后台周期扫描
- 不做账号系统、云同步
- **Step 1 不引入任何 fix 按钮**
- **不做项目级 `.claude/settings.local.json` 检测**
- **Doctor 不动主题**
- Doctor 不修改 prefs / 不重启 server
- **不引入 TOML 解析依赖**
