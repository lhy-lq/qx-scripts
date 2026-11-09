# 02 · Quantumult X JavaScript API 参考

> **本文件的权威性说明（请先读）**
> Quantumult X 官方**从未发布过完整的 JS API 参考文档**。官方仓库 `crossutility/Quantumult-X` 里，API 的定义只存在于三个地方：
> 1. `sample.conf` 的注释行（第 291–297、329、342、351 行附近）
> 2. 每个 `sample-*.js` 文件的头部注释块
> 3. 各文件 `@supported` 标注的版本号
>
> 因此下表**每一条**都标注了「出处」，出处写明在哪个文件哪一行/哪个注释。**凡是没有出处的内容，本文件一律标 `[待核实]`，不做编造。**
>
> **本文档中出现的所有版本号均逐字取自官方文件，未经实测复核。**

---

## 0. 先排雷：不是 QX API 的五个对象

这是最高频的错误来源。以下五个对象**在 Quantumult X 的官方仓库中一次都没有作为 QX API 出现**：

| 对象 | 真实归属 | 说明 |
|---|---|---|
| `$script` | **Surge**（Loon 也有） | Surge 文档明确列在 "Globals" 里：`$script.name`/`.type`/`.startTime`/`.sessionID`/`.binaryBodyMode` |
| `$persistentStore` | **Surge**（Loon 也有） | Surge/Loon 的持久化 API。**QX 用的是 `$prefs`** |
| `$httpClient` | **Surge**（Loon 也有） | Surge/Loon 的发请求 API。**QX 用的是 `$task.fetch`** |
| `$notification` | **Loon** | Loon 的 `$notification.post(...)`。**QX 用的是 `$notify(...)`** |
| `$argument` | **Surge**（Loon 也有） | Surge 的 `argument=` 参数注入。**QX 用的是 `$environment.variables` / `$environment.sourcePath`** |

**核查方法（你可以自己复核）**：官方仓库全量文件中 `grep -rn '\$script'` 结果为 **0 处**。
**为什么重要**：套用 Surge 模板到 QX，脚本会静默拿到 `undefined`——不报错，只是不工作，极难排查。

**它们的 QX 对应物**：

| 你想做的事 | Surge 写法（❌ QX 不可用） | QX 正确写法 |
|---|---|---|
| 读脚本参数 | `$argument` | `$environment.variables`（v1.5.6 build 918+） |
| 读写持久化 | `$persistentStore.read/write` | `$prefs.valueForKey/setValueForKey` |
| 发 HTTP 请求 | `$httpClient.get/post` | `$task.fetch({url, method, headers, body, opts})` |
| 发通知 | `$notification.post(t,s,c)` | `$notify(title, subtitle, message)` |
| 拿脚本自身信息 | `$script.name` / `$script.type` | **无对应 API** `[待核实]` |

---

## 1. `$request` — 请求对象

**出处**：`sample.conf` 第 291–293 行；`sample-rewrite-request-header.js` 头部注释。

### 1.1 可用字段

`[官方]` sample.conf 第 292 行逐字：

```
Supports: $request.sessionIndex, $request.scheme, $request.method, $request.url,
$request.path, $request.headers, $response.sessionIndex, $response.statusCode,
$response.headers, $response.body
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `$request.sessionIndex` | Number | 会话序号。`[官方]`：**`The $request.sessionIndex is equal to $response.sessionIndex when the response is related to the request.`** 且「与 Activity 面板里的 TCP 记录序号无关」 |
| `$request.scheme` | String | `"http"` 或 `"https"` |
| `$request.method` | String | `"GET"` / `"POST"` … |
| `$request.url` | String | 完整 URL（含 scheme、host、path、query） |
| `$request.path` | String | 路径 + query，不含 host。例如 `/api/v1/user?id=1` |
| `$request.headers` | Object | 键值对，键名大小写按原始报文保留 |
| `$request.body` | String | 请求体（`script-request-body` / `script-analyze-echo-response` 中可用）。**注意：sample.conf 的字段列表里没列 body**，但 `sample-backend.js` 注释明确列出了 `$request.body` `[官方: sample-backend.js:18]`，`[推测]`：rewrite 场景下同样可用 |

### 1.2 `sessionIndex` 的实战用法

官方只说了它"相等"，没说用途。`[推测]`（基于语义推导，非官方）：
当你需要在 request 阶段存点东西、response 阶段取回来，且要防并发串号时，用 `sessionIndex` 当 key 后缀。

```js
// script-request-header
$prefs.setValueForKey(JSON.stringify($request.headers), "req_hdr_" + $request.sessionIndex);
$done({});

