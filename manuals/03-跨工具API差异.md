# 03 · Quantumult X / Surge / Loon / Shadowrocket 脚本 API 对照

> **证据来源**
> - **QX**：`crossutility/Quantumult-X` 官方仓库全量文件（sample.conf + 全部 sample-*.js + rewrite.md 等）
> - **Surge**：官方文档 `manual.nssurge.com/scripting/*`（已抓取 overview / api / http-request / http-response / cron 页）
> - **Loon**：官方文档 `loon0x00.github.io/docs/Script/script_api` 与 `/docs/Script/script_v2`
> - **Shadowrocket**：`[无官方脚本 API 文档]` —— 见文末第 6 节说明
>
> 本文只做**客观差异陈述**。所有"QX 没有"的结论均来自官方仓库全文检索（`grep` 结果为 0 处），可自行复核。

---

## 1. 一张表看懂：同名概念在四个工具里叫什么

| 能力 | Quantumult X | Surge | Loon | Shadowrocket |
|---|---|---|---|---|
| 发 HTTP 请求 | `$task.fetch(req)` | `$httpClient.get/post/...` | `$httpClient.get/post/...` | `[无脚本 API]` |
| 持久化读 | `$prefs.valueForKey(k)` | `$persistentStore.read([k])` | `$persistentStore.read([k])` | — |
| 持久化写 | `$prefs.setValueForKey(v, k)` ⚠️ **value 在前** | `$persistentStore.write(v, [k])` | `$persistentStore.write(v, [k])` | — |
| 持久化删单项 | `$prefs.removeValueForKey(k)` | `$persistentStore.write(null, k)` | `$persistentStore.write(undefined, k)` | — |
| 持久化清全部 | `$prefs.removeAllValues()` | `[无对应]` | `$persistentStore.remove()` | — |
| 通知 | `$notify(t, s, m)` —— **3 参** | `$notification.post(t, s, b[, opts])` —— 4 参 | `$notification.post(t, s, c[, attach][, delay])` —— 5 参 | — |
| 脚本参数 | `$environment.variables` / `$environment.sourcePath` | `$argument` | `$argument` | — |
| 脚本自身信息 | **无** | `$script.name/.type/.startTime/.sessionID` | `$script.name/.startTime` | — |
| 运行时信息 | `$environment.params`（仅 UIAction） | `$environment.system/.language/["surge-build"]/["device-model"]` + `$network` | `$loon`（**是字符串不是对象**） | — |
| 结束脚本 | `$done(x)` | `$done(x)` | `$done(x)` | — |
| 二进制响应 | `$response.bodyBytes`（ArrayBuffer） | `binary-body-mode` 参数 + `Uint8Array` | `Uint8Array` | — |
| 配置读写 | `$configuration.sendMessage({action, content})` | `$httpAPI(method, path, body, cb)` | `$config.getConfig()` / `$config.setSelectPolicy()` 等 | — |
| 文件存储 | `$iCloud.writeFile/readFile/removeFile` | `[无对应]` | `[无对应]` | — |
| 定时 | `[task_local]` + 5/6 段 cron | `[Script]` `type=cron,cronexp="..."` | `cron "..." then script(...)` | — |
| 压缩 / AES | **无** | `[无]` | `$utils.gzip` / `$crypto.aes`（Build ≥ 988） | — |
| DNS 查询 | 只能 `$configuration` 的 DNS action | `$dns` 脚本类型 | `$dns.query`（Build ≥ 988） | — |

⚠️ **最危险的一处**：`setValueForKey(value, key)` 的参数顺序与 Surge/Loon 的 `write(data, key)` 恰好一致（都是值在前），但**读接口 `valueForKey(key)` 只有 key**。很多人记成 `(key, value)` 写反，**不报错、静默存错位置**。

---

## 2. QX 与 Surge 的逐项差异

### 2.1 脚本声明方式

**Surge**（`[官方]` manual.nssurge.com/scripting/overview）：

```ini
[Script]
script1 = type=http-response,pattern=^http://www.example.com/test,script-path=test.js,requires-body=true
script2 = type=cron,cronexp="* * * * *",script-path=fired.js
script3 = type=dns,script-path=dns.js
```

