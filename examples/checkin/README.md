# 自动签到示例（Quantumult X）

> **本示例只对接自建测试服务，不含任何真实站点地址、真实接口或真实账号格式。**
> 想接到自己的服务上，只改 `checkin.js` 底部的 `CFG` 区块（`base` + 三条 `path`）。

---

## 1. 文件清单

| 文件 | 作用 | 跑在哪 |
|---|---|---|
| `checkin.js` | 签到主脚本 | **iPhone 上的 Quantumult X** |
| `mock-server.js` | 自建测试服务（Node.js，无第三方依赖） | 电脑，用于验证 |
| `test-harness.js` | 在 Node 里模拟 QX 运行时跑 `checkin.js`，验证逻辑与错误分支 | 电脑 |
| `README.md` | 本文件 | — |

### 自建接口定义（全部自造，无真实服务对应）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | body `{"user":"u1","pass":"p1"}` → `{"code":0,"data":{"token":"tk_u1_xxx","expiresIn":86400}}` |
| POST | `/api/checkin` | header `Authorization: Bearer <token>` → `{"code":0,"data":{"points":10,"totalDays":1,"nickname":"u1"}}`；重复签 → `{"code":1001,"msg":"already checked in today"}` |
| GET | `/api/profile` | 同上 header → `{"code":0,"data":{"nickname":"u1","totalDays":1,"points":10}}` |
| GET | `/api/__state` | 调试：返回所有用户状态 |
| POST | `/api/__reset` | 清空状态 |
| GET | `/api/__fault?checkin500=1` | 让 `/api/checkin` 一律回 500，用于测重试分支 |

约定：`code === 0` 成功；`1001` 表示今天已签过（按成功处理）；其他为失败。

---

## 2. 功能说明

`checkin.js` 做四件事：

1. **多账号串行签到**：账号从 `#accounts=u1:p1|u2:p2` 参数或 `$prefs` 读取
2. **token 复用与自动重登**：token 存 `$prefs`，遇到 401 自动重登一次再补签
3. **失败重试**：网络错误和 5xx 按 `retry` 次数指数退避重试
4. **当日幂等**：今天已全部成功过就直接跳过（`force=1` 可强制重跑）
5. **结果通知 + 历史落盘**：`$notify` 一条汇总，`$prefs` 存最近 30 天记录

---

## 3. 工作原理

```
[task_local] cron 触发
        │
        ├─ 读 ARGS（$environment.variables）
        ├─ 读 $prefs["qx_checkin_accounts"]（已存账号 + token）
        ├─ 读 $prefs["qx_checkin_last_run"] → 今天跑过且无失败？→ 直接 $done()
        │
        ├─ guard(60s)  ← setTimeout 兜底，超时强制 $done() 并通知
        │
        └─ 逐账号串行：
             需要的 token？没有 → POST /api/login
             POST /api/checkin (Authorization: Bearer …)
               ├─ 401 → 清 token → 重登 → 再签一次
               ├─ 5xx / 网络错误 → 退避重试（最多 retry 次）
               └─ code 1001 → 记为「今日已签到」但仍算成功
             GET /api/profile  ← 补累计天数/积分（失败不影响主结果）
        │
        ├─ $notify(汇总标题, "N 成功 / M 失败", 明细)
        ├─ 写 lastRun + history
        └─ $done()
```

**为什么串行不并发**：QX 官方没有公开 `$task.fetch` 的并发上限，账号多时并发容易互相拖死，串行换来的稳定性更值。

**为什么要 `guard()`**：QX 脚本引擎不会替你掐断超时。官方 `sample-task.js` 就是用 `setTimeout` 自己掐（`// Script engine timeout, unit: ms.`）。不写这个，一旦某个 Promise 永不 resolve，脚本会一直挂着。

---

## 4. 完整代码

见 `checkin.js`（约 400 行，全部注释在代码里）。

---

## 5. Quantumult X 配置

把 `checkin.js` 放到 **`iCloud Drive → Quantumult X → Scripts`** 或 **`On My iPhone → Quantumult X → Scripts`**。
（官方硬约束：rewrite/task 脚本只能放这两个目录，或走 https 远程 URL。）

```ini
[task_local]
5 8 * * * checkin.js#accounts=u1:p1|u2:p2&base=http://192.168.1.10:8787&log=1, tag=每日签到, enabled=true
```

### 参数说明

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `accounts` | 否 | 空 | `用户名:密码`，多个用 `\|` 分隔。**不写就改用 `$prefs` 里已存的** |
| `base` | 否 | `http://127.0.0.1:8787` | 服务根地址 |
| `log` | 否 | `0` | `1` = 打详细日志到 QX 日志 |
| `force` | 否 | `0` | `1` = 忽略当日幂等，强制重跑 |
| `retry` | 否 | `1` | 单请求失败重试次数 |

⚠️ **参数行的三个坑**（都来自 QX 的解析规则）：

1. **`#` 之后才是参数**，`#` 前是脚本路径。官方 sample-task.js 注释：`The plain (not encoded) hash tag (#) of the url is just a client-side thing`
2. **参数里不能有逗号** —— `,` 是 `[task_local]` 的参数分隔符（`tag=`、`enabled=` 都靠它）。所以 `accounts` 用 `|` 分隔
3. **`base` 用局域网 IP，不要用 `127.0.0.1`** —— 手机上的 `127.0.0.1` 是手机自己，不是你的电脑