// script-response-body
const saved = $prefs.valueForKey("req_hdr_" + $response.sessionIndex);
$prefs.removeValueForKey("req_hdr_" + $response.sessionIndex);
```

**风险**：`sessionIndex` 是否会回收复用官方未说明，`[待核实]`。长期运行的脚本建议加时间戳兜底 + 定期清理。

---

## 2. `$response` — 响应对象

**出处**：`sample.conf` 292–293 行；`sample-rewrite-with-script.js`、`sample-bytes-rewrite.js`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `$response.statusCode` | Number | HTTP 状态码。`sample-location-with-script.js` 里有 `if ($response.statusCode != 200)` 的实际用法 |
| `$response.headers` | Object | 响应头 |
| `$response.body` | String | 响应体文本（仅文本） |
| `$response.bodyBytes` | ArrayBuffer | 响应体原始字节。`[官方]` `sample-bytes-rewrite.js:12` 逐字：**`$response.bodyBytes is instance of ArrayBuffer.`** 支持版本：`"Quantumult X (v1.0.19-build480) and iOS 14.0 +"` 或 `"Quantumult X (v1.0.21-build535) and iOS 13.0 +"` |
| `$response.sessionIndex` | Number | 见上 |

### 2.1 已知坑：多值响应头会被合并

`[社区实测]` GitHub issue **#135**：服务端返回多个 `Set-Cookie` 时，`$response.headers['Set-Cookie']` 被合并成一个逗号分隔的字符串，即使原样 `$done({headers})` 回去也会破坏 Cookie。

该 issue 评论区给出的绕过写法（**非官方文档，未实测**）：

```js
headers['Set-Cookie']  = "name1=new-val1";
headers['Set-Cookie '] = "name2=new-val2";  // 尾部加空格
headers['Set-Cookie  ']= "name3=new-val3";  // 两个空格
```

`[待实测]`：这个技巧依赖 QX 内部对 key 尾空格的裁剪行为，版本升级可能失效。

---

## 3. `$done()` — 结束脚本并交回结果

**这是唯一必需调用的 API**。不调用 = 请求挂起到超时。

### 3.1 各场景下 `$done` 的参数签名

官方**没有一份签名表**，以下逐条从官方示例中提取：

| 脚本类型 | `$done` 参数 | 出处 |
|---|---|---|
| `script-response-body` | `$done(body字符串)` 或 `$done({body, headers, status})` | `sample-rewrite-with-script.js` |
| `script-request-header` | `$done({path, headers})` / `$done({path})` / `$done({})` | `sample-rewrite-request-header.js` |
| `script-response-header` | `$done({status, headers})` / `$done({headers})` / `$done({})` | `sample-rewrite-response-header.js` |
| `script-echo-response` | `$done({status, headers, body})` | `sample-echo-response.js` |
| 二进制改写 | `$done({bodyBytes: ArrayBuffer})` | `sample-bytes-rewrite.js` |
| `task_local` 任务 | `$done()` 无参 | `sample-task.js` |
| `geo_location_checker` | `$done({title, subtitle, ip, description})` | `sample-location-with-script.js` |
| `event-interaction` | `$done({title, message})` 或 `$done({title, htmlMessage})` | `sample-fetch-opts-policy.js:51` |
| `resource_parser` | `$done({content})` / `$done({error})` / `$done({retry:{user_agent}})` | `resource-parser.js` |
| `http_backend` | `$done({status, headers, body})` 或 `{..., bodyBytes}` | `sample-backend.js`、`backend-icloud-to-http.js` |

### 3.2 `$done({})` 与 `$done()` 的区别

`[官方]` `sample-rewrite-request-header.js` 注释逐字：`// $done({}); // Not changed.`
→ **`$done({})` = 明确表示"不改动"，放行原请求/响应。** 这是安全退出方式。
→ `$done()` 无参在 rewrite 脚本里的行为，官方未说明，`[待核实]`。**rewrite 脚本里坚持写 `$done({})`。**

### 3.3 `$done` 与 body 相关的铁律

`[官方]` `sample-rewrite-with-script.js` 逐字：

> `only change the response headers is not allowed for script-response-body. The modifiedHeaders can be copied and modified from $response.headers, please do not change the content length, type and encoding field.`

- **`script-response-body` 里不能只改 header** —— 必须同时给 body。
- **不要动 `Content-Length` / `Content-Type` / `Content-Encoding`** —— QX 会自己重算（见 01 文档 3.3 第 1 条）。

`[官方]` 修改状态码的写法与格式要求：
> `Response status can also be optional changed by using $done({body, headers, status}), the modifiedStatus should be like "HTTP/1.1 200 OK"`

→ status 必须是**完整状态行字符串**，不是数字。

**已知问题**：GitHub issue **#44**（至今 open）报告该写法不工作，评论者称数字 `200` 和字符串 `"HTTP/1.1 200 OK"` 都无效。`[待实测]` —— 你若要改状态码，先小范围验证；验证不通就用 `script-echo-response` 整个响应重造（见 `sample-echo-response.js`，那条路径是官方示例且逻辑最直白）。

---

## 4. `$notify(title, subtitle, message)` — 发系统通知

**出处**：`sample.conf` 第 294 行；所有 rewrite 示例头部。

`[官方]` 逐字：
> `The $notify(title, subtitle, message) will post iOS notifications if Quantumult notification has been enabled.`

| 参数 | 类型 | 说明 |
|---|---|---|
| `title` | String | 标题 |
| `subtitle` | String | 副标题 |
| `message` | String | 正文 |

**注意**：
- **只有 3 个参数**。Surge/Loon 的 `$notification.post(title, subtitle, body, opts)` 是 4 个且有 options 对象，**QX 不支持 attach / openUrl / mediaUrl**。
- 系统侧必须先允许 QX 通知，否则静默丢弃。
- 无返回值。
- 调不通不会让脚本失败，可放心用于错误上报。