七种 type：`http-request` / `http-response` / `rule` / `dns` / `event` / `cron` / `generic`。

**QX**（`[官方]` sample.conf）：没有 `[Script]` 区块，按功能拆到两个地方：

```ini
[rewrite_local]
^https?://example\.com/api url script-response-body response-body.js

[task_local]
0 8 * * * task.js, tag=名称, enabled=true
```

**关键差异**：
- Surge 是**一个 `[Script]` 区块 + type 参数**；QX 是**区块名即类型**（`script-response-body` 写在行内）。
- Surge 有 `rule` / `dns` / `generic` 三种脚本类型，**QX 完全没有**。
- Surge 用 `requires-body=true` 控制是否等 body；QX 用**不同的 rewrite 类型**区分（`script-response-header` 不等 body，`script-response-body` 等 body）。
- Surge 的 `max-size` 参数控制 body 缓冲上限；QX **没有这个参数** `[待核实]`。
- Surge 的 `timeout` 参数（默认 5 秒）；QX **rewrite 脚本没有 timeout 参数**，`[task_local]` 也没有，只能自己 `setTimeout` 兜底。

### 2.2 `$done` 语义差异（这一条会咬人）

**Surge** `[官方]` scripting/api：
> `$done() and $done({}) are equivalent for http-request and http-response scripts: the request/response continues untouched.`
> `$done({abort: true}) terminates the connection`
> `Every script must call $done() exactly once... Extra calls are ignored.`

**QX** `[官方]`：只说过 `// $done({}); // Not changed.`（sample-rewrite-request-header.js）

| 行为 | Surge | QX |
|---|---|---|
| `$done()` 与 `$done({})` 等价 | 官方明确说等价 | 官方**只说 `$done({})` 是"不改动"**，`$done()` 无参在 rewrite 里的行为**未文档化** `[待核实]` |
| `$done({abort:true})` 断连 | **支持** | **官方无此字段**，`[待核实]` 是否被忽略 |
| 重复调用 `$done` | 官方明确"额外调用被忽略" | **未文档化** `[待核实]` |
| 未捕获异常 | 官方明确"session 中止，脚本无效果" | **未文档化** `[待核实]` |

→ **实操结论**：QX rewrite 脚本里**永远写 `$done({})`**，不写裸 `$done()`；用 flag 防重复调用。

### 2.3 `$httpClient` vs `$task.fetch` 的能力落差

**Surge** `[官方]`：
- 8 个方法：`get/post/put/delete/head/options/patch`
- `binary-mode: true` → 响应体为 `Uint8Array`
- `full-header-mode: true` → 响应头为 `[{field, value}]` 数组，**保留重复头**（解决 Set-Cookie 问题）
- `timeout`（默认 5 秒）
- `insecure` / `auto-redirect` / `auto-cookie`
- `policy` / `policy-descriptor`（支持**临时策略描述串**）
- **单次脚本最多 20 个并发请求**，iOS 上 body 上限 32 MB

**QX** `[官方]`：
- **只有一个方法 `$task.fetch`**，靠 `method` 字段区分
- 二进制走 `response.bodyBytes`（不经 opts 开关）
- **没有 full-header-mode** → 多值响应头必然合并，这是 QX issue #135 的根因，只能用空格 hack 绕
- 超时**固定 10 秒**，不可配置
- `opts` 只有 5 个：`redirection` / `skip-cert-verify` / `auto-cookie` / `policy` / `filter`(废弃)
- **没有并发数说明** `[待核实]`

**核心落差**：QX 的 `policy` 会**失去连接复用**（官方明说），Surge 的 `policy` 没有这条警告。批量请求场景 QX 别用 `policy`。

### 2.4 `auto-cookie` 的默认值陷阱

| | 默认值 | 老版本行为 |
|---|---|---|
| Surge | `auto-cookie` 默认 **开启** | — |
| QX | `opts['auto-cookie']` 默认 **`false`** | **build 934 之前忽略该字段，等效 true** |

→ **同一个脚本在不同 QX 版本上 cookie 行为相反。** 依赖 cookie 的脚本（签到类基本都是）必须显式写 `'auto-cookie': true`，不能靠默认值。

### 2.5 参数注入：`$argument` vs `$environment.variables`

