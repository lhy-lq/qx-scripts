/**
 * checkin.js —— Quantumult X 每日自动签到示例（多账号）
 *
 * 只对接「自建测试服务」（examples/checkin/mock-server.js），不含任何真实站点地址。
 * 换成你自己的服务时，只改文件底部 CFG 区块。
 *
 * @supported Quantumult X (v1.5.6 build 918) 及以上（用到 $environment.variables）
 *
 * 参数（写在 [task_local] 那一行的脚本 URL 后面 # 之后）：
 *   accounts=u1:p1|u2:p2    账号，| 分隔账号，: 分隔用户名和密码（二选一：也可写进脚本内 ACCOUNTS）
 *   base=http://127.0.0.1:8787
 *   log=1                   打详细日志
 *   force=1                 忽略「今天已跑过」的本地记录
 *   retry=2                 单个请求失败重试次数（默认 1）
 *
 * [task_local]
 * 5 8 * * * checkin.js#accounts=u1:p1|u2:p2&base=http://127.0.0.1:8787, tag=每日签到, enabled=true
 */

/* ==================== 通用工具（可复制到别的脚本） ==================== */

var ARGS = (typeof $environment !== "undefined" && $environment.variables) || {};

var DEBUG = String(ARGS["log"] || "") === "1";
function log() {
    if (!DEBUG) return;
    var a = [];
    for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
    console.log("[checkin] " + a.join(" "));
}

// $done 只允许生效一次
var _done = false;
function finish() {
    if (_done) return;
    _done = true;
    $done();
}

// 脚本总超时兜底：QX 引擎不会替你掐断，官方 sample-task.js 就是这么做的
function guard(ms, label) {
    setTimeout(function () {
        console.log("[checkin] guard fired: " + label + " after " + ms + "ms");
        $notify("签到", "超时退出", label + " 超过 " + Math.round(ms / 1000) + " 秒");
        finish();
    }, ms);
}

function safeParse(s) {
    if (s === undefined || s === null || s === "") return null;
    if (typeof s !== "string") return null;
    try {
        return JSON.parse(s);
    } catch (e) {
        return null;
    }
}

function hget(headers, name) {
    if (!headers) return undefined;
    var low = String(name).toLowerCase();
    for (var k in headers) {
        if (String(k).toLowerCase() === low) return headers[k];
    }
    return undefined;
}

function dayKey() {
    var d = new Date();
    var m = ("0" + (d.getMonth() + 1)).slice(-2);
    var dd = ("0" + d.getDate()).slice(-2);
    return d.getFullYear() + "-" + m + "-" + dd;
}

// 持久化：QX 是 value 在前
function load(key, fallback) {
    var raw = $prefs.valueForKey(key);
    var v = safeParse(raw);
    return (v === null || v === undefined) ? fallback : v;
}
function save(key, obj) {
    return $prefs.setValueForKey(JSON.stringify(obj), key);
}

/* ==================== 业务配置 ==================== */

var CFG = {
    // 默认指向本机自建测试服务；换成你自己的服务就改这里
    base: String(ARGS["base"] || "http://127.0.0.1:8787"),
    // 账号也可以硬编码在这里（[["u1","p1"],["u2","p2"]]），但更推荐走参数或 $prefs
    accounts: [],
    retry: Math.max(0, parseInt(ARGS["retry"] || "1", 10) || 0),
    // 单次请求最多等多久（QX 的 $task.fetch 硬超时是 10 秒，这里只做整体兜底判断）
    reqTimeoutWarn: 9500,
    guardMs: 60000,
    // 路由
    path: {
        login: "/api/login",
        checkin: "/api/checkin",
        profile: "/api/profile"
    }
};

var PREF = {
    accounts: "qx_checkin_accounts",   // [{name, pass, token, tokenAt}]
    lastRun: "qx_checkin_last_run",    // {day: "2026-11-08", ok: 2, fail: 0}
    history: "qx_checkin_history"      // 最近 30 条记录
};

/* ==================== 账号装载 ==================== */

function parseAccountsArg(s) {
    // "u1:p1|u2:p2" -> [[u1,p1],[u2,p2]]
    if (!s) return [];
    var out = [];
    var parts = String(s).split("|");
    for (var i = 0; i < parts.length; i++) {
        var one = parts[i].trim();
        if (!one) continue;
        var idx = one.indexOf(":");
        if (idx <= 0) continue;
        out.push([one.slice(0, idx).trim(), one.slice(idx + 1).trim()]);
    }
    return out;
}

