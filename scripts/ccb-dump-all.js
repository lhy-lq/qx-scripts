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
 *
 * ===================== 实战记录 2026-11-10 =====================
 * 已确认：
 *   · MitM 通了。真实接口域名是 xc.ccblife.ccb.com，不是 yunbusiness.ccb.com。
 *   · 已抓到的一条：xc.ccblife.ccb.com/p1ccbl/service/common-service/txCtrl
 *     body 仅 11 字节 —— 通用网关的公共调用，不是签到那一条。
 *
 * 两个必须知道的坑：
 *   坑1 镜像缓存。gcore.jsdelivr.net 实测会返回几分钟前的旧文件（我这边拿到
 *       8990 字节旧版，实际已是 9382 字节新版），所以你手机上可能一直跑旧代码。
 *       改用 fastly.jsdelivr.net 或 testingcf.jsdelivr.net；最稳是把 @main 换成
 *       具体 commit 短 hash，那是不变的。
 * ===================== v4 变更（2026-11-10 晚） =====================
 * 之前只认 txcode：没有 txcode 的接口（例如 /xxx/checkin、/xxx/getUserInfo）
 * 抓到了却一条通知都不弹，看起来就像「什么都没抓到」。v4 修掉了：
 *   · 新增 keyOf(url, method, tx)：有 txcode 用 txcode，没有就用「方法 + host/path」。
 *   · 通知条件从 `if (!noise && tx)` 改成 `if (!noise)`，无 txcode 也弹。
 *   · 用 $request.body === undefined 判断当前是 script-request-header 模式，
 *     通知里会写「header 模式（这个类型不提供 body）」，导出时条目带 [header模式]。
 *   · TITLE_SEEN 换成 CCB_DUMP_SEEN3，升级后所有接口会重新弹一遍。

 *   坑2 空 body 不触发。官方 sample.conf 原话：
 *       "The body related rewrite will not be executed if the body is empty."
 *       script-request-body 只对「有 body 的请求」生效，纯 GET 根本抓不到。
 *       要看全部接口：先把类型临时换成 script-request-header 抓一轮（只有 URL），
 *       再换回 script-request-body 抓一轮（拿 body）。分两轮。
 */

// ===================== 配置 =====================

var DUMP_KEY = "CCB_DUMP_V1";
var MAX_RECORDS = 120;     // 最多存多少条，超了丢最老的（原 40，抓签到页容易滚掉关键请求）
var BODY_PREVIEW = 260;    // 每条 body 预览多少字符
var CHUNK = 620;           // 每条通知装多少字符
var HEADER_CAP = 700;      // 一条请求最多记多少字符的 header
var HEADER_VAL = 150;      // 单个 header 值超过这么长就截断

// 明显是噪音的请求，抓但标记出来（不参与 sign 对比）
var NOISE = ["\/log", "\/report", "\/track", "\/stat", ".png", ".jpg", ".css", ".js", "favicon"];

var TITLE = "建行Dump";

// ===================== 基础设施 =====================

var TITLE_SEEN = "CCB_DUMP_SEEN4";  // 已见过的 txcode 列表（避免通知刷屏）。v2 换过 key，升级后重弹一遍

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

// 一个接口的稳定标识。有 txcode 用 txcode；没有就用「方法 + host/path」。
// 关键：以前只认 txcode，导致没有 txcode 的接口（例如 /xxx/checkin）一条通知都不弹，
// 明明抓到了却看不见 —— 这是「好像什么都抓不到」最常见的假象。
function keyOf(url, method, tx) {
  return tx ? tx : (String(method || "?") + " " + shortUrl(url));
}

// 请求头里最可能藏签名/会话的几个关键词。
// header 模式下拿不到 body，所以 headers 是唯一线索 —— 网关的鉴权信息
// （cookie / token / sign / tranCode）基本都在这里。
// 只放「可能藏签名/会话」的头。UA / Content-Type / Referer 这类每台设备都一样，
// 不参与排序，否则关键项会被它们挤到后面。
var WANT_HEADERS = [
  "cookie", "authorization", "token", "sign", "signature", "timestamp",
  "nonce", "txcode", "trancode", "transcode", "session", "auth"
];

// $request.headers 的 key 大小写不固定，不能用 headers["Cookie"] 直接取。
function pickHeaders(headers) {
  if (!headers) return "";
  var want = [], other = [], i, k, v, lk, isWant;
  for (k in headers) {
    if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
    v = headers[k];
    if (v === undefined || v === null) continue;
    v = String(v).replace(/\s+/g, " ");
    if (v.length > HEADER_VAL) v = v.slice(0, HEADER_VAL) + "…";
    lk = k.toLowerCase();
    isWant = false;
    for (i = 0; i < WANT_HEADERS.length; i++) {
      if (lk.indexOf(WANT_HEADERS[i]) >= 0) { isWant = true; break; }
    }
    (isWant ? want : other).push(k + ": " + v);
  }
  var out = want.concat(other).join(" | ");
  if (out.length > HEADER_CAP) out = out.slice(0, HEADER_CAP) + "…";
  return out;
}