**Surge** `[官方]`：`argument` 参数 → `$argument` 字符串。只有一个字符串，多参数要自己解析。
**Loon** `[官方]`：`$argument` 未配置时可能 `undefined` 或 `null`；普通参数是 String；**插件参数列表是 Object**。
**QX** `[官方]`：`$environment.variables` 是**对象**（v1.5.6 build 918+），从 URL `#` 自动解析成键值对。

QX 这种方式**在 QX 里更好用**（省掉手写解析），代价是：
- `#` 后内容受配置行 `,` 分隔符限制，**不能带逗号**
- 值**全是字符串**
- 老版本没有此 API，需要降级

---

## 3. QX 与 Loon 的逐项差异

### 3.1 声明语法

**Loon 3.5.1(983)** 起的新语法 `[官方]`：

```
request if ${url} ~= /\/api\// && ${request.method} == "POST" then script("request.js") with requires_body=true
response if ${url} ~= /\/api\// && ${response.status} == 200 then script("response.js") with requires_body=true
cron "0 8 * * *" then script("cron.js") with tag="Daily Task", timeout=300
network-changed then script("network.js")
generic then script("switch-node.js", "region=C")
```

**这比 QX 强的地方**：
- **多条件匹配**：`${url} && ${request.method} && ${response.header['Content-Type']}`，QX 只能正则匹 URL，要判 header 必须在脚本里写（对应 QX issue #124 的痛点）
- **`timeout` 参数**（示例 `timeout=20`、`timeout=300`），QX 没有
- **`argument` 内联**（`script("request.js", "source=profile")`）
- **Cron 支持 5 段和 6 段**，官方明确写了 6 段的含义：`秒 分 时 日 月 周` ← **QX 只说"支持 6 段"但没说 6 段是什么**，这是 QX 文档的空洞

### 3.2 Loon 有、QX 完全没有的 API

`[官方]` loon0x00.github.io/docs/Script/script_api：

| API | 作用 |
|---|---|
| `$utils.gzip(data, callback)` | gzip 压缩（Build ≥ 988） |
| `$crypto.aes.encrypt/decrypt` | AES 加解密（Build ≥ 988） |
| `$dns.query(domain, callback)` | DNS 查询（Build ≥ 988） |
| `$config.getConfig()` | 同步拿当前配置摘要 JSON |
| `$config.setSelectPolicy(name, sel)` | 切换策略组选择（支持批量数组） |
| `$config.getSubPolicies(name, cb)` | 异步读策略组可选项 |
| `$config.getSelectedPolicy(name)` | 同步读当前选择 |
| `$config.setRunningModel(0/1/2)` | 切换运行模式（0 全局直连 / 1 分流 / 2 全局代理） |
| `setInterval` | Loon 官方明确：**`setInterval` 与 `setTimeout` 行为相同，只执行一次** |

QX 的对等物只有 `$configuration.sendMessage` 的 action 机制，且：
- QX 有 `set_running_mode`，值是字符串 `"all_proxy"/"all_direct"/"filter"`；Loon 是数字 `0/1/2` —— **两套完全不同的编码**
- QX 的 `set_policy_state` **只在 static 策略组和内置 proxy 上有效**；Loon 的 `setSelectPolicy` 没这条限制
- QX **没有** gzip / AES / DNS 查询 API

### 3.3 二进制处理的哲学差异

| | 方式 |
|---|---|
| Loon `[官方]` | 统一 `Uint8Array`；"字符串、Base64、十六进制不会自动转换" |
| QX `[官方]` | `$response.bodyBytes` 是 **ArrayBuffer**；`$iCloud.readFile` 返回 **Uint8Array** —— **QX 内部两种类型混用** |

→ **QX 里必须手动切片**：`uint8.buffer.slice(uint8.byteOffset, uint8.byteLength + uint8.byteOffset)`。官方在两个示例里都强调过。Loon 不需要这么绕。

### 3.4 通知参数个数

| | 签名 |
|---|---|
| QX | `$notify(title, subtitle, message)` —— **3 个，没有第 4 个** |
| Loon | `$notification.post(title, subtitle, content[, attach][, delay])` —— attach 支持 `{openUrl, mediaUrl, clipboard}`，还有 `delay` |
| Surge | `$notification.post(title, subtitle, body[, options])` —— options 支持 `action/open-url/clipboard/url/text/media-url/media-base64/media-base64-mime/auto-dismiss/sound` |

