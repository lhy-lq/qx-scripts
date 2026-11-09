#!/usr/bin/env node
/**
 * 自建测试服务 —— 仅用于本地验证 checkin.js，不连任何真实站点。
 *
 * 启动：
 *   node mock-server.js            # 监听 127.0.0.1:8787
 *   node mock-server.js 9000       # 换端口
 *
 * 接口（全部为自造，无任何真实服务对应）：
 *   POST /api/login          body: {"user":"u1","pass":"p1"}
 *                            -> {"code":0,"data":{"token":"tk_u1_...","expiresIn":86400}}
 *   POST /api/checkin        header: Authorization: Bearer <token>
 *                            -> {"code":0,"data":{"points":10,"totalDays":7,"nickname":"u1"}}
 *                            重复调用 -> {"code":1001,"msg":"already checked in today"}
 *                            ?fail=1  -> HTTP 500 {"code":5000,"msg":"internal error"}（用于测重试）
 *   GET  /api/profile        header: Authorization: Bearer <token>
 *                            -> {"code":0,"data":{"nickname":"u1","totalDays":7,"points":70}}
 *   GET  /api/__state        调试用，返回当前所有用户状态
 *   POST /api/__reset        清空状态（每次测试前调一次更干净）
 */

const http = require("http");

const PORT = parseInt(process.argv[2] || "8787", 10);
const HOST = "127.0.0.1";

/** userId -> {nickname, totalDays, points, lastCheckinDay, token} */
const state = Object.create(null);

/** 全局故障开关：打开后 /api/checkin 一律回 500，用于测重试分支 */
const fault = { checkin500: false };

function dayKey() {
  const d = new Date();
  const m = ("0" + (d.getMonth() + 1)).slice(-2);
  const dd = ("0" + d.getDate()).slice(-2);
  return d.getFullYear() + "-" + m + "-" + dd;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Mock-Server": "qx-checkin-test/1.0"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 1e6) req.destroy();
    });
    req.on("end", () => resolve(buf));
    req.on("error", () => resolve(""));
  });
}

function tokenOf(req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : "";
}

function userByToken(token) {
  if (!token) return null;
  for (const uid of Object.keys(state)) {
    if (state[uid].token === token) return { uid: uid, rec: state[uid] };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://" + HOST + ":" + PORT);
  const path = u.pathname;
  const q = u.searchParams;

  console.log("[mock] " + req.method + " " + req.url);

  // ---- 自建接口开始 ----

  if (path === "/api/login" && req.method === "POST") {
    const raw = await readBody(req);
    let p = null;
    try {
      p = JSON.parse(raw);
    } catch (e) {
      return send(res, 400, { code: 4000, msg: "bad json" });
    }
    if (!p || !p.user) return send(res, 400, { code: 4001, msg: "user required" });

    const uid = String(p.user);
    if (!state[uid]) {
      state[uid] = { nickname: uid, totalDays: 0, points: 0, lastCheckinDay: "", token: "" };
    }
    state[uid].token = "tk_" + uid + "_" + Math.random().toString(36).slice(2, 10);
    return send(res, 200, { code: 0, data: { token: state[uid].token, expiresIn: 86400 } });
  }

  if (path === "/api/checkin" && req.method === "POST") {
    const hit = userByToken(tokenOf(req));
    if (!hit) return send(res, 401, { code: 4010, msg: "invalid token" });

    if (q.get("fail") === "1" || fault.checkin500) {
      return send(res, 500, { code: 5000, msg: "internal error" });
    }
    if (hit.rec.lastCheckinDay === dayKey()) {
      return send(res, 200, { code: 1001, msg: "already checked in today" });
    }
    hit.rec.lastCheckinDay = dayKey();
    hit.rec.totalDays += 1;
    hit.rec.points += 10;
    return send(res, 200, {
      code: 0,
      data: { points: 10, totalDays: hit.rec.totalDays, nickname: hit.rec.nickname }
    });
  }

  if (path === "/api/profile" && req.method === "GET") {
    const hit = userByToken(tokenOf(req));
    if (!hit) return send(res, 401, { code: 4010, msg: "invalid token" });
    return send(res, 200, {
      code: 0,
      data: { nickname: hit.rec.nickname, totalDays: hit.rec.totalDays, points: hit.rec.points }
    });
  }

  // ---- 自建接口结束 ----

  if (path === "/api/__state") {
    return send(res, 200, { code: 0, data: state });
  }
  if (path === "/api/__fault" ) {
    // GET  /api/__fault?checkin500=1   打开
    // GET  /api/__fault?checkin500=0   关闭
    fault.checkin500 = q.get("checkin500") === "1";
    return send(res, 200, { code: 0, data: fault });
  }
  if (path === "/api/__reset" && req.method === "POST") {
    for (const k of Object.keys(state)) delete state[k];
    fault.checkin500 = false;
    return send(res, 200, { code: 0, msg: "reset" });
  }

  send(res, 404, { code: 4040, msg: "not found: " + path });
});

server.listen(PORT, HOST, () => {
  console.log("mock server  http://" + HOST + ":" + PORT);
  console.log("  POST /api/login    {\"user\":\"u1\",\"pass\":\"p1\"}");
  console.log("  POST /api/checkin  (Authorization: Bearer <token>)  ?fail=1 造 500");
  console.log("  GET  /api/profile");
  console.log("  GET  /api/__state    POST /api/__reset");
});
