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
  for (let i = 0; i < 45; i++) {
    const r = run({ seed, request: { url: "https://yunbusiness.ccb.com/a/txCtrl?txcode=T" + i, method: "POST", body: '{"i":' + i + '}' } });
    seed = r.store;
  }
  const arr = JSON.parse(seed["CCB_DUMP_V1"]);
  check("上限 40 条生效", arr.length === 40, arr.length);
  check("丢的是最老的", arr[0].tx === "T5", arr[0].tx);
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
