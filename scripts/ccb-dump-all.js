/**
 * 建行 · 请求全量 dump（诊断用，抓完就关）
 *
 * 和 ccb-life-checkin.js 的抓包模式区别：
 *   checkin 只存 txCtrl 且 body 非空的请求，而且存完就等你用。
 *   这个 dump-all 什么都存，还会记同一个 txcode 出现几次、body 有没有变。
 *   目的是搞清楚两件事：
 *     1. MitM 到底通不通（存到东西就通）
 *     2. sign / timestamp 是不是每次都不一样（决定「快照重放」方案可不可行）
 *
 * ===================== 两个模式 =====================
 * rewrite 模式（你操作 App 时）：静默存进 $prefs，不弹通知，不打扰你。
 *   只在「第一次见到某个 txcode」时弹一条，让你知道抓到了新东西。
 *
 * task 模式（你手动触发或定时）：把存下来的全部导出来，分块发通知。
 *
 * ===================== QX 配置 =====================
 * [rewrite_local]
 * ^https?:\/\/(.+\.)?ccb\.com(\.cn)?\/ url script-request-body https://gcore.jsdelivr.net/gh/lhy-lq/qx-scripts@main/scripts/ccb-dump-all.js
 *
 * [task_local]
 * event-interaction https://gcore.jsdelivr.net/gh/lhy-lq/qx-scripts@main/scripts/ccb-dump-all.js, tag=建行dump, enabled=true
 *
 * [mitm]
 * hostname = *.ccb.com, ccb.com, *.ccb.com.cn, ccb.com.cn
 *
 * 注意 [mitm] 匹配的是 TLS SNI，所以写 *.ccb.com 能盖上所有子域。
 * 建行 App 可能还用别的域名（统计、CDN），那些也能抓到，会一起列出来。
 *
 * ===================== 用法 =====================
 * 1. 配好上面三段，确认证书已装且已信任
 * 2. 打开建行 App，随便逛：首页 → 会员有礼 → 签到页 → 我的 → 再回来
 *    （重点是把「签到」那个页面打开，让 App 发出查状态/签到相关请求）
 * 3. QX 首页 → 风车 → 事件 → 建行dump
 * 4. 会弹若干条通知，把它们全发我
 *
 * 想重新开始抓：QX → 设置 → 通用 → 清除全部本地存储（会清掉签到快照，
 * 但你现在还没快照，无所谓）。或者改下面的 DUMP_KEY 名字。
 */

// ===================== 配置 =====================

var DUMP_KEY = "CCB_DUMP_V1";
var MAX_RECORDS = 120;     // 最多存多少条，超了丢最老的（原 40，抓签到页容易滚掉关键请求）
var BODY_PREVIEW = 260;    // 每条 body 预览多少字符
var CHUNK = 620;           // 每条通知装多少字符

// 明显是噪音的请求，抓但标记出来（不参与 sign 对比）
var NOISE = ["\/log", "\/report", "\/track", "\/stat", ".png", ".jpg", ".css", ".js", "favicon"];

var TITLE = "建行Dump";

// ===================== 基础设施 =====================

var TITLE_SEEN = "CCB_DUMP_SEEN2";  // 已见过的 txcode 列表（避免通知刷屏）。v2 换过 key，升级后重弹一遍

function prefGet(k) {
  try { return $prefs.valueForKey(k); } catch (e) { return null; }
}
function prefSet(k, v) {
  try { $prefs.setValueForKey(String(v), k); return true; } catch (e) { return false; }
}
function log(s) {
  try { console.log("[CCB-DUMP] " + s); } catch (e) {}
}

function isNoise(url) {
  var u = String(url).toLowerCase();
  for (var i = 0; i < NOISE.length; i++) {
    if (u.indexOf(NOISE[i].toLowerCase()) >= 0) return true;
  }
  return false;
}