function resolveAccounts() {
    // 优先级：配置行参数 > $prefs 里存过的 > CFG.accounts
    var fromArg = parseAccountsArg(ARGS["accounts"]);
    var stored = load(PREF.accounts, []);

    if (fromArg.length > 0) {
        // 参数给了账号：合并已有 token（按 name 匹配），避免每次重新登录
        var merged = [];
        for (var i = 0; i < fromArg.length; i++) {
            var name = fromArg[i][0];
            var pass = fromArg[i][1];
            var keep = null;
            for (var j = 0; j < stored.length; j++) {
                if (stored[j] && stored[j].name === name) { keep = stored[j]; break; }
            }
            merged.push({
                name: name,
                pass: pass,
                token: (keep && keep.pass === pass) ? (keep.token || "") : "",
                tokenAt: (keep && keep.pass === pass) ? (keep.tokenAt || 0) : 0
            });
        }
        save(PREF.accounts, merged);
        return merged;
    }

    if (stored && stored.length > 0) return stored;

    if (CFG.accounts && CFG.accounts.length > 0) {
        var init = [];
        for (var k = 0; k < CFG.accounts.length; k++) {
            init.push({ name: CFG.accounts[k][0], pass: CFG.accounts[k][1], token: "", tokenAt: 0 });
        }
        save(PREF.accounts, init);
        return init;
    }
    return [];
}

function persistToken(name, token) {
    var list = load(PREF.accounts, []);
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].name === name) {
            list[i].token = token;
            list[i].tokenAt = Math.floor(Date.now() / 1000);
            break;
        }
    }
    save(PREF.accounts, list);
}

/* ==================== HTTP 封装 ==================== */

/**
 * 发一个请求，返回 Promise<{status, headers, body, json}>。
 * 网络错误会按 CFG.retry 重试。
 */
function request(opts, tag) {
    var attempt = 0;
    var maxAttempt = CFG.retry + 1;

    function once() {
        attempt++;
        log("→ " + tag + " " + opts.method + " " + opts.url + " (try " + attempt + "/" + maxAttempt + ")");
        return $task.fetch({
            url: opts.url,
            method: opts.method || "GET",
            headers: opts.headers || {},
            body: opts.body,
            opts: {
                // 显式开 cookie jar：QX 在 build 934 之前忽略该字段（等效 true），之后默认 false。
                // 签到类脚本依赖会话，必须写死。
                "auto-cookie": true,
                // 不关证书校验。自建测试服务用 http，不需要它。
                "skip-cert-verify": false,
                "redirection": true
            }
        }).then(function (resp) {
            var json = safeParse(resp.body);
            var r = {
                status: resp.statusCode,
                headers: resp.headers,
                body: resp.body,
                json: json
            };
            log("← " + tag + " " + r.status + " body=" + String(resp.body).slice(0, 300));

            // 5xx 视为可重试
            if (r.status >= 500 && attempt < maxAttempt) {
                log("  " + tag + " 5xx，重试");
                return delay(600 * attempt).then(once);
            }
            return r;
        }, function (reason) {
            var msg = (reason && reason.error) ? reason.error : String(reason);
            log("✗ " + tag + " 网络错误: " + msg);
            if (attempt < maxAttempt) {
                return delay(600 * attempt).then(once);
            }
            return { status: 0, headers: {}, body: "", json: null, error: msg };
        });
    }

    return once();
}

function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* ==================== 业务动作 ==================== */

function login(acc) {
    var body = JSON.stringify({ user: acc.name, pass: acc.pass });
    return request({
        url: CFG.base + CFG.path.login,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body
    }, "login:" + acc.name).then(function (r) {
        if (r.status === 0) {
            return { ok: false, msg: "网络错误 " + (r.error || "unknown") };
        }
        if (r.status !== 200 || !r.json) {
            return { ok: false, msg: "登录失败 HTTP " + r.status };
        }
        if (r.json.code !== 0) {
            return { ok: false, msg: "登录失败 " + (r.json.msg || ("code=" + r.json.code)) };
        }
        var token = r.json.data && r.json.data.token;
        if (!token) return { ok: false, msg: "登录返回里没有 token" };
        acc.token = token;
        acc.tokenAt = Math.floor(Date.now() / 1000);
        persistToken(acc.name, token);
        return { ok: true, token: token };
    });
}

function ensureToken(acc) {
    if (acc.token) return Promise.resolve({ ok: true, token: acc.token });
    return login(acc);
}

function doCheckin(acc) {
    return request({
        url: CFG.base + CFG.path.checkin,
        method: "POST",
        headers: {
            "Authorization": "Bearer " + acc.token,
            "Content-Type": "application/json"
        },
        body: "{}"
    }, "checkin:" + acc.name);
}

function doProfile(acc) {
    return request({
        url: CFG.base + CFG.path.profile,
        method: "GET",
        headers: { "Authorization": "Bearer " + acc.token }
    }, "profile:" + acc.name);
}