**典型用法**（取自 `sample-task.js`）：

```js
$notify("Title", "Subtitle", response.body);   // Success!
$notify("Title", "Subtitle", reason.error);    // Error!
```

---

## 5. `$prefs` — 持久化存储

**出处**：`sample.conf` 第 295 行；`sample-rewrite-with-script.js` 第 11–13 行。

`[官方]` 逐字：
> `The $prefs is for persistent store: $prefs.valueForKey(key), $prefs.setValueForKey(value, key), $prefs.removeValueForKey(key), $prefs.removeAllValues().`
> `$prefs.setValueForKey(value, key), $prefs.removeValueForKey(key), $prefs.removeAllValues(). Returns true or false, value and key should be string.`
> `$prefs.valueForKey(key) returns value.`
> `the data of $prefs will be cleared when Quantumult X is deleted.`

### 5.1 四个方法

| 方法 | 参数顺序 | 返回 |
|---|---|---|
| `$prefs.valueForKey(key)` | key | 存的值；不存在时返回 `null` `[推测]` |
| `$prefs.setValueForKey(value, key)` | **value 在前，key 在后** | `true` / `false` |
| `$prefs.removeValueForKey(key)` | key | `true` / `false` |
| `$prefs.removeAllValues()` | 无 | `true` / `false` |

### 5.2 三个致命细节

1. **`setValueForKey` 的参数顺序是 `(value, key)`，与 `valueForKey(key)` 相反。**
   这是 QX 最反直觉的设计，写反了不报错、只是存到了错误的 key 上。**必须记牢。**

2. **`value` 和 `key` 都必须是 String。**
   官方原文：`value and key should be string`。
   存对象必须自己 `JSON.stringify`，取出来自己 `JSON.parse`。
   `[推测]`：传数字可能被隐式转换或存成 `undefined`，不要赌。

3. **数据随 App 卸载清空。** 官方明说 `cleared when Quantumult X is deleted`。
   → **不能当数据库用**，不能存唯一副本。重要数据要另存（例如 `$iCloud`）。

### 5.3 多账号存储的标准写法

```js
/**
 * 按账号隔离的存储层。
 * 为什么这么写：$prefs 只有扁平的 key-value，没有命名空间，
 * 所有脚本共用同一个存储空间，key 冲突会互相覆盖。
 */
const KEY_PREFIX = "myapp_checkin_";

function loadAccounts() {
    const raw = $prefs.valueForKey(KEY_PREFIX + "accounts");
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        console.log("账号数据损坏，按空处理: " + e);
        return [];
    }
}

function saveAccounts(list) {
    // setValueForKey(value, key) —— value 在前
    return $prefs.setValueForKey(JSON.stringify(list), KEY_PREFIX + "accounts");
}

function loadState(accountId) {
    const raw = $prefs.valueForKey(KEY_PREFIX + "state_" + accountId);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
}

function saveState(accountId, obj) {
    return $prefs.setValueForKey(JSON.stringify(obj), KEY_PREFIX + "state_" + accountId);
}
```

### 5.4 `$prefs.removeAllValues()` 的杀伤范围

官方没说它只清当前脚本的。`[推测]`：**它清整个 QX 的脚本持久化空间**——也就是把你所有脚本的数据一起清掉。
→ **不要在任何自动流程里调用它。** 要清单个 key 用 `removeValueForKey`。

---

## 6. `console.log(message)` — 日志

**出处**：`sample.conf` 第 296 行。

`[官方]` 逐字：`The console.log(message) will output logs to Quantumult log file.`

- 只有一个参数。要输出多个值，自己拼字符串或 `JSON.stringify` 对象。
  `[待核实]`：是否有 `console.warn` / `console.error` —— 官方文件里只出现过 `console.log`，`[推测]` 其它级别可能不存在或行为一致，**统一用 `console.log`**。
- 日志位置：QX App 内的日志面板（"日志"/"Log" 标签）。
- **不要在每个循环里无脑打日志**，Network Extension 有内存限制（官方在 `sample-backend.js` 明说 `the NE has the memory limitation`），日志量大可能影响稳定性。

### 6.1 建议的日志格式

```js
function log(step, msg) {
    console.log("[" + new Date().toISOString() + "][" + step + "] " + msg);
}
log("INIT", "开始执行");
```

带步骤名和时间戳，出问题时能在几十行里一眼定位。

---

## 7. `setTimeout(fn, ms)` — 延时

**出处**：`sample.conf` 第 297 行；`sample-task.js`。

`[官方]` 逐字：`The setTimeout(function() { }, interval) will run function after interval(ms).`

- 单位毫秒。
- `sample-task.js` 里用它实现**脚本强制超时**——这是个很实用的官方模式：

```js
// Script engine timeout, unit: ms.
if (args["force-timeout"] !== undefined) {
    const forceTimeout = args["force-timeout"];
    setTimeout(() => {
        console.log("Force exit for " + forceTimeout + " ms timeout.");
        $done();
    }, parseInt(forceTimeout));
}
```

