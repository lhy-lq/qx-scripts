/**
 * 建行生活 · 请求抓取器（第一阶段：只抓，不改）
 *
 * 用途：把 App 发出的真实请求（URL / 方法 / 全部请求头 / 请求体）原样 dump 出来，
 *       供之后写签到脚本时填参数。本脚本不修改任何内容，$done({}) 原样放行。
 *
 * 类型：script-request-body（必须是 body 型，否则拿不到 $request.body）
 *
 * 官方依据：
 *   sample.conf:291-297  —— 脚本可用对象
 *   sample.conf:298      —— 脚本存放位置
 *   sample-rewrite-request-header.js @supported v1.0.5-build188
 *   sample-rewrite-with-script.js  —— body 型脚本的 $done 用法
 *
 * ⚠ 待实测：$done({}) 在 script-request-body 里是否严格等于「不修改」。
 *   若发现请求被吃掉了（App 报错/无响应），改用 $done($request)。
 */

var TAG = "[CCB抓包]";
// 每块通知最多多少字符。iOS 通知正文过长会被截断，700 是安全值。
var CHUNK = 700;

// ============ 收集 ============

var out = [];
function push(line) { out.push(line); }

function tryGet(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

var url = tryGet(function () { return $request.url; }, "<无 url>");
var method = tryGet(function () { return $request.method; }, "<无 method>");

push("URL: " + url);
push("METHOD: " + method);

// 请求头：拿全，包括 Cookie / Authorization / 各类 sign 头
var headers = tryGet(function () { return $request.headers; }, null);
if (headers) {
  var names = Object.keys(headers).sort();
  push("--- 请求头 (" + names.length + ") ---");
  for (var i = 0; i < names.length; i++) {
    push(names[i] + ": " + headers[names[i]]);
  }
} else {
  push("--- 请求头: 读取失败 ---");
}

// 请求体
var body = tryGet(function () { return $request.body; }, null);
if (typeof body === "string" && body.length > 0) {
  push("--- 请求体 (" + body.length + " 字符) ---");
  push(body);
} else if (body === undefined || body === null) {
  push("--- 请求体: 无（GET 或空 body） ---");
} else {
  push("--- 请求体: 类型 " + (typeof body) + "，已忽略 ---");
}

// ============ 输出 ============

var text = out.join("\n");

// 备份到持久化存储，key 固定，方便「读回」任务取
tryGet(function () {
  $prefs.setValueForKey(text, "ccb_capture_req");
}, null);

// 分块弹通知
var total = Math.ceil(text.length / CHUNK);
var n = 0;
for (var off = 0; off < text.length; off += CHUNK) {
  n++;
  var piece = text.slice(off, off + CHUNK);
  // 通知正文上限保守处理：超长时退化为 console.log
  tryGet(function () {
    $notify("CCB请求 " + n + "/" + total, method + " " + url.slice(0, 60), piece);
  }, null);
  tryGet(function () { console.log(TAG + "[" + n + "/" + total + "]\n" + piece); }, null);
}

// 原样放行。见文件头「待实测」说明。
$done({});