// 从 URL 里抠 txcode
function txcodeOf(url) {
  var m = String(url).match(/[?&]txcode=([^&#]+)/i);
  return m ? decodeURIComponent(m[1]) : "";
}

// 从 URL 取 host+path，去掉 query，方便看是哪个接口
function shortUrl(url) {
  var s = String(url).replace(/^https?:\/\//, "");
  var q = s.indexOf("?");
  return q >= 0 ? s.slice(0, q) : s;
}

// ===================== 入口分流 =====================

var isRewrite = (typeof $request !== "undefined") && $request && !!$request.url;

if (isRewrite) {
  onRequest();
} else {
  onDump();
}

// ===================== rewrite 模式：静默收集 =====================

function onRequest() {
  // rewrite 里必须带参数 $done，{} = 原样放行，否则请求被吞
  try {
    var url = String($request.url || "");
    var body = String($request.body || "");
    var method = String($request.method || "GET").toUpperCase();

    var list = loadList();
    var tx = txcodeOf(url);
    var noise = isNoise(url);

    var rec = {
      u: shortUrl(url),
      tx: tx,
      m: method,
      b: body,
      t: (new Date()).getTime(),
      n: noise ? 1 : 0
    };

    // sign / timestamp 这类字段单独拎出来，方便肉眼比对
    rec.sig = pickSig(body);

    list.push(rec);
    while (list.length > MAX_RECORDS) list.shift();
    prefSet(DUMP_KEY, JSON.stringify(list));

    // 只在见到新 txcode 时才弹通知，避免逛一圈弹 30 条
    if (!noise && tx) {
      var seen = loadSeen();
      if (seen.indexOf(tx) < 0) {
        seen.push(tx);
        while (seen.length > 60) seen.shift();
        prefSet(TITLE_SEEN, JSON.stringify(seen));

        // 短 body 直接把内容给出来 —— 光看字节数判断不出这是不是签到接口
        var peek = body.replace(/\s+/g, " ");
        if (peek.length > 150) peek = peek.slice(0, 150) + "…";

        try {
          $notify(TITLE, "新接口 " + tx + "  累计 " + list.length + " 条",
            shortUrl(url) + "\n" +
            "body " + body.length + " 字节" +
            (body ? "\n" + peek : "  (空)") +
            (rec.sig ? "\n签名: " + rec.sig : "")
          );
        } catch (e) {}
      }
    }
  } catch (e) {
    log("收集失败: " + (e && e.message || e));
  }
  $done({});
}

// 从 body 里挑出签名类字段（只看顶层，正则够了）
function pickSig(body) {
  if (!body) return "";
  var m = String(body).match(/"(sign|signature|signStr|token|timestamp|timeStamp|ts|nonce|reqTime)"\s*:\s*"([^"]{1,40})"/gi);
  if (!m) return "";
  var out = [];
  for (var i = 0; i < m.length && i < 4; i++) {
    out.push(m[i].replace(/\s+/g, ""));
  }
  return out.join(" ");
}

// ===================== task 模式：导出 =====================

var doneCalled = false;

// task 模式下的一次性收尾：弹一条通知，然后 $done()
function finish(sub, msg) {
  if (doneCalled) return;
  doneCalled = true;
  try { $notify(TITLE, sub, String(msg).slice(0, 900)); } catch (e) {}
  log(sub);
  try { $done(); } catch (e) {}
}

function onDump() {
  var list = loadList();

  if (list.length === 0) {
    finish("没有数据",
      "一条请求都没抓到。按顺序查：\n" +
      "1. MitM 证书装了吗？系统设置→通用→关于本机→证书信任设置→开关要打开\n" +
      "2. [mitm] 里有 *.ccb.com 吗？\n" +
      "3. rewrite 那行前面有没有留着 ; 或 #？\n" +
      "4. 抓包期间 App 有没有真的联网？（最好把 App 杀掉重开）\n" +
      "5. QX 隧道在跑吗？开关没开 rewrite 不生效");
    return;
  }

  // 统计 + 去重分析
  var lines = [];
  var byTx = {};
  var txOrder = [];

  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    var key = r.tx || (r.u + "|" + r.m);
    if (!byTx[key]) { byTx[key] = []; txOrder.push(key); }
    byTx[key].push(r);
  }

  lines.push("共 " + list.length + " 条，去重后 " + txOrder.length + " 个接口");
  lines.push("");

  for (var k = 0; k < txOrder.length; k++) {
    var key2 = txOrder[k];
    var arr = byTx[key2];
    var first = arr[0];

    lines.push("── " + (first.tx ? "txcode=" + first.tx : first.u) + "  ×" + arr.length +
               (first.n ? " [噪音]" : ""));

    if (arr.length >= 2) {
      // 同一个接口出现多次 —— 直接回答「sign 变不变」
      var a = arr[0], b = arr[arr.length - 1];
      var sigSame = (a.sig === b.sig);
      var bodySame = (a.b === b.b);
      lines.push("   两次对比: " + (bodySame ? "body 完全相同" :
                 (sigSame ? "签名相同、body 不同" : "签名也不同 ← 每次都变")));
    }

    if (first.sig) lines.push("   签名: " + first.sig);
    if (first.b) {
      var preview = first.b.replace(/\s+/g, " ").slice(0, BODY_PREVIEW);
      lines.push("   body: " + preview + (first.b.length > BODY_PREVIEW ? "…" : ""));
    } else {
      lines.push("   body: (空)");
    }
    lines.push("");
  }

  var text = lines.join("\n");
  flush(text);
}

// 按 CHUNK 切片发通知，QX 通知正文太长会被截断
function flush(text) {
  var parts = [];
  var rest = text;

  while (rest.length > 0) {
    if (rest.length <= CHUNK) { parts.push(rest); break; }
    var cut = rest.lastIndexOf("\n", CHUNK);
    if (cut < CHUNK / 2) cut = CHUNK;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut + 1);
  }

  for (var i = 0; i < parts.length; i++) {
    try {
      $notify(TITLE + " " + (i + 1) + "/" + parts.length, "请求清单", parts[i]);
    } catch (e) {}
  }

  log("导出 " + parts.length + " 段");
  try { $done(); } catch (e) {}
}

// ===================== 存储 =====================

function loadList() {
  var raw = prefGet(DUMP_KEY);
  if (!raw) return [];
  try {
    var a = JSON.parse(raw);
    return Object.prototype.toString.call(a) === "[object Array]" ? a : [];
  } catch (e) { return []; }
}

function loadSeen() {
  var raw = prefGet(TITLE_SEEN);
  if (!raw) return [];
  try {
    var a = JSON.parse(raw);
    return Object.prototype.toString.call(a) === "[object Array]" ? a : [];
  } catch (e) { return []; }
}