**为什么需要**：QX 的脚本引擎没有官方文档化"超时后怎么办"。自己挂一个 `setTimeout` 兜底，保证任何分支下 `$done()` 都会被调用，避免任务永久挂起、下轮任务不执行。

**注意**：`setTimeout` 兜底的 `$done()` 和正常流程的 `$done()` 会重复调用。`$done` 重复调用是否安全官方未说明，`[待核实]`。稳妥写法是加个 flag：

```js
let finished = false;
function finish(payload) {
    if (finished) return;
    finished = true;
    $done(payload);
}
setTimeout(() => { log("TIMEOUT", "超时强制结束"); finish(); }, 60000);
```

- `[待核实]`：`setInterval` / `clearTimeout` 是否可用。官方文件中**从未出现**，不要用。

---

## 8. `$task.fetch(request)` — 发 HTTP 请求

**出处**：`sample.conf` 第 329 行；`sample-task.js`；`sample-bytes-rewrite.js`；`sample-fetch-opts-policy.js`。

`[官方]` 逐字：
> `The $task.fetch() compose a HTTP request and deal with the response, only text body is supported. A $task.fetch() can be embeded in the completion handler of another $task.fetch(), if you want serial requests not current requests.`
> `The default HTTP request timeout is 10 seconds.`

### 8.1 请求结构（逐字取 sample-task.js）

```js
const myRequest = {
    url: url,
    method: method,            // Optional, default GET.
    headers: headers,          // Optional.
    body: JSON.stringify(data),// Optional.
    opts: {
        'redirection': true,        // default true, supported since build 210
        'skip-cert-verify': false,  // default false, supported since build 649
        'auto-cookie': false        // default false, supported since build 934
    } // The "opts" is optional.
};
```

### 8.2 返回值

`[官方]` `sample-task.js` 注释逐字：`// response.statusCode, response.headers, response.body`

```js
$task.fetch(myRequest).then(response => {
    // response.statusCode  Number
    // response.headers     Object
    // response.body        String
    // response.bodyBytes   ArrayBuffer（sample-bytes-rewrite.js 用过 response.bodyBytes）
    $done();
}, reason => {
    // reason.error         String
    $done();
});
```

**注意这是 Promise 双回调写法**（`.then(onFulfilled, onRejected)`），不是 `.catch()`。两者在 JS 里等价，但官方示例全用双回调，跟着写避免风格混杂。

### 8.3 `opts` 全部选项与版本门槛

| 选项 | 默认 | 最低版本 | 官方原文要点 |
|---|---|---|---|
| `redirection` | `true` | build 210 | 老版本忽略此字段，**永远跟随重定向**（等效 true） |
| `skip-cert-verify` | `false` | build 649 | 老版本忽略此字段，**永远校验证书**（等效 false） |
| `auto-cookie` | `false` | build 934 | 老版本忽略此字段，**永远启用自动 cookie jar**（等效 true）。注意默认值反了 |
| `policy` | — | v1.0.25-build598 | 指定走哪个策略/节点发请求 |
| `filter` | — | **v1.0.17 起废弃** | 见下 |

### 8.4 `policy` 选项的代价（官方明确警告）

`[官方]` `sample-fetch-opts-policy.js` 逐字：

> `$task.fetch request with specific policy option will lose the optimization of connection reuse, It means that every HTTPS request with the specific policy option will has the complete TCP handshake and TLS handshake, This option is only recommended for some special usecases such as server info(geo location) checking.`

→ **用了 `policy` 就没有连接复用，每次请求完整 TCP + TLS 握手。** 只适合 IP 归属地检测这类低频场景。批量签到**不要**用它。

```js
var myRequest = {
    url: "http://ip-api.com/json",
    opts: { policy: "direct" }
};
```

### 8.5 `filter` 选项（已废弃）

`[官方]` `sample-fetch-opts-filter.js` 逐字：

> `Deprecated since v1.0.17`
> `The new filter options has less memory footprint of Network Extension, it is recommended to use the option when response body is larger than 512 KB.`
> `For the data size less then 128 KB filter is not recommended.`
> `The original body in the filter script environment is the variable "body", and the filter script should just return directly (synchronize) with the filtered result (as a string).`
> `If the result is more than 16 KB, an error will be thrown.`
> `It is worth noting that the filter module is only for "filter" usage, no other APIs are supported.`

→ 场景：响应体 > 512KB 时，用 filter 在原生侧先裁掉不需要的部分，省 NS 内存。**filter 字符串里不能用任何 QX API**，只能 `return`。

```js
const bodyFilter = 'var result = JSON.parse(body); return JSON.stringify(result[167]);';
const myRequest = { url: url, opts: { 'filter': bodyFilter } };
```

### 8.6 二进制下载的正确姿势

`$task.fetch` 官方说 `only text body is supported`，但 `sample-bytes-rewrite.js` 实际用了 `response.bodyBytes`：
→ `[推测]`：文本接口返回 `body`，二进制走 `bodyBytes` 这个旁路。**同时只有其中一个有值。**

```js
$task.fetch({ url: imgUrl }).then(response => {
    $done({ bodyBytes: response.bodyBytes });   // 直接把下载的图当响应体
}, reason => {
    $done();   // 失败就放行原响应
});
```

