/**
 * 建行生活 · 每日签到 v3（请求快照重放版）
 * 适用：iOS Quantumult X
 *
 * ===================== 为什么是「重放」不是「构造」 =====================
 * 建行生活走 yunbusiness.ccb.com 的 txCtrl 网关，请求里带 sign / 设备指纹，
 * 每次都不一样，算法在 App 里。自己构造请求等于逆向银行风控，不现实。
 *
 * 正确做法：你在 App 里手动签一次，脚本把那条「已经签好名」的请求原样存下来，
 *           之后每天把这条请求重放一次 —— 等于替你点了一次签到。
 *
 * 代价：快照会过期（token 通常几小时到几天）。过期了重新在 App 里点一次即可。
 *       本脚本会算出快照年龄并在通知里告诉你，过期时明确提示「重新抓一次」。
 *
 * ===================== v3 相对 v2 修的 6 个问题 =====================
 * 1. 【致命】v2 用 $notification.post() —— 这不是 QX 的 API，是 Surge 的。
 *    在 QX 里 typeof $notification === "undefined"，所以通知一行都不会弹，
 *    只在 console.log 留一行。v3 改用 $notify(title, subtitle, message)。
 *    核实方法：grep -rn '$notification' 官方仓，只命中 surge_*.html。
 * 2. v2 的 timeout: 15000 无效 —— QX 的 $task.fetch 硬超时固定 10 秒，
 *    opts 里根本没有 timeout 这个字段（sample-task.js 的 opts 只有 5 项）。
 * 3. v2 大量用 const / let / 箭头函数 / findIndex / for...of。
 *    QX 的 JSContext 在旧 iOS 上对这些支持不稳，v3 全部改 ES5。
 * 4. v3 增加当日幂等：今天成功过就不再打接口，避免重复请求触发风控。
 * 5. v3 增加快照年龄判断：超 24 小时主动提示重新抓包。
 * 6. v3 增加「会话失效」关键词识别，把 401 类失败和网络失败分开报 ——
 *    这两种的处理方式完全不同，混在一起报你没法判断该干嘛。
 *
 * ===================== QX 配置 =====================
 * [rewrite_local]
 * ^https?:\/\/yunbusiness\.ccb\.com\/ url script-request-body https://gcore.jsdelivr.net/gh/lhy-lq/qx-scripts@main/scripts/ccb-life-checkin.js
 *
 * [task_local]
 * 17 7 * * * https://gcore.jsdelivr.net/gh/lhy-lq/qx-scripts@main/scripts/ccb-life-checkin.js, tag=建行生活, enabled=true
 *
 * [mitm]
 * hostname = yunbusiness.ccb.com
 *
 * 注：GitHub raw 国内常被墙，QX 直接拉会失败，所以上面用 jsDelivr 镜像。
 *     若 jsDelivr 也不通，改用 ghproxy.net 前缀。
 */

// ===================== 配置 =====================

var KEY_SIGN  = "CCB_LIFE_SIGN_REQ";    // 签到请求快照
var KEY_LOGIN = "CCB_LIFE_LOGIN_REQ";   // 登录请求快照（有则先重放刷新会话）
var KEY_LAST  = "CCB_LIFE_LAST_OK";     // 上次成功日期
var KEY_TS    = "CCB_LIFE_CAPTURE_TS";  // 抓包时间

var MAX_ACCOUNTS = 5;

var TITLE = "建行生活签到";

// 不该原样重发的头：长度会变、host 由 fetch 自己填、connection 是逐跳的
var HOP_HEADERS = [
  "content-length", "host", "accept-encoding",
  "connection", "transfer-encoding"
];

// ===================== 基础设施（ES5） =====================

var doneCalled = false;

// doneArg 用于 rewrite 场景：必须把修改后的请求/响应交回 QX，
// 不能裸 $done()，否则原请求被吞掉。不传则裸 $done()（定时任务场景）。
function finish(sub, msg, doneArg) {
  if (doneCalled) return;
  doneCalled = true;
  var body = String(msg).slice(0, 500);
  try { $notify(TITLE, sub, body); } catch (e) { /* 通知失败不阻塞主流程 */ }
  try { console.log("[CCB] " + sub + " | " + body); } catch (e) {}
  try {
    if (typeof doneArg === "undefined") { $done(); } else { $done(doneArg); }
  } catch (e) {}
}

function log(msg) {
  try { console.log("[CCB] " + msg); } catch (e) {}
}

// 官方签名：$prefs.setValueForKey(value, key) —— value 在前，写反了是静默失败
function prefGet(key) {
  try { return $prefs.valueForKey(key); } catch (e) { return null; }
}
function prefSet(key, value) {
  try { $prefs.setValueForKey(String(value), key); return true; } catch (e) { return false; }
}

function dayKey() {
  var d = new Date();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
}