// URL 上的 query。TXCtrl 这类网关把 txcode 放在 query 里，别丢了
function queryOf(url) {
  var t = String(url), q = t.indexOf("?");
  if (q < 0) return "";
  var qs = t.slice(q + 1);
  return qs.length > 300 ? qs.slice(0, 300) + "…" : qs;
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
    // $request.body 在 script-request-header 模式下是 undefined；
    // 在 script-request-body 模式下即使没内容也是空字符串。用这个区分两种模式。
    var rawBody = $request.body;
    var headerMode = (rawBody === undefined || rawBody === null);
    var body = headerMode ? "" : String(rawBody);
    var method = String($request.method || "GET").toUpperCase();

    var list = loadList();
    var tx = txcodeOf(url);
    var noise = isNoise(url);
    // header 模式拿不到 body，那 headers 就是唯一线索，必须记
    var hs = pickHeaders($request.headers);

    var rec = {
      u: shortUrl(url),
      qs: queryOf(url),
      tx: tx,
      m: method,
      b: body,
      hs: hs,
      hd: headerMode ? 1 : 0,
      t: (new Date()).getTime(),
      n: noise ? 1 : 0
    };

    // sign / timestamp 这类字段单独拎出来，方便肉眼比对。
    // body 是 JSON、headers 是 k: v，两种格式一起扫。
    rec.sig = pickSig(body, hs);

    list.push(rec);
    while (list.length > MAX_RECORDS) list.shift();
    prefSet(DUMP_KEY, JSON.stringify(list));

    // 每个「新接口」弹一条通知。判定用 keyOf()，没有 txcode 的接口同样会弹。
    var k = keyOf(url, method, tx);
    if (!noise) {
      var seen = loadSeen();
      if (seen.indexOf(k) < 0) {
        seen.push(k);
        while (seen.length > 80) seen.shift();
        prefSet(TITLE_SEEN, JSON.stringify(seen));

        // 光看字节数判断不出这是不是要的那个接口，直接把内容给出来
        var peek = body.replace(/\s+/g, " ");
        if (peek.length > 150) peek = peek.slice(0, 150) + "…";
        var peekHs = hs.length > 220 ? hs.slice(0, 220) + "…" : hs;

        try {
          $notify(TITLE, "新接口 " + k + "  累计 " + list.length + " 条",
            "[" + method + "] " + shortUrl(url) + "\n" +
            (headerMode
               ? "header 模式（本类型没有 body）"
               : "body " + body.length + " 字节" + (body ? "\n" + peek : "  (空)")) +
            (peekHs ? "\n头部: " + peekHs : "") +
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
function pickSig(body, headers) {
  var out = [];
  var i, m, seg, one;

  // body 是 JSON：找 "sign":"xxx" 这种
  if (body) {
    m = String(body).match(/"(sign|signature|signStr|token|timestamp|timeStamp|ts|nonce|reqTime)"\s*:\s*"([^"]{1,60})"/gi);
    if (m) {
      for (i = 0; i < m.length && out.length < 4; i++) {
        out.push(m[i].replace(/\s+/g, ""));
      }
    }
  }

  // headers 是 "k: v | k: v"：找 key 里带 sign/token/tranCode 的
  if (headers && out.length < 6) {
    seg = String(headers).split("|");
    for (i = 0; i < seg.length && out.length < 6; i++) {
      one = seg[i].replace(/^\s+|\s+$/g, "");
      if (/^(sign|signature|signstr|token|authorization|timestamp|nonce|trancode|transcode)/i.test(one)) {
        out.push(one);
      }
    }
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
    var key = r.tx || (r.m + " " + r.u);
    if (!byTx[key]) { byTx[key] = []; txOrder.push(key); }
    byTx[key].push(r);
  }

  lines.push("共 " + list.length + " 条，去重后 " + txOrder.length + " 个接口");
  lines.push("");

  for (var k = 0; k < txOrder.length; k++) {
    var key2 = txOrder[k];
    var arr = byTx[key2];
    var first = arr[0];

    lines.push("── " + key2 + "  ×" + arr.length +
               (first.n ? " [噪音]" : "") +
               (first.hd ? " [header模式]" : ""));

    if (arr.length >= 2) {
      // 同一个接口出现多次 —— 直接回答「sign 变不变」
      var a = arr[0], b = arr[arr.length - 1];
      var sigSame = (a.sig === b.sig);
      var bodySame = (a.b === b.b);
      lines.push("   两次对比: " + (bodySame ? "body 完全相同" :
                 (sigSame ? "签名相同、body 不同" : "签名也不同 ← 每次都变")));
    }

    if (first.qs) lines.push("   query: " + first.qs);
    if (first.hs) {
      var hsPrev = first.hs.length > BODY_PREVIEW ? first.hs.slice(0, BODY_PREVIEW) + "…" : first.hs;
      lines.push("   头部: " + hsPrev);
    }
    if (first.sig) lines.push("   签名: " + first.sig);
    if (first.b) {
      var preview = first.b.replace(/\s+/g, " ").slice(0, BODY_PREVIEW);
      lines.push("   body: " + preview + (first.b.length > BODY_PREVIEW ? "…" : ""));
    } else if (first.hd) {
      // header 模式下 body 是这个类型「不给」，不是真的空 —— 别让人误会
      lines.push("   body: 这个类型不提供（第二轮换 script-request-body 再看）");
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