### 8.7 10 秒超时的应对

官方硬性 10 秒。批量任务里单请求超时会拖垮整轮，必须：

1. **单个请求失败不影响其它** —— 每个账号独立 catch。
2. **不要串行跑几十个账号** —— 串行 20 个账号 × 最坏 10 秒 = 200 秒，可能撞上任务本身的时间限制（具体限制官方未文档化，`[待核实]`）。
3. 需要并发时，**用 `Promise.all` 但控制批次**（见 05 文档示例）。

---

## 9. `$configuration.sendMessage(message)` — 读写 QX 运行时配置

**出处**：`sample-configuration-api.js`、`sample-dns-api.js`、`sample-get-traffic-statistics.js`。
**版本**：`[官方]` `@supported Quantumult X (v1.0.22-build545) iOS 13.0 +`（configuration）、`(v1.0.22-build562) iOS 13.0 +`（DNS）。

### 9.1 通用调用形态

```js
const message = { action: "动作名", content: 参数 };
$configuration.sendMessage(message).then(resolve => {
    if (resolve.error) { console.log(resolve.error); }
    if (resolve.ret)   { console.log(JSON.stringify(resolve.ret)); }
    $done();
}, reject => {
    // Normally not gonna happen.
    $done();
});
```

**返回对象两个字段**：`resolve.error`（错误信息，字符串）和 `resolve.ret`（结果对象）。**两个都要判**，可能只有 error。

### 9.2 全部 action 清单（逐条取自官方注释）

#### 策略相关

| action | content | 返回 |
|---|---|---|
| `url_latency_benchmark` | 服务器 tag 字符串数组 | `{"ret": {"Node-001": [31, 126], "Node-002": [23, -1]}}` —— 数组是延迟值，`-1` 表示失败 |
| `get_server_description` | 单个 tag 字符串 | `{"ret": {"TheTag": "socks5=example.com:80,fast-open=false,udp-relay=false,tag=TheTag"}}`；无此 tag 返回 `{"ret":{"TheTag":""}}` |
| `get_customized_policy` | 无 / 单个策略名字符串 / 策略名数组 | JSON |
| `get_policy_state` | 无 | `{"ret": {"policy1": ["policy1", "中间策略", ..., "叶子节点"], ...}}` |
| `set_policy_state` | `{"proxy":"Node-002","cPolicy":"Node-007"}` | 更新后的 policy state |
| `get_running_mode` | 无 | 运行模式 |
| `set_running_mode` | `{"running_mode": "all_proxy"}` | 见下 |

**`get_server_description` 的硬限制** `[官方]`：
> `only available for event-interaction script and v1.0.30-build691 iOS 13.0 +`
> `This action does not support empty or array content input, since getting all servers is inappropriate.`
→ **只能在 `event-interaction` 脚本里用**，且只能传单个 tag，不能传数组、不能传空。

**`set_policy_state` 的三个副作用** `[官方]`：
> `This only works for the static type policy and the built-in policy named "proxy".`
> `Related active connections will be closed if the "Moderated Policy Mechanism" is turned off`
> `the returned JSON from set_policy_state will resolve (promise) only when all the related connections are closed.`
> `If this API is called in a response type script, even all the related active connections (including the connection that called this API) will be closed, but actually the reponse of this connection has already been completely received.`

→ **只在 `static` 类型策略组或内置 `proxy` 上有效**。
→ **返回值要等所有相关连接关闭才 resolve** —— 在 response 脚本里调用会把自己这条连接也关掉，但响应已经收完所以不出错。**别在 response 脚本里等它的结果。**

**`set_running_mode` 的合法值** `[官方]`：注释里列了 `all_proxy, all_direct, filter`（来自 `/* all_proxy, all_direct, filter` 这行）。

#### DNS 相关

| action | content | 说明 |
|---|---|---|
| `dns_get_placeholder_ip` | host 字符串 | 拿 host 对应的保留 IP（如 `198.18.1.23`）。官方：`This ip-domain mapping mechanism is mostly used in the filter module and MitM module` |
| `dns_update_cache` | `{"host":"abc.debug","ips":["192.168.0.1"],"ttl":60}` | 写入/更新 DNS A 记录。**ttl 为负数时清除该缓存** |
| `dns_clear_cache` | 无 | 清空全部 DNS 缓存 |

**极易混淆的一点** `[官方]` 逐字：
> `Don't confuse the ip in DNS A record with the reserved ip fetched from dns_get_placeholder_ip. The ip in DNS A record is the real ip for outbound connections.`

→ `dns_get_placeholder_ip` 拿到的是**假的保留 IP**（给 filter/MitM 用的映射地址）；`dns_update_cache` 写的是**真实出口 IP**。两个不是一回事。

#### 流量统计

| action | content | 说明 |
|---|---|---|
| `get_traffic_statistics` | 无 | 结果单位是**字节**。`@supported v1.0.28-build631 iOS 13.0 +` |

```js
// sample-get-traffic-statistics.js 原文
const message = { action: "get_traffic_statistics" };
$configuration.sendMessage(message).then(resolve => {
    if (resolve.error) console.log(resolve.error);
    if (resolve.ret)   console.log(JSON.stringify(resolve.ret, null, 2));
    $done();
}, reject => { $done(); });
```

