# qx-scripts

Quantumult X 自用脚本集合。全部脚本只用 QX 原生 API，纯 ES5，可在旧 iOS 上跑。

所有结论来自 `crossutility/Quantumult-X` 官方仓库的实际源码与 `sample.conf` 注释，
不参考网上那些混用 Surge API 的「教程」。

## 在 QX 里直接引用

镜像已实测可通（2026-11-09）：

```
https://gcore.jsdelivr.net/gh/lhy-lq/qx-scripts@main/scripts/ccb-life-checkin.js
https://gcore.jsdelivr.net/gh/lhy-lq/qx-scripts@main/scripts/probe.js
```

`cdn.jsdelivr.net` 会 301 跳到被墙的 `raw.githubusercontent.com`，**不要用**。
gcore 不通时的备选：`https://ghproxy.net/https://raw.githubusercontent.com/lhy-lq/qx-scripts/main/scripts/...`

jsDelivr 有 CDN 缓存，刚 push 完 `@main` 可能要几分钟才更新。想立刻生效，把 `@main` 换成 commit 短 hash。

---

## 目录

```
qx-scripts/
├── scripts/                        ← QX 直接拉这些
│   ├── ccb-life-checkin.js         建行生活每日签到（抓包 + 重放双模式）
│   ├── ccb-dump-all.js             诊断用：全量抓取，不挑接口，回答「到底拦没拦住」
│   ├── ccb-life-capture.js         抓包器（其实已合并进上面，可单独用）
│   └── probe.js                    探针：一次性探测 QX 未文档化的运行时行为
├── config/
│   └── ccb-life.ini                建行生活脚本的 QX 配置片段
├── tools/
│   ├── ccb-life-test-harness.js    Node 离线测试台（不用真机就能验证逻辑）
│   ├── ccb-dump-test.js            ccb-dump-all.js 的 23 项离线测试
│   └── push-to-github.js           用 Contents API 往本仓库推文件
├── manuals/                        Quantumult X 开发手册（5 篇）
│   ├── 01-配置文件结构.md
│   ├── 02-JS-API参考.md
│   ├── 03-跨工具API差异.md
│   ├── 04-常见报错排查.md
│   └── 05-兼容性核实清单.md
└── examples/
    └── checkin/                    通用自动签到示例（自建 mock 服务）
```

---

## 脚本清单

### 1. ccb-life-checkin.js — 建行生活每日签到

**为什么是「重放」而不是「构造请求」**

建行生活走 `yunbusiness.ccb.com` 的 `txCtrl?txcode=` 网关，请求头里带 `sign` 和设备指纹，
每次都不一样，签名算法在 App 二进制里。自己构造请求等于逆向银行风控 —— 不做。

做法是：**你在 App 里手动签一次，脚本把那条已经签好名的请求原样存下来，之后每天重放一次。**
等于替你点了一次签到。

代价：快照会过期（token 通常几小时到几天）。过期了重新在 App 里点一次即可。
脚本会算出快照年龄，过期时在通知里明确告诉你「重新抓一次」。

**两个模式，同一个文件**

| 触发方式 | 模式 | 行为 |
|---|---|---|
| `script-request-body`（你打开 App） | 抓包 | 看到 `txCtrl` 请求就存进 `$prefs`，然后原样放行 |
| `[task_local]` 定时任务 | 签到 | 从 `$prefs` 读快照，重放，判断结果，弹通知 |

脚本靠 `typeof $request !== "undefined"` 自动分流，不需要两份文件。

**QX 配置**

```ini
[rewrite_local]
^https?:\/\/yunbusiness\.ccb\.com\/ url script-request-body https://gcore.jsdelivr.net/gh/lhy-lq/qx-scripts@main/scripts/ccb-life-checkin.js

[task_local]
17 7 * * * https://gcore.jsdelivr.net/gh/lhy-lq/qx-scripts@main/scripts/ccb-life-checkin.js, tag=建行生活, enabled=true

[mitm]
hostname = yunbusiness.ccb.com
```

`[mitm]` 必须开，且证书要装 + 信任（设置 → 通用 → 关于本机 → 证书信任设置）。

**安装步骤**