→ **QX 在通知能力上最弱**。想"点通知跳转"、"带图通知"，QX 做不到 `[待核实]`（官方 3 参签名里没有）。

---

## 4. 从 Surge 移植脚本到 QX：机械替换表

按这个顺序改，能覆盖 90% 的移植工作：

| 步骤 | 查找 | 替换为 |
|---|---|---|
| 1 | `$persistentStore.read(k)` | `$prefs.valueForKey(k)` |
| 2 | `$persistentStore.write(v, k)` | `$prefs.setValueForKey(v, k)` （**顺序相同，都是值在前**） |
| 3 | `$persistentStore.write(null, k)` | `$prefs.removeValueForKey(k)` |
| 4 | `$httpClient.get({url:u, headers:h}, cb)` | `$task.fetch({url:u, headers:h}).then(r=>..., e=>...)` |
| 5 | `$httpClient.post({url:u, body:b}, cb)` | `$task.fetch({url:u, method:"POST", body:b}).then(...)` |
| 6 | `callback(error, response, data)` | `then(response => { response.statusCode / response.headers / response.body })` |
| 7 | `$notification.post(t,s,b)` | `$notify(t,s,b)` |
| 8 | `$argument` | `$environment.variables`（并改配置行加 `#k=v&k2=v2`） |
| 9 | `$script.name` | **删掉**。QX 无对应 |
| 10 | `binary-mode: true` | 用 `response.bodyBytes` |
| 11 | `full-header-mode: true` | **删掉**。QX 无对应，多值头会合并 |
| 12 | `insecure: true` | `opts: {'skip-cert-verify': true}` |
| 13 | `auto-redirect: false` | `opts: {'redirection': false}` |
| 14 | `timeout: 30` | **删掉**。QX 固定 10 秒 |
| 15 | `$done({abort:true})` | **改写逻辑**，QX 无 abort |

### 4.1 配置行的对应改写

```ini
# Surge
[Script]
api = type=http-response,pattern=^https://api\.example\.com/v1/profile,script-path=profile.js,requires-body=true

# QX 等价
[rewrite_local]
^https://api\.example\.com/v1/profile url script-response-body profile.js

# 别忘了 MitM（Surge 也要，但配置位置不同）
[mitm]
hostname = api.example.com
```

```ini
# Surge
[Script]
daily = type=cron,cronexp="0 8 * * *",script-path=checkin.js

# QX 等价
[task_local]
0 8 * * * checkin.js, tag=每日签到, enabled=true
```

---

## 5. QX 相对 Surge/Loon 独有的东西

不是只有短板，QX 有三样别人没有的：

1. **`$iCloud.writeFile/readFile/removeFile`**（v1.0.31-build717）
   Surge 和 Loon 官方文档里都**没有**文件存储 API。QX 可以读写 `iCloud Drive/Quantumult X/Data/` 下的文件，意味着签到脚本能把历史记录写成文件、多设备同步。

2. **`[http_backend]`** —— 用 JS 在 **127.0.0.1:9999** 起 HTTP 服务
   Surge 有 `$httpAPI` 但那是"调 Surge 自己的 API"，不是"自己当服务器"。QX 这个能做文件转换器、订阅合并器、偏好管理器。官方还给了 `backend-icloud-to-http.js` 示例（把 iCloud 文件通过 LAN 共享给 Apple TV）。

3. **`$parser` 参数化 UI 协议**（草案）
   让资源解析器脚本能给用户渲染原生表单控件（switch/select/text/tags）。Surge/Loon 的模块参数是纯文本 key=value，没有原生 UI。**但这是草案，标题写明「草案 v1」，可能变。**

---

## 6. Shadowrocket

**没有可对照的官方脚本 API 文档。**

我核查过的事实：
- Shadowrocket 官方**不提供公开的脚本引擎文档**，其配置格式（`.conf`）支持 `[Rule]` / `[URL Rewrite]` / `[MITM]` / `[Host]` / `[General]`，但**没有 `[task_local]` 类的 JS 定时任务机制**，也没有 `$task.fetch` / `$prefs` / `$notify` 这一套 API。

