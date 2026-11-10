/**
 * ccb-dump-all.js 的离线测试
 * node tools/ccb-dump-test.js
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");

const SCRIPT = path.join(__dirname, "..", "scripts", "ccb-dump-all.js");

function makeCtx(seed) {
  const store = Object.assign(Object.create(null), seed || {});
  const notifies = [];
  const logs = [];
  const ctx = {
    console: { log: (m) => logs.push(String(m)), error: () => {}, warn: () => {} },
    setTimeout, clearTimeout, Promise, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error, parseInt,
    $prefs: {
      valueForKey: (k) => (k in store ? store[k] : null),
      setValueForKey: (v, k) => { store[k] = String(v); },
      removeValueForKey: (k) => { delete store[k]; },
      removeAllValues: () => { for (const k in store) delete store[k]; }
    },
    $notify: (t, s, m) => notifies.push({ t, s, m }),
    $done: () => {}
  };
  return { ctx, store, notifies, logs };
}

function run(opts) {
  const { ctx, store, notifies, logs } = makeCtx(opts.seed);
  if (opts.request) ctx.$request = opts.request;
  ctx.globalThis = ctx;

  let doneCount = 0;
  ctx.$done = () => { doneCount++; };

  vm.createContext(ctx);
  try {
    vm.runInContext(fs.readFileSync(SCRIPT, "utf8"), ctx, { timeout: 10000 });
  } catch (e) {
    return { err: e.message, notifies, store, logs, doneCount };
  }
  return { notifies, store, logs, doneCount };
}

// ============ 用例 ============

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
}

// --- 1. rewrite：抓到一条 txCtrl ---
{
  const r = run({
    request: {
      url: "https://yunbusiness.ccb.com/clp_coupon/txCtrl?txcode=A3341A038",
      method: "POST",
      body: '{"mebId":"MB001","sign":"abc123","timestamp":"1700000000"}',
      headers: { "Content-Type": "application/json" }
    }
  });
  const stored = r.store["CCB_DUMP_V1"];
  const arr = stored ? JSON.parse(stored) : [];
  check("rewrite 存下 1 条", arr.length === 1, JSON.stringify(arr));
  check("rewrite 记录 txcode", arr[0] && arr[0].tx === "A3341A038", arr[0] && arr[0].tx);
  check("rewrite 提取签名", arr[0] && arr[0].sig && arr[0].sig.indexOf("sign") >= 0, arr[0] && arr[0].sig);
  check("rewrite 首次弹新接口通知", r.notifies.length === 1, r.notifies.length);
  check("rewrite done 调用 1 次", r.doneCount === 1, r.doneCount);
}

// --- 2. 同一 txcode 第二次：不再弹通知 ---
{
  const first = run({
    request: { url: "https://yunbusiness.ccb.com/a/txCtrl?txcode=TX1", method: "POST", body: '{"s":"1"}' }
  });
  const second = run({
    seed: first.store,
    request: { url: "https://yunbusiness.ccb.com/a/txCtrl?txcode=TX1", method: "POST", body: '{"s":"2"}' }
  });
  const arr = JSON.parse(second.store["CCB_DUMP_V1"]);
  check("同 txcode 第二次不弹通知", second.notifies.length === 0, second.notifies.length);
  check("同 txcode 仍记录到 2 条", arr.length === 2, arr.length);
}

// --- 3. 噪音请求：记录但不弹通知 ---
{
  const r = run({
    request: { url: "https://log.ccb.com/api/log/report.png", method: "GET", body: "" }
  });
  const arr = JSON.parse(r.store["CCB_DUMP_V1"]);
  check("噪音也记录", arr.length === 1, arr.length);
  check("噪音标记 n=1", arr[0] && arr[0].n === 1, arr[0] && arr[0].n);
  check("噪音不弹通知", r.notifies.length === 0, r.notifies.length);
}

// --- 4. 空 body 的 GET 也记录 ---
{
  const r = run({
    request: { url: "https://yunbusiness.ccb.com/x/txCtrl?txcode=Q1", method: "GET", body: "" }
  });
  const arr = JSON.parse(r.store["CCB_DUMP_V1"]);
  check("空 body GET 也存", arr.length === 1, arr.length);
  check("空 body 记为空串", arr[0] && arr[0].b === "", arr[0] && arr[0].b);
}

// --- 5. 超过 MAX_RECORDS 丢最老的 ---
{
  let seed = {};
  for (let i = 0; i < 125; i++) {
    const r = run({ seed, request: { url: "https://yunbusiness.ccb.com/a/txCtrl?txcode=T" + i, method: "POST", body: '{"i":' + i + '}' } });
    seed = r.store;
  }
  const arr = JSON.parse(seed["CCB_DUMP_V1"]);
  check("上限 120 条生效", arr.length === 120, arr.length);
  check("丢的是最老的", arr[0].tx === "T5", arr[0].tx);
  check("保留的是最新的", arr[arr.length - 1].tx === "T124", arr[arr.length - 1].tx);
}

// --- 5b. 首见通知里要能看到短 body 的实际内容 ---
{
  const r = run({
    request: {
      url: "https://xc.ccblife.ccb.com/p1ccbl/service/common-service/txCtrl?txcode=SIGN001",
      method: "POST",
      body: '{"txcode":"SIGN001"}'
    }
  });
  check("首见弹 1 条", r.notifies.length === 1, r.notifies.length);
  const m = r.notifies[0] ? r.notifies[0].m : "";
  check("通知带 body 内容", m.indexOf("SIGN001") >= 0, m.slice(0, 80));
  check("通知带累计条数", /累计 1 条/.test(r.notifies[0] ? r.notifies[0].s : ""), r.notifies[0] && r.notifies[0].s);
}

// --- 5c. 长 body 截到 150 字符 ---
{
  const big = "A".repeat(400);
  const r = run({
    request: { url: "https://a.ccb.com/x/txCtrl?txcode=BIG1", method: "POST", body: big }
  });
  const m = r.notifies[0] ? r.notifies[0].m : "";
  check("长 body 被截断带省略号", m.indexOf("…") >= 0, m.slice(-40));
  check("通知整体不过长", m.length < 400, m.length);
}

// --- 6. task 模式：无数据时的提示 ---
{
  const r = run({ seed: {} });
  check("无数据弹 1 条", r.notifies.length === 1, r.notifies.length);
  check("无数据提示含排错步骤", r.notifies[0] && r.notifies[0].m.indexOf("证书") >= 0, r.notifies[0] && r.notifies[0].m.slice(0, 40));
}

// --- 7. task 模式：同接口两次，签名不同 → 报告「每次都变」 ---
{
  const seed = {
    CCB_DUMP_V1: JSON.stringify([
      { u: "yunbusiness.ccb.com/a/txCtrl", tx: "TX1", m: "POST", b: '{"sign":"aaa"}', t: 1, n: 0, sig: '"sign":"aaa"' },
      { u: "yunbusiness.ccb.com/a/txCtrl", tx: "TX1", m: "POST", b: '{"sign":"bbb"}', t: 2, n: 0, sig: '"sign":"bbb"' }
    ])
  };
  const r = run({ seed });
  const all = r.notifies.map(n => n.m).join("\n");
  check("报告签名每次都变", all.indexOf("每次都变") >= 0, all.slice(0, 120));
  check("task 模式 done 1 次", r.doneCount === 1, r.doneCount);
}

// --- 8. task 模式：同接口两次 body 完全相同 ---
{
  const seed = {
    CCB_DUMP_V1: JSON.stringify([
      { u: "yunbusiness.ccb.com/a/txCtrl", tx: "TX1", m: "POST", b: '{"x":1}', t: 1, n: 0, sig: "" },
      { u: "yunbusiness.ccb.com/a/txCtrl", tx: "TX1", m: "POST", b: '{"x":1}', t: 2, n: 0, sig: "" }
    ])
  };
  const r = run({ seed });
  const all = r.notifies.map(n => n.m).join("\n");
  check("报告 body 完全相同", all.indexOf("body 完全相同") >= 0, all.slice(0, 120));
}

// --- 9. 长内容分块 ---
{
  const many = [];
  for (let i = 0; i < 30; i++) {
    many.push({ u: "yunbusiness.ccb.com/tx/txCtrl", tx: "T" + i, m: "POST", b: '{"a":"' + "x".repeat(200) + '"}', t: i, n: 0, sig: "" });
  }
  const r = run({ seed: { CCB_DUMP_V1: JSON.stringify(many) } });
  check("长内容切成多条通知", r.notifies.length > 1, r.notifies.length);
  const oversized = r.notifies.filter(n => n.m.length > 650);
  check("每条不超过 650 字符", oversized.length === 0, oversized.map(n => n.m.length));
  check("分块标题带 i/N", /\d+\/\d+/.test(r.notifies[0].t), r.notifies[0].t);
}

// --- 10. 各条 done 都只调一次 ---
{
  const r = run({ request: { url: "https://a.ccb.com/x/txCtrl?txcode=Z", method: "POST", body: "{}" } });
  check("rewrite done 恰好 1 次", r.doneCount === 1, r.doneCount);
}

// --- 11. 没有 txcode 的接口也要弹通知（这是以前「什么都抓不到」的主因）---
{
  const r = run({
    request: {
      url: "https://xc.ccblife.ccb.com/p1ccbl/service/checkin/do",
      method: "POST",
      body: '{"activityId":"SIGN"}'
    }
  });
  check("无 txcode 也弹通知", r.notifies.length === 1, r.notifies.length);
  check("无 txcode 通知标题带方法+路径",
    r.notifies[0] && r.notifies[0].s.indexOf("POST xc.ccblife.ccb.com/p1ccbl/service/checkin/do") >= 0,
    r.notifies[0] && r.notifies[0].s);
  check("无 txcode 也记录到库里", (r.store.CCB_DUMP_V1 || "").indexOf("checkin/do") >= 0,
    r.store.CCB_DUMP_V1);
}

// --- 11b. 同一无 txcode 接口第二次不重复弹 ---
{
  const seed = {};
  const req = { url: "https://xc.ccblife.ccb.com/p1ccbl/service/checkin/do", method: "POST", body: "{}" };
  const r1 = run({ request: req });
  const r2 = run({ request: req, seed: r1.store });
  check("无 txcode 首次弹 1 条", r1.notifies.length === 1, r1.notifies.length);
  check("无 txcode 第二次不弹", r2.notifies.length === 0, r2.notifies.length);
  check("无 txcode 第二次仍记录", (r2.store.CCB_DUMP_V1 || "").split("checkin/do").length - 1 === 2,
    r2.store.CCB_DUMP_V1);
}

// --- 12. header 模式：$request.body 为 undefined 时不报错、标记 hd=1 ---
{
  const r = run({
    request: {
      url: "https://xc.ccblife.ccb.com/p1ccbl/service/getUserInfo",
      method: "GET"
      // 故意不给 body 字段，模拟 script-request-header
    }
  });
  check("header 模式不抛错", !r.err, r.err);
  check("header 模式也弹通知", r.notifies.length === 1, r.notifies.length);
  check("header 模式通知里写明不提供 body",
    r.notifies[0] && r.notifies[0].m.indexOf("header 模式") >= 0,
    r.notifies[0] && r.notifies[0].m);
  const arr = JSON.parse(r.store.CCB_DUMP_V1 || "[]");
  check("header 模式记录 hd=1", arr[0] && arr[0].hd === 1, arr[0] && arr[0].hd);
  check("header 模式 done 调用 1 次", r.doneCount === 1, r.doneCount);
}

// --- 13. body 模式：给了空串 body 时 hd=0 ---
{
  const r = run({
    request: { url: "https://xc.ccblife.ccb.com/p1ccbl/service/x", method: "POST", body: "" }
  });
  const arr = JSON.parse(r.store.CCB_DUMP_V1 || "[]");
  check("body 模式 hd=0", arr[0] && arr[0].hd === 0, arr[0] && arr[0].hd);
}

// --- 14. task 模式导出：header 模式条目带 [header模式] 标记 ---
{
  const seed = {
    CCB_DUMP_V1: JSON.stringify([
      { u: "xc.ccblife.ccb.com/p1ccbl/service/a", tx: "", m: "GET", b: "", hd: 1, t: 1, n: 0 },
      { u: "xc.ccblife.ccb.com/p1ccbl/service/b", tx: "T1", m: "POST", b: "{}", hd: 0, t: 2, n: 0 }
    ])
  };
  const r = run({ seed });
  const all = r.notifies.map(x => x.m).join("\n");
  check("导出含 header模式 标记", all.indexOf("[header模式]") >= 0, all.slice(0, 200));
  check("导出含 GET 无 txcode 接口", all.indexOf("GET xc.ccblife.ccb.com/p1ccbl/service/a") >= 0, all.slice(0, 200));
  check("导出含 txcode 接口", all.indexOf("T1") >= 0, all.slice(0, 200));
}

// --- 15. header 模式：headers 必须被记下来（签名常藏在 header 里）---
{
  const r = run({
    request: {
      url: "https://dvfp.ftss.ccb.com/CCDSG/TransactionRoute_1?txcode=CCB001",
      method: "POST",
      headers: {
        "Cookie": "SESSION=abc123; token=zzz",
        "tranCode": "A3341A038",
        "X-Sign": "deadbeef",
        "User-Agent": "ccb/6.0.0",
        "Content-Type": "application/json"
      }
      // 故意不给 body 字段 = script-request-header 模式
    }
  });
  const arr = JSON.parse(r.store.CCB_DUMP_V1 || "[]");
  const rec = arr[0] || {};
  check("header 模式 hd=1", rec.hd === 1, rec.hd);
  check("header 模式记录了 headers", !!(rec.hs && rec.hs.length > 10), rec.hs);
  check("headers 含 Cookie", String(rec.hs || "").indexOf("Cookie") >= 0, rec.hs);
  check("headers 含 tranCode", String(rec.hs || "").toLowerCase().indexOf("trancode") >= 0, rec.hs);
  check("记录了 query", String(rec.qs || "").indexOf("txcode=CCB001") >= 0, rec.qs);
}

// --- 16. header 模式：通知正文必须带「头部:」且不能是空的 ---
{
  const r = run({
    request: {
      url: "https://dvfp.ftss.ccb.com/CCDSG/TransactionRoute_1",
      method: "POST",
      headers: { "Cookie": "SID=xyz", "token": "tk-999" }
    }
  });
  check("header 模式弹通知", r.notifies.length === 1, r.notifies.length);
  const body = (r.notifies[0] || {}).m || "";
  check("通知含 头部:", body.indexOf("头部:") >= 0, body);
  check("通知含 Cookie 值", body.indexOf("SID=xyz") >= 0, body);
  check("通知含 header 模式说明", body.indexOf("header 模式") >= 0, body);
  check("通知不含 body 字节", body.indexOf("字节") < 0, body);
}

// --- 17. 头部关键值排前面（Cookie 应当在 User-Agent 之前）---
{
  const r = run({
    request: {
      url: "https://dvfp.ftss.ccb.com/x",
      method: "POST",
      headers: { "User-Agent": "ua-1", "Accept-Language": "zh", "Authorization": "Bearer abc" }
    }
  });
  const arr = JSON.parse(r.store.CCB_DUMP_V1 || "[]");
  const hs = String((arr[0] || {}).hs || "");
  check("Authorization 排在 User-Agent 前",
    hs.indexOf("Authorization") >= 0 && hs.indexOf("Authorization") < hs.indexOf("User-Agent"), hs);
}

// --- 18. 单个 header 超长要截断（不许把通知撑爆）---
{
  const big = "x".repeat(2000);
  const r = run({
    request: { url: "https://dvfp.ftss.ccb.com/y", method: "POST", headers: { "Cookie": big } }
  });
  const arr = JSON.parse(r.store.CCB_DUMP_V1 || "[]");
  const hs = String((arr[0] || {}).hs || "");
  check("超长 header 被截断", hs.length <= 720, hs.length);
}

// --- 19. 导出时能看到 query 与头部 ---
{
  const seed = {
    CCB_DUMP_V1: JSON.stringify([{
      u: "dvfp.ftss.ccb.com/CCDSG/TransactionRoute_1",
      qs: "txcode=CCB001&v=2",
      tx: "CCB001", m: "POST", b: "",
      hs: "Cookie: SID=xyz | tranCode: A3341A038",
      hd: 1, t: 1, n: 0
    }])
  };
  const r = run({ seed });
  const all = r.notifies.map(x => x.m).join("\n");
  check("导出含 query 行", all.indexOf("query: txcode=CCB001") >= 0, all.slice(0, 400));
  check("导出含 头部 行", all.indexOf("头部: Cookie: SID=xyz") >= 0, all.slice(0, 400));
}

// --- 20. header 模式导出不写「body: (空)」---
{
  const seed = {
    CCB_DUMP_V1: JSON.stringify([{
      u: "dvfp.ftss.ccb.com/CCDSG/TransactionRoute_1", qs: "txcode=A1",
      tx: "A1", m: "POST", b: "", hs: "Cookie: S=1", hd: 1, t: 1, n: 0
    }])
  };
  const r = run({ seed });
  const all = r.notifies.map(x => x.m).join("\n");
  check("header 模式导出不写 body 空", all.indexOf("body: (空)") < 0, all.slice(0, 300));
  check("header 模式导出说明不提供 body", all.indexOf("这个类型不提供") >= 0, all.slice(0, 300));
}

// ============ 输出 ============

let pass = 0, fail = 0;
console.log("=".repeat(72));
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
  if (!r.pass) {
    console.log("      实际: " + String(JSON.stringify(r.detail) || "").slice(0, 300));
    fail++;
  } else pass++;
}
console.log("=".repeat(72));
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${results.length}`);
process.exit(fail === 0 ? 0 : 1);