1. QX 里先开 MitM：`设置 → MitM → 生成证书 → 安装 → 去系统设置里信任`
2. 上面三段配置复制进 QX 配置文件（`设置 → 配置文件 → 编辑`）
3. 打开建行生活 App，进首页，**手动点一次签到**
4. 应该收到一条「🎉 捕获成功」通知。没收到就去 `QX → 日志` 看 `[CCB]` 开头的行
5. 收到后，到 `QX → 首页 → 风车图标 → 定时任务` 找到「建行生活」，点一次手动跑
6. 收到「✅ 签到成功」就说明整条链路通了

**注意**：GitHub raw 国内经常连不上，QX 直接拉会失败，所以配置里用的是 jsDelivr 的 gcore 节点
`gcore.jsdelivr.net/gh/lhy-lq/qx-scripts@main/...`（实测 200；`cdn.jsdelivr.net` 会 301 跳到被墙的 raw，别用）。
gcore 也不通的话换成 `ghproxy.net/https://raw.githubusercontent.com/lhy-lq/qx-scripts/main/...`。

jsDelivr 有缓存，`@main` 可能要等几分钟才更新。想立刻生效就把 `@main` 换成具体 commit 短 hash。

---

### 2. ccb-dump-all.js — 抓不到包的时候先用这个

`ccb-life-checkin.js` 的抓包模式只认 `txCtrl` 路径、只认有 body 的 POST。
如果它一点动静都没有，你无法判断是 **MitM 没通** 还是 **路径猜错了**。这个脚本不挑路径不挑 body，全抓。

它回答三个问题：

1. **MitM 到底通不通** —— 有记录就是通，没记录就是证书/隧道的问题
2. **签到走的是哪个 txcode** —— 逛一圈 App，看哪些接口被记下来了
3. **签名是不是每次都变** —— 同一个接口出现两次时，脚本会对比 body 和 sign
   - `body 完全相同` → 快照重放稳
   - `签名也不同 ← 每次都变` → 重放可能被验签拒绝，得有心理准备

```ini
[rewrite_local]
^https?:\/\/.+\.ccb\.com(\.cn)?\/ url script-request-body https://gcore.jsdelivr.net/gh/lhy-lq/qx-scripts@main/scripts/ccb-dump-all.js

[task_local]
event-interaction https://gcore.jsdelivr.net/gh/lhy-lq/qx-scripts@main/scripts/ccb-dump-all.js, tag=建行dump, enabled=true

[mitm]
hostname = %APPEND% *.ccb.com, *.ccb.com.cn
```

用法：配好 → 打开建行生活逛到签到页（能点就点一次，点不了也没关系）→ `QX → 风车 → 事件 → 建行dump` → 看通知。

- 逛的时候每见到**新的** txcode 弹一条通知，所以你知道自己走到哪一步了
- 最后那段「导出」是全部记录，按接口分组，每条带次数、签名、body 前 260 字
- 最多存 40 条，超出丢最老的
- 噪音路径（`/log` `/report` `/track` `/stat` 和图片样式）会记录但标记 `[噪音]`，不弹通知

诊断完把这一段从配置里删掉，换回 `ccb-life-checkin.js` 那一段，否则每次开 App 都弹。

⚠️ 注意：`[rewrite_local]` 里只留**一个**脚本指向同一个域名。QX 对同一 URL 只执行其中一条（issue #124 的实证），两个抓包脚本同时开着会互相顶掉。

---

### 3. probe.js — QX 运行时探针

官方没有 API 文档。这个脚本一次跑完，把 12 项「文档里没写、但会直接影响你写脚本」的行为测出来：

- `setInterval` / `clearInterval` / `clearTimeout` 存不存在
- `$prefs` 存对象、存数字，读回来是什么类型（决定你该不该 `JSON.stringify`）
- `$prefs` 空 key 会不会静默失败
- `$environment` 实际有哪些字段
- `$task.fetch` 在 `event-interaction` 上下文能不能用
- `get_running_mode` / `get_traffic_statistics` 返回的 `ret` 长什么样

结果全走 `$notify`，分 3 条弹出来。

```ini
[task_local]
event-interaction https://gcore.jsdelivr.net/gh/lhy-lq/qx-scripts@main/scripts/probe.js, tag=QX探针, enabled=true
```