function runOne(acc) {
    var res = {
        name: acc.name,
        ok: false,
        already: false,
        msg: "",
        points: null,
        totalDays: null
    };

    return ensureToken(acc).then(function (t) {
        if (!t.ok) {
            res.msg = t.msg;
            return null;
        }
        return doCheckin(acc).then(function (r) {
            // token 失效 → 重登一次再补签到
            if (r.status === 401) {
                log("  token 失效，重新登录");
                acc.token = "";
                return login(acc).then(function (t2) {
                    if (!t2.ok) { res.msg = "token 失效且重登失败"; return null; }
                    return doCheckin(acc);
                });
            }
            return r;
        });
    }).then(function (r) {
        if (r === null || r === undefined) return res;

        if (r.status === 0) {
            res.msg = "网络错误: " + (r.error || "unknown");
            return res;
        }
        if (!r.json) {
            res.msg = "响应不是 JSON (HTTP " + r.status + ")";
            return res;
        }

        var code = r.json.code;
        if (code === 0) {
            res.ok = true;
            res.points = r.json.data && r.json.data.points;
            res.totalDays = r.json.data && r.json.data.totalDays;
            res.msg = "签到成功";
        } else if (code === 1001) {
            // 已经签过：视为成功，但要标记出来
            res.ok = true;
            res.already = true;
            res.msg = "今日已签到";
        } else {
            res.msg = (r.json.msg || ("code=" + code));
            if (r.status !== 200) res.msg += " (HTTP " + r.status + ")";
        }
        return res;
    }).then(function (rr) {
        // 补充累计信息（失败不影响主结果）
        if (!rr.ok) return rr;
        return doProfile(acc).then(function (p) {
            if (p.status === 200 && p.json && p.json.code === 0 && p.json.data) {
                if (p.json.data.totalDays !== undefined) rr.totalDays = p.json.data.totalDays;
                if (p.json.data.points !== undefined) rr.points = p.json.data.points;
            }
            return rr;
        }, function () {
            return rr;
        });
    });
}

/* ==================== 主流程 ==================== */

function main() {
    var accounts = resolveAccounts();

    if (accounts.length === 0) {
        console.log("[checkin] 没有配置账号。请在 [task_local] 的脚本 URL 后加 #accounts=用户名:密码");
        $notify("签到", "未配置账号", "在脚本 URL 后加 #accounts=u1:p1|u2:p2");
        finish();
        return;
    }

    // 当天幂等：今天已经全部成功过就不再打接口（force=1 可跳过）
    var force = String(ARGS["force"] || "") === "1";
    var last = load(PREF.lastRun, null);
    if (!force && last && last.day === dayKey() && last.fail === 0) {
        console.log("[checkin] 今天已经跑过了（" + last.day + "），跳过。force=1 可强制重跑");
        finish();
        return;
    }

    guard(CFG.guardMs, "总流程");

    console.log("[checkin] 开始，账号数=" + accounts.length + "，base=" + CFG.base);

    var tasks = [];
    for (var i = 0; i < accounts.length; i++) {
        // 串行更稳：QX 的并发上限官方没写，账号多时并发容易互相拖死
        tasks.push(accounts[i]);
    }

    var results = [];

    function next(idx) {
        if (idx >= tasks.length) return Promise.resolve();
        return runOne(tasks[idx]).then(function (r) {
            results.push(r);
            return next(idx + 1);
        });
    }

    next(0).then(function () {
        var okCount = 0;
        var failCount = 0;
        var lines = [];
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            if (r.ok) okCount++; else failCount++;
            var line = r.name + "：" + r.msg;
            if (r.ok && r.totalDays !== null && r.totalDays !== undefined) {
                line += "（累计 " + r.totalDays + " 天";
                if (r.points !== null && r.points !== undefined) line += " / " + r.points + " 分";
                line += "）";
            }
            lines.push(line);
        }

        var title = (failCount === 0) ? "签到成功" : (okCount === 0 ? "签到失败" : "部分成功");
        var subtitle = okCount + " 成功 / " + failCount + " 失败";
        var message = lines.join("\n");

        console.log("[checkin] 结果: " + subtitle);
        console.log("[checkin] " + message);

        // 通知正文别太长，iOS 会截断
        $notify(title, subtitle, message.slice(0, 500));

        // 落盘
        save(PREF.lastRun, { day: dayKey(), ok: okCount, fail: failCount, at: Math.floor(Date.now() / 1000) });
        var hist = load(PREF.history, []);
        hist.push({ day: dayKey(), ok: okCount, fail: failCount, detail: lines });
        while (hist.length > 30) hist.shift();
        save(PREF.history, hist);

        finish();
    }, function (e) {
        console.log("[checkin] 主流程异常: " + (e && e.message ? e.message : String(e)));
        $notify("签到", "异常", String(e && e.message ? e.message : e).slice(0, 300));
        finish();
    });
}

main();