function ageText(ts) {
  if (!ts) return "未知";
  var ms = (new Date()).getTime() - ts;
  if (ms < 0) return "刚刚";
  var h = Math.floor(ms / 3600000);
  if (h < 1) return Math.floor(ms / 60000) + " 分钟";
  if (h < 48) return h + " 小时";
  return Math.floor(h / 24) + " 天";
}

// ===================== 入口分流 =====================

var isRewrite = false;
try {
  isRewrite = (typeof $request !== "undefined") && $request && !!$request.url;
} catch (e) { isRewrite = false; }

if (isRewrite) {
  capture();
} else {
  checkIn();
}

// ===================== 抓包模式 =====================

// rewrite 上下文里 $done 必须带参数，{} 表示「原样放行」。
// 裸 $done() 会让 QX 拿不到修改结果，App 那边表现为卡住。
var PASS_THROUGH = {};

function capture() {
  try {
    var url = String($request.url || "");
    var body = $request.body || "";
    var headers = filterHeaders($request.headers || {});

    if (url.indexOf("txCtrl") < 0) { $done(PASS_THROUGH); return; }
    if (!body) { $done(PASS_THROUGH); return; }

    var isLogin = url.indexOf("autoLogin") >= 0;
    var accountId = guessAccountId(body);

    var snapshot = {
      url: url,
      headers: headers,
      body: body,
      id: accountId,
      ts: (new Date()).getTime()
    };

    var key = isLogin ? KEY_LOGIN : KEY_SIGN;
    var list = loadList(key);

    // 同一 body 视为同一账号，覆盖；否则追加
    var found = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].body === body) { found = i; break; }
    }
    if (found >= 0) {
      list[found] = snapshot;
    } else {
      while (list.length >= MAX_ACCOUNTS) list.shift();
      list.push(snapshot);
    }

    prefSet(key, JSON.stringify(list));
    prefSet(KEY_TS, String(snapshot.ts));

    finish(
      "🎉 捕获成功",
      (isLogin ? "登录请求 (autoLogin)" : "签到请求") +
      "\n账号：" + (accountId || "未识别") +
      "\n已存 " + list.length + " 份" +
      "\n之后每天定时重放",
      PASS_THROUGH
    );
  } catch (e) {
    doneCalled = false; // 让异常分支能发出通知（上面可能已置位）
    finish("❌ 捕获出错", String(e && e.message || e), PASS_THROUGH);
  }
}

function filterHeaders(headers) {
  var out = {};
  for (var k in headers) {
    if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
    if (HOP_HEADERS.indexOf(k.toLowerCase()) >= 0) continue;
    out[k] = headers[k];
  }
  return out;
}

function guessAccountId(body) {
  try {
    var m = String(body).match(/"(mobileNo|phoneNo|mobile|mebId|userId|userNo|MEB_ID)"\s*:\s*"([^"]{4,})"/i);
    return m ? m[2] : "";
  } catch (e) { return ""; }
}

function loadList(key) {
  var raw = prefGet(key);
  if (!raw) return [];
  try {
    var arr = JSON.parse(raw);
    return Object.prototype.toString.call(arr) === "[object Array]" ? arr : [];
  } catch (e) { return []; }
}

// ===================== 签到模式 =====================

function checkIn() {
  var signList = loadList(KEY_SIGN);

  if (signList.length === 0) {
    finish("⚠️ 没有数据",
      "还没抓到签到请求。\n\n" +
      "做法：打开建行生活 App → 会员有礼 → 签到 → 手动点一次。\n" +
      "脚本会自动存下这条请求，之后就归它管了。");
    return;
  }

  // 当日幂等：今天成功过就不再打接口
  var today = dayKey();
  if (prefGet(KEY_LAST) === today) {
    finish("今天已签过", "日期：" + today + "\n跳过，避免重复请求触发风控。");
    return;
  }

  var ts = parseInt(prefGet(KEY_TS) || "0", 10);
  var age = ageText(ts);
  var stale = ts > 0 && ((new Date()).getTime() - ts) > (24 * 60 * 60 * 1000);
  if (stale) log("快照已 " + age + "，可能过期，仍尝试");

  var loginList = loadList(KEY_LOGIN);
  var loginSnap = loginList.length > 0 ? loginList[0] : null;
  var prefix = stale ? ("⚠️ 快照已 " + age + "，失败的话重新抓一次\n") : "";

  if (loginSnap) {
    replay(loginSnap, function (ok, text) {
      if (!ok) log("登录刷新失败：" + text);
      doAllSign(signList, prefix, ok ? "" : "（登录刷新失败：" + text + "）");
    });
  } else {
    doAllSign(signList, prefix, "");
  }
}