触发：`QX → 首页 → 风车 → 事件 → QX探针`。**必须 QX 隧道在跑**，否则 `event-*` 任务不触发（官方 `sample.conf:336` 写明了）。

---

## 手册

`manuals/` 下 5 篇，是针对 QX 写的，不是抄 Surge 文档。

| 文件 | 内容 |
|---|---|
| `01-配置文件结构.md` | 所有配置区块、rewrite 六种类型的语义、官方 7 条硬约束 |
| `02-JS-API参考.md` | 逐个 API 带出处，开头第 0 节先排掉 5 个「看起来是 QX 其实不是」的伪 API |
| `03-跨工具API差异.md` | QX vs Surge vs Loon vs Shadowrocket，含 15 步机械替换表 |
| `04-常见报错排查.md` | 五层定位法 + 报错总表 + 十类高频根因按频率排序 |
| `05-兼容性核实清单.md` | 每条结论标 ✅ 已核实 / 🟡 部分 / 🔴 待实测，附复现命令 |

**最容易踩的一个坑**（手册里排第一，这里也说一遍）：

```js
$notification.post(title, subtitle, body);  // ← 错，这是 Surge 的 API
$notify(title, subtitle, message);          // ← 对，QX 用这个，恰好 3 个参数
```

QX 里 `typeof $notification === "undefined"`，用错了不会报错，只是**通知一行都不弹**，
脚本看起来「跑了但没反应」，能查半天。

同类伪 API：`$script`、`$persistentStore`、`$httpClient`、`$argument`。
正确的对应关系是 `$prefs`、`$prefs`、`$task.fetch`、`$environment.variables`。

---

## 测试

不用真机也能验证脚本逻辑：

```bash
cd tools
node ccb-life-test-harness.js   # 签到主脚本，14 用例
node ccb-dump-test.js            # 全量抓取诊断器，23 用例
```

用 Node 的 `vm` 造一个 QX 语义的沙箱（`$prefs` / `$notify` / `$task.fetch` 10 秒硬超时 / `$done` 单次），
直接加载脚本跑。

`ccb-life-test-harness.js` 的 14 个用例：抓包 3 项、无快照、签到成功、今日已签、401、500、非 JSON、
业务码失败、`code=0` 但 `success=false`、当日幂等、有登录快照先刷新、超时兜底。

`ccb-dump-test.js` 的 23 个用例：抓包存入、txcode 提取、签名提取、首见弹通知、同 txcode 第二次不弹、
噪音标记、空 body GET、上限 40 条丢最老、无数据提示、签名每次都变的判定、body 完全相同判定、
长内容分块（每条 ≤650 字符）、`$done` 恰好一次。

当前结果：**14 / 14** 与 **23 / 23** 全通过。

---

## 版本记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-09 | v3.1 | 新增 `ccb-dump-all.js`（全量抓取诊断器，23 项离线测试全过）+ `tools/ccb-dump-test.js`；`config/ccb-life.ini` 加第 0 段诊断配置。动机：手动签到已经点过了，`ccb-life-checkin.js` 的抓包模式抓不到东西，需要先判断是 MitM 不通还是路径猜错。 |
| 2026-11-09 | v3 | 重写建行生活签到。修了 v2 的致命问题（`$notification.post` 不是 QX API，通知全不弹）、无效的 `timeout: 15000`、ES6 语法；新增当日幂等、快照年龄判断、会话失效与网络失败分开报。14 项离线用例全过。 |
| 2026-11-08 | — | 手册初版 + 通用签到示例 |

---

## 已知待办

- [ ] `probe.js` 的 12 项结果需要真机跑一次回填到手册 05 文档
- [ ] `ccb-dump-all.js` 的真机结果，用来决定签到走「快照重放」还是另找路子
- [ ] 拿到建行真实返回后收窄 `judge()` 的 `okCodes`
- [ ] issue #44（`$done({status})` 改状态码无效）官方未回应
- [ ] issue #135（多个 `Set-Cookie` 被合并成逗号串）官方未回应
- [ ] `[task_local]` 6 段 cron 的每段含义官方没写明，待实测

---

## 免责

脚本只操作自己账号的日常签到，不涉及任何绕过授权、伪造身份、修改他人数据的逻辑。
签到请求全部来自你自己在 App 里的操作快照，脚本不做构造也不做破解。