不需要 `[rewrite_local]`，不需要 MitM（本脚本不拦流量，只主动发请求）。

---

## 6. 测试方法

### 第一步：电脑上跑自建服务

```bash
cd examples/checkin
node mock-server.js 8787
```

看到 `mock server  http://127.0.0.1:8787` 即成功。

### 第二步：电脑上验证脚本逻辑

```bash
node test-harness.js
```

`test-harness.js` 用 Node 的 `vm` 建了个沙箱，把 `$task.fetch` / `$prefs` / `$notify` / `$done` / `$environment` 全部按 QX 语义实现了一遍，然后直接跑 `checkin.js`。

**最近一次运行结果（2026-11-08）**：

```
用例 1：单账号正常签到            5 项通过
用例 2：同一天再跑一次（幂等）      2 项通过
用例 3：force=1 + 服务端 1001      2 项通过
用例 4：多账号                    2 项通过
用例 5：服务端 500 + 重试          4 项通过
用例 5b：无效 token → 重登         2 项通过
用例 6：无账号                    2 项通过
用例 7：服务不可达 + 重试          3 项通过
──────────────────────────────────
通过 22 / 失败 0
```

### 第三步：真机验证（**这一步必须做，上面全部通过也不代表 QX 里能跑**）

`test-harness.js` **验证不了**下面这些 QX 引擎特有行为：

- `$task.fetch` 的 **10 秒硬超时**（opts 里没有 timeout 字段）
- `'auto-cookie'` 的实际语义（build 934 前后默认值相反）
- QX 的 5 并发上限是否存在
- `$prefs` 的存储上限
- `$notify` 的实际截断长度
- `$environment.variables` 的解析边界（值里有 `&`、`=`、中文时）

真机步骤：

1. 手机和电脑连**同一个 Wi-Fi**，查电脑局域网 IP（`ipconfig` 看 IPv4 地址）
2. 电脑跑 `node mock-server.js 8787`
3. 手机 Safari 打开 `http://电脑IP:8787/api/__state`，能看到 `{"code":0,"data":{}}` 就说明网络通了
4. QX 里加 `[task_local]` 行，**先用 `event-interaction` 手动触发**（比等 cron 快）：
   ```ini
   event-interaction checkin.js#accounts=u1:p1&base=http://电脑IP:8787&log=1&force=1, tag=测试签到, enabled=true
   ```
5. 在 QX 首页的 UIAction 里点它
6. 看两处：**通知栏**（应有「签到成功 / 1 成功 / u1：签到成功（累计 1 天 / 10 分）」）和 **QX 日志**（搜 `[checkin]`）
7. 通了之后改回 cron：`5 8 * * * ...`

---

## 7. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 通知弹「未配置账号」 | `#accounts=` 没写，或 `$prefs` 里也没有 | 补参数，注意 `\|` 不是 `,` |
| 通知弹「签到失败 / 网络错误 ECONNREFUSED」 | 手机连不到电脑的服务 | ① `base` 是否写成 `127.0.0.1`（要改成电脑 IP）② 电脑防火墙是否拦了 8787 ③ 是否同 Wi-Fi |
| 通知永远不来，日志也没有 | 脚本没被加载 | 检查文件是否在 `Quantumult X/Scripts` 目录；在脚本第一行临时加 `$notify("QX","loaded","v1")` 自测 |
| 到点不跑 | `enabled=true` 缺失 / cron 段数不对 / 手机休眠 | 改用 `event-interaction` 手动触发验证逻辑是否正常 |
| 一直「登录失败 HTTP 0」 | 网络层没连上（不是业务错误） | 同第 2 行 |
| 一直「今日已签到」 | 服务端认为已签（正常）或本地 lastRun 残留 | `force=1` 重跑不影响结果；要清零就删 `$prefs` 的 `qx_checkin_last_run` |
| 通知正文被截断 | iOS 通知长度限制 | 已做 `.slice(0, 500)`；账号多时明细会截断，完整记录看 `$prefs["qx_checkin_history"]` |
| 脚本挂住不返回 | 某个 Promise 永不 resolve | `guard()` 会在 60 秒后强制结束并通知「超时退出」 |

### 怎么清掉测试残留

三个 key 都在 `$prefs`：

```js
$prefs.removeValueForKey("qx_checkin_accounts");
$prefs.removeValueForKey("qx_checkin_last_run");
$prefs.removeValueForKey("qx_checkin_history");
```

写一个 `event-interaction` 小脚本跑一次就能清掉。

---

## 8. 明确标记：待实测项

| 项 | 为什么待实测 |
|---|---|
| `$task.fetch` 在真机上是否真的 10 秒断开 | 官方说 10 秒，但和 `setTimeout` 的交互未文档化 |
| `'auto-cookie': true` 在当前 QX 版本的行为 | build 934 前后默认值相反，需确认你的版本 |
| `$prefs` 能存多大的 JSON | 官方没写上限（Surge 是 iOS 4MB，QX 未知） |
| 多账号串行 5 个以上是否会被引擎中断 | 无并发上限文档 |
| `$notify` 正文实际允许多长 | 官方只说「3 个参数」，没写长度 |
| `$environment.variables` 里含 `&`/`=` 的值能否正确解析 | 官方示例只给了简单 key=value |

**这份代码在 Node 模拟环境下 22 项断言全过；在真机 QX 上尚未运行验证。**
