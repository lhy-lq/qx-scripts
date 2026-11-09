#!/usr/bin/env node
/**
 * test-harness.js —— 在 Node 里模拟 Quantumult X 运行时，跑 checkin.js 做逻辑验证
 *
 * 这不是真机验证，只验证「脚本逻辑 + HTTP 流程 + 错误分支」是否正确。
 * QX 引擎特有的行为（$task.fetch 的 10 秒硬超时、opts 语义、并发上限）
 * 在这里**无法验证**，必须在 iPhone 上实测。
 *
 * 用法：
 *   node mock-server.js 8787 &          # 先起 mock 服务
 *   node test-harness.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");

const SCRIPT = path.join(__dirname, "checkin.js");
const BASE = process.env.BASE || "http://127.0.0.1:8787";

const code = fs.readFileSync(SCRIPT, "utf8");

/** ---------- QX 运行时模拟 ---------- */

function makePrefs(backing) {
    return {
        valueForKey: (k) => (Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : null),
        setValueForKey: (v, k) => { backing[k] = v; return true; },
        removeValueForKey: (k) => { delete backing[k]; return true; },
        removeAllValues: () => { for (const k of Object.keys(backing)) delete backing[k]; return true; }
    };
}

/** 用 Node http 实现 $task.fetch，语义尽量贴近 QX：
 *  - 10 秒硬超时
 *  - 返回 {statusCode, headers, body, bodyBytes}
 *  - 失败给 {error}
 */
function makeTaskFetch(timeoutMs) {
    return function taskFetch(req) {
        return new Promise((resolve, reject) => {
            let u;
            try { u = new URL(req.url); } catch (e) { reject({ error: "invalid url: " + req.url }); return; }

            const body = req.body === undefined || req.body === null ? null : String(req.body);
            const headers = Object.assign({}, req.headers || {});
            if (body !== null && headers["Content-Length"] === undefined) {
                headers["Content-Length"] = Buffer.byteLength(body);
            }

            const r = http.request({
                hostname: u.hostname,
                port: u.port,
                path: u.pathname + u.search,
                method: (req.method || "GET").toUpperCase(),
                headers: headers,
                timeout: timeoutMs
            }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const buf = Buffer.concat(chunks);
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: buf.toString("utf8"),
                        bodyBytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
                    });
                });
            });

            r.on("timeout", () => { r.destroy(); reject({ error: "timeout" }); });
            r.on("error", (e) => reject({ error: e.message }));
            if (body !== null) r.write(body);
            r.end();
        });
    };
}

function runScript({ args, prefsBacking, fetchTimeoutMs }) {
    const notifications = [];
    const logs = [];
    let doneCalled = 0;
    let pending = 0;
    const timers = [];

    const sandbox = {
        console: {
            log: (...a) => { logs.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); }
        },
        setTimeout: (fn, ms) => {
            const t = setTimeout(fn, ms);
            timers.push(t);
            return t;
        },
        $environment: { variables: args || {}, sourcePath: "checkin.js" },
        $prefs: makePrefs(prefsBacking),
        $notify: (title, subtitle, message) => notifications.push({ title, subtitle, message }),
        $task: { fetch: makeTaskFetch(fetchTimeoutMs || 10000) },
        $done: () => { doneCalled++; },
        Promise: Promise,
        JSON: JSON,
        Math: Math,
        Date: Date,
        String: String,
        Number: Number,
        Array: Array,
        Object: Object,
        parseInt: parseInt,
        parseFloat: parseFloat,
        isNaN: isNaN,
        Error: Error
    };
    sandbox.globalThis = sandbox;

    const ctx = vm.createContext(sandbox);
    try {
        vm.runInContext(code, ctx, { filename: "checkin.js", timeout: 20000 });
    } catch (e) {
        return Promise.resolve({
            ok: false, error: "script threw: " + (e && e.message ? e.message : String(e)),
            logs, notifications, doneCalled
        });
    }

    // 等脚本自己结束：$done 被调用，或 8 秒兜底
    return new Promise((resolve) => {
        const start = Date.now();
        const iv = setInterval(() => {
            if (doneCalled > 0 || Date.now() - start > 8000) {
                clearInterval(iv);
                timers.forEach(t => clearTimeout(t));
                resolve({ ok: doneCalled > 0, logs, notifications, doneCalled, prefs: prefsBacking });
            }
        }, 50);
    });
}