function doAllSign(signList, prefix, loginNote) {
  var idx = 0;
  var results = [];

  function next() {
    if (idx >= signList.length) {
      var okCount = 0;
      var lines = [];
      for (var j = 0; j < results.length; j++) {
        if (results[j].ok) okCount++;
        lines.push("【账号" + (j + 1) + (results[j].id ? " " + results[j].id : "") + "】" +
                   (results[j].ok ? "✅ " : "❌ ") + results[j].text);
      }

      if (okCount > 0) prefSet(KEY_LAST, dayKey());

      finish(
        okCount === results.length ? "全部成功" : (okCount + "/" + results.length + " 成功"),
        prefix + lines.join("\n") + (loginNote ? "\n" + loginNote : "")
      );
      return;
    }

    var snap = signList[idx];
    replay(snap, function (ok, text) {
      results.push({ ok: ok, text: text, id: snap.id || "" });
      idx++;
      next();
    });
  }

  next();
}

// 重放一条快照。QX 的 $task.fetch 硬超时 10 秒，opts 里没有 timeout
function replay(snap, cb) {
  var settled = false;
  var timer = setTimeout(function () {
    if (settled) return;
    settled = true;
    cb(false, "超时（QX 硬上限 10 秒）");
  }, 9500);

  try {
    $task.fetch({
      url: snap.url,
      method: "POST",
      headers: snap.headers,
      body: snap.body
    }).then(function (resp) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      var v = judge(resp.statusCode || resp.status || 0, resp.body || "");
      cb(v.ok, v.text);
    }, function (reason) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      var err = reason && (reason.error || reason.message) ? (reason.error || reason.message) : String(reason);
      cb(false, "网络请求失败：" + err);
    });
  } catch (e) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cb(false, "fetch 抛异常：" + String(e && e.message || e));
  }
}

// 判定：先用关键词（不绑接口字段），再退到 JSON 结构
function judge(status, raw) {
  var text = String(raw || "");

  // 1. 「已经签过」—— 业务上算成功
  if (/已签到|今日已签|重复签到|已经签到|签过/.test(text)) {
    return { ok: true, text: "今日已签到（无需重复）" };
  }

  // 2. 会话失效 —— 和网络失败分开报，因为处理方式完全不同
  if (status === 401 || status === 403) {
    return { ok: false, text: "会话失效 HTTP " + status + "，请在 App 里重新签一次刷新快照" };
  }
  if (/登录失效|未登录|会话过期|重新登录/i.test(text)) {
    return { ok: false, text: "会话失效：需重新抓包" };
  }

  // 3. 服务端错误
  if (status >= 500) return { ok: false, text: "服务端错误 HTTP " + status };
  if (status !== 200) {
    return { ok: false, text: "HTTP " + status + "：" + text.replace(/\s+/g, " ").slice(0, 100) };
  }

  if (!text) return { ok: false, text: "响应为空" };

  // 4. JSON 结构判断
  var j = null;
  try { j = JSON.parse(text); } catch (e) { j = null; }

  if (j === null) {
    return { ok: false, text: "非 JSON 响应：" + text.replace(/\s+/g, " ").slice(0, 100) };
  }

  var code = deepGet(j, ["rspCode", "retCode", "returnCode", "resultCode", "errCode", "errorCode", "code"]);
  var msg = deepGet(j, ["rspDesc", "retMsg", "returnMsg", "errMsg", "errorMsg", "message", "msg", "desc"]) || "";

  var okCodes = ["0", "000000", "0000", "00", "200", "success", "SUCCESS", "Success", "S"];
  var ok = code !== null && okCodes.indexOf(String(code)) >= 0;

  // 有些网关 code 是 0 但 success 字段明确是 false
  var succ = deepGet(j, ["success", "succeed", "isSuccess"]);
  if (succ === false || succ === "false") ok = false;

  var extra = [];
  var day = deepGet(j, ["signDay", "signDays", "continueDays", "totalDays", "days"]);
  if (day !== null) extra.push("连续" + day + "天");
  var prize = deepGet(j, ["prizeName", "awardName", "couponName", "giftName"]);
  if (prize !== null) extra.push("奖励:" + prize);

  var out = msg || (ok ? "成功" : "失败");
  if (code !== null) out += " [code=" + code + "]";
  if (extra.length) out += " " + extra.join(" ");
  if (!ok) out += "\n" + text.replace(/\s+/g, " ").slice(0, 100);

  return { ok: ok, text: out };
}

function deepGet(obj, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = findKey(obj, keys[i]);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function findKey(obj, key) {
  if (obj === null || typeof obj !== "object") return undefined;
  if (Object.prototype.toString.call(obj) === "[object Array]") {
    for (var i = 0; i < obj.length; i++) {
      var v = findKey(obj[i], key);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    var r = findKey(obj[k], key);
    if (r !== undefined) return r;
  }
  return undefined;
}