`[待核实]`：`ret` 的具体字段名（上行/下行/total）官方示例只打印不解析，没有字段说明。**要用就得先跑一次看实际结构。**

---

## 10. `$iCloud` — 读写 iCloud 文件

**出处**：`sample-icloud-storage.js`。
**版本**：`[官方]` `@supported Quantumult X (v1.0.31-build717)`

`[官方]` 逐字：`$iCloud.writeFile(Uint8Array, path), $iCloud.readFile(path), iCloud.removeFile(path)`

**目录**：`iCloud Drive/Quantumult X/Data/`（官方注释：`in the directory of iCloud Drive/Quantumult X/Data/`）

| 方法 | 参数 | 返回 |
|---|---|---|
| `$iCloud.writeFile(uint8Array, path)` | 字节数组、相对路径 | `true` / `false` |
| `$iCloud.readFile(path)` | 相对路径 | `Uint8Array`；文件不存在返回 `undefined` |
| `$iCloud.removeFile(path)` | 相对路径 | `true` / `false` |

**注意官方注释里第三个方法漏了 `$`**（写成 `iCloud.removeFile`），但示例代码里用的是 `$iCloud.removeFile(filePath)`。**以示例代码为准。**

### 10.1 文本读写模板

```js
// 写
const encoder = new TextEncoder();
const bytes = encoder.encode("Hello World 😀 !");
if ($iCloud.writeFile(bytes, "world/birth.txt")) {
    console.log("OK");
} else {
    console.log("NO");
}
$done();

// 读
const readUint8Array = $iCloud.readFile("world/birth.txt");
if (readUint8Array === undefined) {
    console.log("NOT FOUND");
} else {
    const textDecoder = new TextDecoder();
    console.log(textDecoder.decode(readUint8Array));
}
$done();
```

### 10.2 传入 ArrayBuffer（给 http_backend 用）

`[官方]` `backend-icloud-to-http.js` 的切片写法，**这是处理 Uint8Array 的正确姿势**：

```js
let profileUint8Array = $iCloud.readFile(filePath);
if (profileUint8Array === undefined) {
    $done({ status: "HTTP/1.1 404 Not Found", headers: { "Connection": "Close" } });
    return;
}
// 必须切片：Uint8Array.buffer 可能包含 byteOffset 之前的数据
let profileBuffer = profileUint8Array.buffer.slice(
    profileUint8Array.byteOffset,
    profileUint8Array.byteLength + profileUint8Array.byteOffset
);
$done({ status: "HTTP/1.1 200 OK", headers: {"Connection":"Close"}, bodyBytes: profileBuffer });
```

`[官方]` `sample-bytes-rewrite.js` 也强调这一点：
> `If you are getting buffer directly from another Uint8Array, you probably want slicing the results.`
> `$done({bodyBytes: otherUint8.buffer.slice(otherUint8.byteOffset, otherUint8.byteLength + otherUint8.byteOffset)});`

→ **`uint8.buffer` 不等于"这个 Uint8Array 的内容"**，它可能是更大的底层缓冲区。不 slice 会带上垃圾数据。

**`$iCloud` 能读的路径范围**（官方原文）：`the iCloud files HTTP backend can fetch are always located in 「iCloud Drive /Quantumult X/Data/」 or its subdirectories` —— 只能在这个目录及其子目录内。

---

## 11. `$environment` — 脚本运行环境

**出处**：`sample.conf` 第 342 行；`sample-task.js`；`sample-fetch-opts-policy.js`。

### 11.1 三个已知字段

| 字段 | 出处 | 说明 |
|---|---|---|
| `$environment.variables` | `sample-task.js:16`，`[官方]` `is supported since v1.5.6 build 918` | 对象，从 URL `#` 后解析出的键值对，值全是 String |
| `$environment.sourcePath` | `sample.conf:342` | 脚本自身的完整加载路径（含 `#` 后面的部分） |
| `$environment.params` | `sample-fetch-opts-policy.js:33` | `[官方]` `The $environment.params is auto passed in when user triggered a UIAction and is related to the configuration element. Right now only suppots the server tag.` |

### 11.2 `variables` 的用法

配置侧（`[官方]` sample-task.js 头部）：

```ini
[task_local]
0 0 * * * https://example.com/sample.js#force-timeout=10000&method=POST, tag=Sample, enabled=true
```

脚本侧：

```js
const args = $environment.variables;   // { "force-timeout": "10000", "method": "POST" }
```

**注意**：
- 值**全是字符串**，`"10000"` 要 `parseInt`。
- 参数名带连字符时只能 `args["force-timeout"]`，不能 `args.force-timeout`（语法错误）。
- **配置行里 `,` 是分隔符，哈希值里不能含逗号。**
- 老版本（< v1.5.6 build 918）没有 `variables`，要自己从 `sourcePath` 里切：

