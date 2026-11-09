/**
 * probe.js —— Quantumult X 未文档化行为一次性探针
 *
 * 用途：把 docs/05-兼容性核实清单.md §5 里标 🔴 的 15 项中可以直接在
 *       event-interaction 里测掉的几项，一次跑完。
 *
 * 放到：Quantumult X/Scripts/probe.js
 *       或 iCloud Drive/Quantumult X/Scripts/probe.js
 *
 * 配置（[task_local] 区块）：
 *       event-interaction probe.js, tag=QX探针, enabled=true
 *
 * 触发：QX 首页 → 风车图标 → 事件 → 找到「QX探针」→ 点它
 *       （必须 QX 隧道在运行状态，否则 event 类任务不触发）
 *
 * 结果：全部走 $notify 弹出，共 3 条通知，不需要去翻日志页。
 *
 * 注意：本脚本不上传任何数据，只做本地能力探测。
 */

var out = [];
var TIPS = [];

function push(s) {
    out.push(s);
}

// ============ 探测 1：定时器家族到底有哪些 ============
// 官方 sample 里只出现过 setTimeout，从没提过 setInterval / clearTimeout
try {
    var t1 = setInterval(function () {}, 100);
    push("[1] setInterval: 存在, typeof=" + typeof t1);
    try {
        clearInterval(t1);
        push("[1b] clearInterval: 存在");
    } catch (e) {
        push("[1b] clearInterval: 不存在 (" + e.message + ")");
    }
} catch (e) {
    push("[1] setInterval: 不存在 (" + e.message + ")");
}

try {
    var t2 = setTimeout(function () {}, 10);
    clearTimeout(t2);
    push("[2] clearTimeout: 存在");
} catch (e) {
    push("[2] clearTimeout: 不存在 (" + e.message + ")");
}

// 这两个是 Node/浏览器专属，用来确认 QX 运行时到底多"干净"
push("[3] Buffer=" + (typeof Buffer) + " require=" + (typeof require) + " process=" + (typeof process));

// ============ 探测 4：$prefs 的类型契约 ============
// 官方只写了 setValueForKey(value, key)，没说 value 能不能是非字符串
try {
    var r1 = $prefs.setValueForKey("hello", "probe_str");
    var v1 = $prefs.valueForKey("probe_str");
    push("[4] prefs 存字符串: set 返回 " + typeof r1 + "(" + r1 + "); read " + typeof v1 + "(" + v1 + ")");
} catch (e) {
    push("[4] prefs 存字符串: 抛错 " + e.message);
}

try {
    var r2 = $prefs.setValueForKey({ a: 1, b: "x" }, "probe_obj");
    var v2 = $prefs.valueForKey("probe_obj");
    push("[5] prefs 存对象: set 返回 " + r2 + "; read " + typeof v2 + "(" + String(v2).slice(0, 50) + ")");
} catch (e) {
    push("[5] prefs 存对象: 抛错 " + e.message);
}

try {
    var r3 = $prefs.setValueForKey(12345, "probe_num");
    var v3 = $prefs.valueForKey("probe_num");
    push("[6] prefs 存数字: read " + typeof v3 + "(" + v3 + ")");
} catch (e) {
    push("[6] prefs 存数字: 抛错 " + e.message);
}

// 清理，不留垃圾
try {
    $prefs.removeValueForKey("probe_str");
    $prefs.removeValueForKey("probe_obj");
    $prefs.removeValueForKey("probe_num");
} catch (e) {}

// ============ 探测 7：$prefs 的 key 冲突行为 ============
// 空 key / 超长 key 会不会静默失败
try {
    var r4 = $prefs.setValueForKey("v", "");
    push("[7] prefs 空 key: set 返回 " + r4);
    $prefs.removeValueForKey("");
} catch (e) {
    push("[7] prefs 空 key: 抛错 " + e.message);
}

// ============ 探测 8：$environment 里到底有什么 ============
// 官方只文档了 variables / sourcePath / params 三个字段
try {
    var keys = [];
    for (var k in $environment) {
        keys.push(k + ":" + typeof $environment[k]);
    }
    push("[8] environment 字段: " + keys.join(", "));
} catch (e) {
    push("[8] environment: 抛错 " + e.message);
}

// ============ 探测 9：$task.fetch 在这个上下文里存不存在 ============
// 官方没说 task 类 API 在 event-interaction 里能不能用
// 注意：这里不能写 $task && $task.fetch —— 未声明的标识符直接引用会 ReferenceError，
//       只有 typeof 才对未声明安全，所以先 typeof 再取值。
var hasTask = (typeof $task !== "undefined") && $task && (typeof $task.fetch === "function");
push("[9] $task=" + (typeof $task) + " / $task.fetch 可用=" + hasTask);

// ============ 探测 10：$configuration 存在性 ============
var hasCfg = (typeof $configuration !== "undefined") && $configuration &&
             (typeof $configuration.sendMessage === "function");
push("[10] $configuration=" + (typeof $configuration) + " sendMessage 可用=" + hasCfg);

// ============ 先把同步结果发一条，再看异步结果 ============
function flushSync() {
    // 通知正文有长度限制，切 3 段发
    var chunks = [];
    var per = 5;
    for (var i = 0; i < out.length; i += per) {
        chunks.push(out.slice(i, i + per).join("\n"));
    }
    return chunks;
}

// ============ 探测 11/12：$configuration 的异步 action ============
// get_running_mode 和 get_traffic_statistics 的返回形态官方都没写清
function probeConfig() {
    return new Promise(function (resolve) {
        if (typeof $configuration === "undefined" || !$configuration.sendMessage) {
            out.push("[11] 无法测: $configuration 不可用");
            return resolve();
        }

        $configuration.sendMessage({ action: "get_running_mode" }).then(function (r) {
            out.push("[11] running_mode: error=" + JSON.stringify(r && r.error) +
                     " ret=" + JSON.stringify(r && r.ret));
            return $configuration.sendMessage({ action: "get_traffic_statistics" });
        }).then(function (r) {
            out.push("[12] traffic: error=" + JSON.stringify(r && r.error) +
                     " ret=" + JSON.stringify(r && r.ret));
            resolve();
        }).catch(function (e) {
            out.push("[11/12] 抛错: " + String(e && e.message ? e.message : e));
            resolve();
        });
    });
}

// ============ 主流程 ============
probeConfig().then(function () {
    var chunks = flushSync();
    for (var i = 0; i < chunks.length; i++) {
        $notify("QX探针 " + (i + 1) + "/" + chunks.length, out.length + " 项结果", chunks[i]);
    }
    $done();
}).catch(function (e) {
    $notify("QX探针", "异常中断", String(e && e.message ? e.message : e).slice(0, 300));
    $done();
});