/** ---------- 测试用例 ---------- */

async function resetServer() {
    await new Promise((resolve) => {
        const u = new URL(BASE + "/api/__reset");
        const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST" }, (res) => {
            res.resume(); res.on("end", resolve);
        });
        r.on("error", resolve);
        r.end();
    });
}

function line(s) { return "\n" + "─".repeat(70) + "\n" + s + "\n" + "─".repeat(70); }

async function faultSet(name, on) {
    await new Promise((resolve) => {
        const u = new URL(BASE + "/api/__fault?" + name + "=" + (on ? "1" : "0"));
        const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET" }, (res) => {
            res.resume(); res.on("end", resolve);
        });
        r.on("error", resolve);
        r.end();
    });
}

async function main() {
    let pass = 0, fail = 0;
    function check(name, cond, extra) {
        if (cond) { pass++; console.log("  ✅ " + name); }
        else { fail++; console.log("  ❌ " + name + (extra ? "  → " + extra : "")); }
    }

    // ---------- 用例 1：正常签到 ----------
    console.log(line("用例 1：单账号正常签到"));
    await resetServer();
    let backing = {};
    let r = await runScript({ args: { accounts: "u1:p1", base: BASE, log: "1" }, prefsBacking: backing });
    r.logs.forEach(l => console.log("    " + l));
    r.notifications.forEach(n => console.log("    [通知] " + n.title + " | " + n.subtitle + " | " + n.message.replace(/\n/g, " / ")));
    check("调用了 $done", r.doneCalled === 1, "doneCalled=" + r.doneCalled);
    check("通知标题为「签到成功」", r.notifications[0] && r.notifications[0].title === "签到成功",
        r.notifications[0] && r.notifications[0].title);
    check("token 已持久化", !!(backing["qx_checkin_accounts"] && JSON.parse(backing["qx_checkin_accounts"])[0].token));
    check("lastRun 落盘", !!backing["qx_checkin_last_run"]);
    check("history 落盘且 1 条", JSON.parse(backing["qx_checkin_history"] || "[]").length === 1);

    // ---------- 用例 2：同日重复跑（幂等） ----------
    console.log(line("用例 2：同一天再跑一次（应跳过、不打接口）"));
    r = await runScript({ args: { accounts: "u1:p1", base: BASE, log: "1" }, prefsBacking: backing });
    r.logs.forEach(l => console.log("    " + l));
    const skipped = r.logs.some(l => l.includes("今天已经跑过了"));
    check("命中当日幂等，直接跳过", skipped);
    check("没有发通知", r.notifications.length === 0, "notifications=" + r.notifications.length);

    // ---------- 用例 3：force=1 强制重跑，服务端回 1001 已签到 ----------
    console.log(line("用例 3：force=1 强制重跑，服务端回「今日已签到」(code 1001)"));
    r = await runScript({ args: { accounts: "u1:p1", base: BASE, log: "1", force: "1" }, prefsBacking: backing });
    r.logs.forEach(l => console.log("    " + l));
    r.notifications.forEach(n => console.log("    [通知] " + n.title + " | " + n.subtitle + " | " + n.message.replace(/\n/g, " / ")));
    check("code 1001 被当作成功", r.notifications[0] && r.notifications[0].title === "签到成功",
        r.notifications[0] && r.notifications[0].title);
    check("通知里标注「今日已签到」", r.notifications[0] && r.notifications[0].message.includes("今日已签到"),
        r.notifications[0] && r.notifications[0].message);

    // ---------- 用例 4：多账号 ----------
    console.log(line("用例 4：多账号 u1 + u2"));
    await resetServer();
    backing = {};
    r = await runScript({ args: { accounts: "u1:p1|u2:p2", base: BASE, log: "1" }, prefsBacking: backing });
    r.logs.forEach(l => console.log("    " + l));
    r.notifications.forEach(n => console.log("    [通知] " + n.title + " | " + n.subtitle));
    check("通知副标题为 2 成功", r.notifications[0] && r.notifications[0].subtitle === "2 成功 / 0 失败",
        r.notifications[0] && r.notifications[0].subtitle);
    check("两个账号都拿到 token",
        (JSON.parse(backing["qx_checkin_accounts"] || "[]")).filter(a => a.token).length === 2);

    // ---------- 用例 5：服务端 500 + 重试 ----------
    console.log(line("用例 5：服务端 500，retry=1（应重试一次后失败）"));
    await resetServer();
    await faultSet("checkin500", true);
    backing = {};
    r = await runScript({ args: { accounts: "u1:p1", base: BASE, log: "1", retry: "1" }, prefsBacking: backing });
    r.logs.forEach(l => console.log("    " + l));
    r.notifications.forEach(n => console.log("    [通知] " + n.title + " | " + n.subtitle + " | " + n.message.replace(/\n/g, " / ")));
    const retried500 = r.logs.filter(l => l.includes("checkin:u1") && l.includes("try 2/2")).length > 0;
    check("checkin 发生重试（try 2/2）", retried500);
    check("通知为「签到失败」", r.notifications[0] && r.notifications[0].title === "签到失败",
        r.notifications[0] && r.notifications[0].title);
    check("失败原因含 HTTP 500", r.notifications[0] && /500/.test(r.notifications[0].message),
        r.notifications[0] && r.notifications[0].message);
    check("$done 仍被调用", r.doneCalled === 1);
    await faultSet("checkin500", false);

    console.log(line("用例 5b：无效 token → 自动重登 → 签到成功"));
    await resetServer();
    backing = {};
    // 塞一个无效 token
    backing["qx_checkin_accounts"] = JSON.stringify([{ name: "u1", pass: "p1", token: "tk_bad", tokenAt: 1 }]);
    r = await runScript({ args: { accounts: "u1:p1", base: BASE, log: "1" }, prefsBacking: backing });
    r.logs.forEach(l => console.log("    " + l));
    r.notifications.forEach(n => console.log("    [通知] " + n.title + " | " + n.subtitle));
    check("检测到 token 失效并重登", r.logs.some(l => l.includes("token 失效")));
    check("重登后签到成功", r.notifications[0] && r.notifications[0].title === "签到成功",
        r.notifications[0] && r.notifications[0].title);

    // ---------- 用例 6：无账号 ----------
    console.log(line("用例 6：没配账号（应提示、不打接口）"));
    backing = {};
    r = await runScript({ args: { base: BASE, log: "1" }, prefsBacking: backing });
    r.logs.forEach(l => console.log("    " + l));
    r.notifications.forEach(n => console.log("    [通知] " + n.title + " | " + n.subtitle + " | " + n.message));
    check("提示未配置账号", r.notifications[0] && r.notifications[0].subtitle === "未配置账号",
        r.notifications[0] && r.notifications[0].subtitle);
    check("仍然调用了 $done", r.doneCalled === 1);

    // ---------- 用例 7：base 指向不存在的端口（网络错误 + 重试） ----------
    console.log(line("用例 7：服务不可达（端口 1），验证网络错误与重试"));
    backing = {};
    r = await runScript({ args: { accounts: "u1:p1", base: "http://127.0.0.1:1", log: "1", retry: "1" }, prefsBacking: backing });
    r.logs.forEach(l => console.log("    " + l));
    r.notifications.forEach(n => console.log("    [通知] " + n.title + " | " + n.subtitle + " | " + n.message.replace(/\n/g, " / ")));
    const retried = r.logs.filter(l => l.includes("try 2/2")).length > 0;
    check("发生了重试（try 2/2）", retried);
    check("通知为「签到失败」", r.notifications[0] && r.notifications[0].title === "签到失败",
        r.notifications[0] && r.notifications[0].title);
    check("$done 仍被调用（不挂死）", r.doneCalled === 1);

    console.log(line("结果"));
    console.log("  通过 " + pass + " / 失败 " + fail);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error("harness error:", e); process.exit(2); });