```js
// 兼容老版本的降级写法
function getArgs() {
    if (typeof $environment !== "undefined" && $environment.variables) {
        return $environment.variables;
    }
    // 降级：从 sourcePath 手动解析
    const out = {};
    const src = (typeof $environment !== "undefined" && $environment.sourcePath) || "";
    const idx = src.indexOf("#");
    if (idx < 0) return out;
    src.substr(idx + 1).split("&").forEach(pair => {
        const eq = pair.indexOf("=");
        if (eq < 0) return;
        out[decodeURIComponent(pair.substr(0, eq))] = decodeURIComponent(pair.substr(eq + 1));
    });
    return out;
}
```

### 11.3 `params` 只服务于 UIAction

`[官方]` 原文只有一句（见上）。含义：`event-interaction` 任务被用户点击 UIAction 触发时，QX 自动把**相关配置元素**（目前只支持 server tag）塞进 `$environment.params`。

官方给的实际用途（`sample-fetch-opts-policy.js` 注释里）：

```js
var opts = { policy: $environment.params };   // 用被点击的那个节点测 IP
```

→ 典型场景：给每个节点配一条 UIAction，用户点某个节点就用该节点出口测 IP 归属地。

`[待核实]`：`$environment` 里是否还有 `buildVersion`、`app`、`system` 等字段。**官方文件中没有出现，不要依赖。** 需要版本判断时，用能力探测（`typeof $iCloud !== "undefined"`）而不是版本号。

---

## 12. `$resource` — 资源解析器专用

**出处**：`resource-parser.js`。**仅用于 `resource_parser_url` 指定的脚本。**

| 字段 | 说明 |
|---|---|
| `$resource.link` | `[官方]` `contains the original URL of the resource or the path if the resource is local` |
| `$resource.content` | `[官方]` `contains the response(UTF8) from the URL` |
| `$resource.info` | 服务器类资源在 v1.0.10-build277 起可用，含响应头里的 `subscription-userinfo` 字段 |
| `$resource.tag` | 服务器类资源在 v1.0.10-build277 起可用，含自定义资源 tag |
| `$resource.user_agent` | **v1.5.6-build921 起**。当前下载所用的 UA；首次为空，重试时为你上次返回的 UA |

`[官方]` 硬限制：`HTTP reqeust and persistent storage related APIs are not supported in resource parser.`
→ **解析器里不能用 `$task.fetch`，不能用 `$prefs`。** 只有 `$resource`、`$notify`、`$done`。

### 12.1 返回格式

```js
$done({ content: "转换后的配置内容" });
$done({ error: "错误描述" });
$done({ content: parsed, retry: { user_agent: "AnyUserAgent/1.0" } });  // UA 重试
```

**UA 重试机制**（`[官方]`，v1.5.6-build921）：

> `$done({retry: {user_agent: "..."}})` asks native to re-download with the specified UA and parse again.
> `At most 1 retry per resource: a non-empty $resource.user_agent means you are already in a retry; returning retry again has no effect.`
> `Older Quantumult X versions ignore the retry field, so it is recommended to return content / error alongside as a fallback.`
> `Priority on new version: retry > content / error.`

→ 用途：某些订阅源对默认 UA 返回乱码/反爬页，检测到后换 UA 重下一遍。
→ **必须同时给 `content` 或 `error` 作为老版本兜底**，否则老版本什么都不做。

官方逻辑骨架：

```js
const currentUA = $resource.user_agent;
const inRetry = currentUA && currentUA.length > 0;

const result = { content: parsed };   // 或 error: "..."
const wantRetry = /* 你的检测逻辑 */;
if (wantRetry && !inRetry) {
    result.retry = { user_agent: "AnyUserAgent/1.0" };
}
$done(result);
```

---

## 13. `$parser` — 资源解析器的参数化 UI（草案协议）

**出处**：`parser-helper-protocol.md`（官方仓库内的协议草案 v1）。

> **重要**：这份文档标题写明是「草案 v1」，**不是正式 API 承诺**，章节 9 还专门有「协议演进」。用它做的脚本可能随 QX 更新而失效。`[风险]`

### 13.1 注入方式

`[官方]`：`$parser` 是**预先创建好的全局空对象**，作者自己在脚本顶层挂三个函数：

```js
$parser.hashSchema = function () { ... };
$parser.hashToUI   = function (hash) { ... };
$parser.uiToHash   = function (values) { ... };
```

**存在性检测**（官方给的探测代码）：

```js
typeof $parser === 'object' &&
typeof $parser.hashSchema === 'function' &&
typeof $parser.hashToUI === 'function' &&
typeof $parser.uiToHash === 'function'
```

### 13.2 三个函数的职责

| 函数 | 职责 | 返回值 |
|---|---|---|
| `$parser.hashSchema()` | 声明 UI 结构（有哪些分组、控件、默认值） | Schema 对象 |
| `$parser.hashToUI(hash)` | 把 URL `#` 后的参数字符串转成 UI 表单值 | values 对象 |
| `$parser.uiToHash(values)` | 把用户在 UI 上改的值转回 `#` 参数字符串 | hash 字符串 |

**关键约束** `[官方]`：`三个函数均为 零或单参数，不传 context —— 作者需要读取环境信息时直接使用现有全局对象（$environment / $resource …）`

**三个函数必须自包含**（章节 7 标题）：不能互相依赖外部变量，因为 QX 可能在隔离环境里单独调用它们。

### 13.3 四种控件类型