**因此**：
- **Surge/Loon/QX 的签到脚本，无法直接用于 Shadowrocket。**
- Shadowrocket 的重写是**规则式**（正则替换、`reject`、`302`），没有脚本钩子。

`[待核实]`：Shadowrocket 后续版本是否加入了 JS 引擎。我无法从其官方渠道取得权威文档，**任何声称"Shadowrocket 支持 JS 脚本"的教程，要求对方给出官方链接再信**。

---

## 7. 四个工具的能力矩阵（脚本角度）

| 维度 | QX | Surge | Loon | Shadowrocket |
|---|---|---|---|---|
| 官方 API 文档完整度 | ⚠️ **无完整文档**，只有样例注释 | ✅ 完整（含每个 type 的输入输出契约） | ✅ 完整（含版本矩阵、兼容别名） | ❌ 无公开文档 |
| HTTP 请求方法数 | 1（`$task.fetch`） | 8 | 4（`get/post/head/...`） | — |
| 请求超时可配 | ❌ 固定 10s | ✅ | ✅ | — |
| 多值响应头保留 | ❌ 会合并（issue #135） | ✅ `full-header-mode` | `[待核实]` | — |
| 多条件匹配 | ❌ 仅 URL 正则 | ✅ pattern 正则 + 脚本内判 | ✅ `${url} && ${method} && ${header}` | — |
| 脚本超时控制 | 只能 `setTimeout` 兜底 | ✅ `timeout` 参数 | ✅ `timeout` 参数 | — |
| 二进制支持 | ⚠️ ArrayBuffer/Uint8Array 混用 | ✅ `binary-mode` | ✅ 统一 Uint8Array | — |
| 压缩/加密 | ❌ | ❌ | ✅ `$utils.gzip` / `$crypto.aes` | — |
| 文件存储 | ✅ `$iCloud` | ❌ | ❌ | — |
| 本地 HTTP 服务 | ✅ `[http_backend]` | ❌ | ❌ | — |
| 参数化 UI | ⚠️ `$parser`（草案） | ❌ | ❌ | — |
| 模块化（import/require） | ❌ | ❌ | ❌ | — |

**三家都没有模块系统。** 想复用代码，只能把公共函数复制进每个脚本，或者把公共逻辑做成远程脚本、用 `$task.fetch` 动态拉——但后者每次都要网络请求，不适合放在 rewrite 热路径里。

**实操建议**：写一个 `qx-common.js` 放在你自己能访问的地址，需要复用的脚本里用 `$task.fetch` 拉它并 `eval` —— 但 `eval` 在 QX 引擎里能否用 `[待核实]`，**不要依赖**。**最稳的做法：复制粘贴公共函数块，用统一前缀防冲突。**

---

## 8. 迁移检查清单（拿 Surge/Loon 脚本过来时逐条过）

- [ ] `$persistentStore` → `$prefs`（`read`→`valueForKey`，`write`→`setValueForKey`，注意都是**值在前**）
- [ ] `$httpClient.get/post` → `$task.fetch({...})`，回调改 Promise
- [ ] `$notification.post` → `$notify`，**砍掉第 4/5 个参数**
- [ ] `$argument` → `$environment.variables`，配置行加 `#k=v`
- [ ] `$script.*` 全部删除
- [ ] `$config.*` → `$configuration.sendMessage({action, content})`，**运行模式编码从 0/1/2 改成字符串**
- [ ] `timeout` 参数删除（QX 固定 10s），改用 `setTimeout` 兜底
- [ ] `binary-mode` → `response.bodyBytes`
- [ ] `Uint8Array` → 需要时 `.buffer.slice(byteOffset, byteLength + byteOffset)`
- [ ] `$done()` → `$done({})`（rewrite 场景）
- [ ] 配置行 `[Script]` → `[rewrite_local]` / `[task_local]`
- [ ] 检查 MitM `hostname` 是否包含目标域名（QX 的 MitM 写在 `[mitm]` 区块）
- [ ] 检查是否用了 `async/await` —— 官方示例全用 Promise，建议改写
- [ ] 检查是否用了 `require` / `import` / `Buffer` / `process` —— 全删
