/**
 * 建行生活签到 v3 · 离线测试台
 *
 * 用 Node vm 造 QX 语义沙箱，跑 scripts/ccb-life-checkin.js，
 * 验证抓包模式、重放模式、判定逻辑、当日幂等、超时兜底。
 *
 * 跑法：node tools/ccb-life-test-harness.js
 * 依赖：无（只用 Node 内置模块）
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");

const SCRIPT = path.join(__dirname, "..", "scripts", "ccb-life-checkin.js");

// ============ 假接口：模拟建行 txCtrl 网关的几种返回 ============

let scenario = "success";
let hits = [];

function fakeFetch(opts) {
  hits.push({ url: opts.url, method: opts.method });

  if (scenario === "timeout") return new Promise(() => {}); // 永远不 resolve

  return new Promise((resolve) => {
    setTimeout(() => {
      const u = opts.url || "";
      const isLogin = u.indexOf("autoLogin") >= 0;

      if (scenario === "authfail") {
        resolve({ statusCode: 401, headers: {}, body: '{"rspCode":"4010","rspDesc":"登录失效，请重新登录"}' });
      } else if (scenario === "server500") {
        resolve({ statusCode: 500, headers: {}, body: "Internal Server Error" });
      } else if (scenario === "badjson") {
        resolve({ statusCode: 200, headers: {}, body: "<html>gateway error</html>" });
      } else if (scenario === "already") {
        resolve({ statusCode: 200, headers: {}, body: '{"rspCode":"0","rspDesc":"今日已签到"}' });
      } else if (scenario === "codefail") {
        resolve({ statusCode: 200, headers: {}, body: '{"rspCode":"999999","rspDesc":"活动已结束"}' });
      } else if (scenario === "successFalse") {
        resolve({ statusCode: 200, headers: {}, body: '{"rspCode":"0","success":false,"rspDesc":"未满足条件"}' });
      } else if (isLogin) {
        resolve({ statusCode: 200, headers: {}, body: '{"rspCode":"0","rspDesc":"login ok"}' });
      } else {
        resolve({ statusCode: 200, headers: {}, body: '{"rspCode":"0","rspDesc":"签到成功","signDays":"7","prizeName":"10积分"}' });
      }
    }, 5);
  });
}

// ============ 沙箱：按 QX 语义实现 ============

function makeSandbox(extraGlobals, storeSeed) {
  const logs = [];
  const notifies = [];
  const store = Object.assign(Object.create(null), storeSeed || {});

  const sandbox = {
    console: { log: (...a) => logs.push(a.join(" ")), error: () => {}, warn: () => {} },
    setTimeout: (fn, ms) => global.setTimeout(fn, ms),
    clearTimeout: (t) => global.clearTimeout(t),
    Promise, JSON, Date, Math, Object, Array, String, Number, Boolean,
    RegExp, Error, parseInt, isNaN,

    // 官方签名：setValueForKey(value, key)
    $prefs: {
      valueForKey: (k) => (k in store ? store[k] : null),
      setValueForKey: (v, k) => { store[k] = String(v); },
      removeValueForKey: (k) => { delete store[k]; },
      removeAllValues: () => { for (const k in store) delete store[k]; }
    },

    $notify: (title, subtitle, message) => notifies.push({ title, subtitle, message }),
    $task: { fetch: fakeFetch },
    $done: () => {}
  };

  if (extraGlobals) Object.assign(sandbox, extraGlobals);
  sandbox.globalThis = sandbox;
  return { sandbox, logs, notifies, store };
}

function run(name, opts) {
  scenario = opts.scenario || "success";
  hits = [];

  const ctx = makeSandbox(opts.globals, opts.seed);

  return new Promise((resolveOut) => {
    let myDone = 0;
    let settled = false;

    ctx.sandbox.$done = () => {
      myDone++;
      if (myDone === 1 && !settled) {
        settled = true;
        global.setTimeout(() => {
          const all = ctx.notifies.map(n => `${n.title}|${n.subtitle}|${n.message}`).join("\n");
          const hit = opts.expect === null || all.indexOf(opts.expect) >= 0;
          resolveOut({ name, pass: myDone === 1 && hit, all, doneCalls: myDone, hits: hits.length });
        }, 100);
      }
    };

    vm.createContext(ctx.sandbox);

    try {
      vm.runInContext(fs.readFileSync(SCRIPT, "utf8"), ctx.sandbox, { timeout: 30000 });
    } catch (e) {
      if (!settled) {
        settled = true;
        resolveOut({ name, pass: false, all: "抛异常: " + e.message, doneCalls: myDone, hits: hits.length });
      }
    }

    // 保险：15 秒还没出结果就判失败（沙箱内 guard 应该更早触发）
    global.setTimeout(() => {
      if (settled) return;
      settled = true;
      const all = ctx.notifies.map(n => `${n.title}|${n.subtitle}|${n.message}`).join("\n");
      resolveOut({ name, pass: false, all: "沙箱超时未 done\n" + all, doneCalls: myDone, hits: hits.length });
    }, 15000);
  });
}

// ============ 构造快照 ============

function signSnap(id) {
  return JSON.stringify([{
    url: "https://yunbusiness.ccb.com/clp_coupon/txCtrl?txcode=A3341A038",
    headers: { "Content-Type": "application/json", "Cookie": "SESSION=abc" },
    body: '{"mebId":"' + (id || "MB001") + '"}',
    id: id || "MB001",
    ts: Date.now()
  }]);
}

const loginSnap = JSON.stringify([{
  url: "https://yunbusiness.ccb.com/clp_service/txCtrl?txcode=autoLogin",
  headers: { "Content-Type": "application/json" },
  body: '{"mobileNo":"13800000000"}',
  id: "13800000000",
  ts: Date.now()
}]);

function todayStr() {
  const d = new Date();
  const m = d.getMonth() + 1;
  const dd = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (dd < 10 ? "0" + dd : dd);
}

// ============ 用例 ============

(async () => {
  const R = [];

  // ---- 抓包模式 ----
  R.push(await run("抓包：存入签到快照", {
    globals: { $request: { url: "https://yunbusiness.ccb.com/clp_coupon/txCtrl?txcode=A3341A038", body: '{"mebId":"MB001"}', headers: { "Content-Type": "application/json", "Host": "yunbusiness.ccb.com" } } },
    expect: "捕获成功"
  }));

  R.push(await run("抓包：非 txCtrl 忽略", {
    globals: { $request: { url: "https://yunbusiness.ccb.com/other/api", body: '{"a":1}', headers: {} } },
    expect: null
  }));

  R.push(await run("抓包：空 body 忽略", {
    globals: { $request: { url: "https://yunbusiness.ccb.com/x/txCtrl?txcode=1", body: "", headers: {} } },
    expect: null
  }));

  // ---- 签到模式 ----
  R.push(await run("无快照时提示去抓包", { seed: {}, expect: "没有数据" }));

  R.push(await run("正常签到成功", { seed: { CCB_LIFE_SIGN_REQ: signSnap() }, expect: "✅" }));

  R.push(await run("今日已签到算成功", { seed: { CCB_LIFE_SIGN_REQ: signSnap() }, expect: "已签到", scenario: "already" }));

  R.push(await run("401 提示重新抓包", { seed: { CCB_LIFE_SIGN_REQ: signSnap() }, expect: "会话失效", scenario: "authfail" }));

  R.push(await run("500 报服务端错误", { seed: { CCB_LIFE_SIGN_REQ: signSnap() }, expect: "服务端错误", scenario: "server500" }));

  R.push(await run("非 JSON 响应", { seed: { CCB_LIFE_SIGN_REQ: signSnap() }, expect: "非 JSON", scenario: "badjson" }));

  R.push(await run("业务码失败", { seed: { CCB_LIFE_SIGN_REQ: signSnap() }, expect: "活动已结束", scenario: "codefail" }));

  R.push(await run("code=0 但 success=false 判失败", { seed: { CCB_LIFE_SIGN_REQ: signSnap() }, expect: "未满足条件", scenario: "successFalse" }));

  R.push(await run("当日幂等：成功过就跳过", {
    seed: { CCB_LIFE_SIGN_REQ: signSnap(), CCB_LIFE_LAST_OK: todayStr() },
    expect: "今天已签过"
  }));

  R.push(await run("有登录快照则先刷新", {
    seed: { CCB_LIFE_SIGN_REQ: signSnap(), CCB_LIFE_LOGIN_REQ: loginSnap },
    expect: "✅"
  }));

  R.push(await run("超时会兜底", {
    seed: { CCB_LIFE_SIGN_REQ: signSnap(), CCB_LIFE_CAPTURE_TS: String(Date.now()) },
    expect: "超时", scenario: "timeout"
  }));

  // ---- 输出 ----
  let pass = 0, fail = 0;
  console.log("=".repeat(72));
  for (const r of R) {
    const mark = r.pass ? "PASS" : "FAIL";
    console.log(`${mark}  ${r.name}   (done=${r.doneCalls}, 请求=${r.hits})`);
    if (!r.pass) {
      console.log("      实际输出:");
      console.log("      " + String(r.all).split("\n").join("\n      "));
    }
    r.pass ? pass++ : fail++;
  }
  console.log("=".repeat(72));
  console.log(`通过 ${pass} / 失败 ${fail} / 共 ${R.length}`);
  process.exit(fail === 0 ? 0 : 1);
})();