`[官方]` 章节 5：`switch`、`select`、`text`、`tags`。

`[待核实]`：各控件的完整字段（如 `select` 的 options 结构、`text` 的 placeholder）。官方文档有 JSON 结构定义（章节 4），实际使用时请对照 `parser-helper-protocol.md` 第 93–235 行的 schema 定义。

---

## 14. 完整 API 速查表

| API | 版本门槛 | 可用脚本类型 | 官方出处 |
|---|---|---|---|
| `$request.*` | 全部 | rewrite / backend | sample.conf:291-293 |
| `$response.*` | 全部 | rewrite | sample.conf:291-293 |
| `$response.bodyBytes` | v1.0.19-build480+iOS14 / v1.0.21-build535+iOS13 | rewrite | sample-bytes-rewrite.js:12 |
| `$done(any)` | 全部 | 全部 | 各示例 |
| `$notify(t,s,m)` | 全部 | rewrite / task / backend / parser | sample.conf:294 |
| `$prefs.valueForKey(k)` | 全部 | 除 parser 外 | sample.conf:295 |
| `$prefs.setValueForKey(v,k)` | 全部 | 除 parser 外 | sample.conf:295 |
| `$prefs.removeValueForKey(k)` | 全部 | 除 parser 外 | sample.conf:295 |
| `$prefs.removeAllValues()` | 全部 | 除 parser 外 | sample.conf:295 |
| `console.log(m)` | 全部 | 全部 | sample.conf:296 |
| `setTimeout(f,ms)` | 全部 | 全部 | sample.conf:297 |
| `$task.fetch(req)` | 全部（opts 分版本） | 除 parser 外 | sample.conf:329 |
| `opts.redirection` | build 210 | — | sample-task.js |
| `opts.skip-cert-verify` | build 649 | — | sample-task.js |
| `opts.auto-cookie` | build 934 | — | sample-task.js |
| `opts.policy` | v1.0.25-build598 | — | sample-fetch-opts-policy.js |
| `opts.filter` | **v1.0.17 废弃** | — | sample-fetch-opts-filter.js |
| `$configuration.sendMessage` | v1.0.22-build545 + iOS13 | task/rewrite（部分 action 限 event-interaction） | sample-configuration-api.js |
| `$configuration` DNS actions | v1.0.22-build562 + iOS13 | 同上 | sample-dns-api.js |
| `get_traffic_statistics` | v1.0.28-build631 + iOS13 | 同上 | sample-get-traffic-statistics.js |
| `get_server_description` | v1.0.30-build691 + iOS13，**仅 event-interaction** | event-interaction | sample-configuration-api.js |
| `$iCloud.*` | v1.0.31-build717 | 全部 | sample-icloud-storage.js |
| `$environment.variables` | v1.5.6 build 918 | 全部（http(s) 加载的脚本） | sample-task.js:16 |
| `$environment.sourcePath` | 未标注（早于 918） | 同上 | sample.conf:342 |
| `$environment.params` | 未标注（v1.0.25 附近） | event-interaction | sample-fetch-opts-policy.js:33 |
| `$resource.*` | v1.0.8-build253（`user_agent` 需 921） | **仅 resource parser** | resource-parser.js |
| `$parser.*` | 未标注，**草案** | **仅 resource parser** | parser-helper-protocol.md |

---

## 15. 明确不存在 / 未文档化的东西

不要在这些上浪费时间：

| 你以为有 | 实际情况 |
|---|---|
| `$script` | **不存在**（Surge/Loon 有）。官方仓 0 处 |
| `$persistentStore` | **不存在**（Surge/Loon 有）。用 `$prefs` |
| `$httpClient` | **不存在**（Surge/Loon 有）。用 `$task.fetch` |
| `$notification` | **不存在**（Loon 有）。用 `$notify` |
| `$argument` | **不存在**（Surge/Loon 有）。用 `$environment.variables` |
| `$utils.gzip` / `$crypto.aes` | **不存在**（Loon 有） |
| `$dns.query` | **不存在**（Loon 有）。QX 只有 `$configuration` 的 DNS action |
| `$config.getConfig()` | **不存在**（Loon 有）。QX 用 `$configuration.sendMessage` |
| `setInterval` | **官方从未出现** `[待核实]` |
| `clearTimeout` | **官方从未出现** `[待核实]` |
| `require` / `import` / `module.exports` | **不存在**。QX 脚本是独立单文件，无模块系统 |
| `fetch` / `XMLHttpRequest` | **不存在**。用 `$task.fetch` |
| `localStorage` / `window` / `document` | **不存在**。不是浏览器环境 |
| `Buffer` / `process` / `fs` | **不存在**。不是 Node.js 环境 |
| `async` / `await` | `[待核实]`。官方所有示例都是 ES5 + Promise 回调，**没有一处用 async/await**。建议不依赖 |

**关于 `async/await`**：语法上 QX 的引擎（JavaScriptCore）大概率支持，但官方从未在示例中使用，也没有 `await` 与 `$done` 交互的任何说明。**能用 Promise 就用 Promise**，不要赌。

**关于 `TextEncoder` / `TextDecoder`**：`sample-icloud-storage.js` 里用了，说明可用。
