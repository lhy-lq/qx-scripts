/**
 * 把本目录推送到 GitHub —— 走 Contents API，不走 git push
 *
 * 为什么不用 git push：
 *   本机上 github.com:443 连不上（curl 返回 000），
 *   但 api.github.com 通（200）。git push 走的是 github.com，所以必然失败。
 *   Contents API 走 api.github.com，能通。
 *
 * 用法：
 *   1. 到 https://github.com/settings/tokens 建一个 token
 *      勾 repo（classic）或给 Contents: Read and write（fine-grained）
 *   2. 把 token 存到本文件同目录的 .token 里（只有一行，不要换行符以外的空格）
 *      或者设环境变量 GITHUB_TOKEN
 *   3. node tools/push-to-github.js            # 默认推 lhy-lq/qx-scripts
 *      node tools/push-to-github.js --dry      # 只看要传什么，不真传
 *
 * 幂等：已存在的文件会带上 sha 覆盖，不会报冲突。
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const OWNER = "lhy-lq";
const REPO = "qx-scripts";
const BRANCH = "main";
const ROOT = path.join(__dirname, "..");

const SKIP_DIRS = new Set([".git", "node_modules", "_ref"]);
const SKIP_FILES = new Set([".token", ".DS_Store", "Thumbs.db"]);

// ============ 参数 ============

const args = process.argv.slice(2);
const DRY = args.indexOf("--dry") >= 0;

// ============ token ============

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const p = path.join(__dirname, ".token");
  if (fs.existsSync(p)) {
    return fs.readFileSync(p, "utf8").trim();
  }
  return "";
}

const TOKEN = readToken();

// ============ HTTP ============

function api(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;

    const req = https.request({
      hostname: "api.github.com",
      path: endpoint,
      method: method,
      headers: Object.assign(
        {
          "User-Agent": "qx-scripts-pusher",
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        TOKEN ? { Authorization: "Bearer " + TOKEN } : {},
        payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}
      )
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = { raw: data }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(new Error("请求超时 30s")); });

    if (payload) req.write(payload);
    req.end();
  });
}

// ============ 收集文件 ============

function walk(dir, base, out) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const it of items) {
    const full = path.join(dir, it.name);
    const rel = base ? base + "/" + it.name : it.name;

    if (it.isDirectory()) {
      if (SKIP_DIRS.has(it.name)) continue;
      walk(full, rel, out);
    } else if (it.isFile()) {
      if (SKIP_FILES.has(it.name)) continue;
      out.push({ rel, full, size: fs.statSync(full).size });
    }
  }
  return out;
}

function isText(full) {
  const buf = fs.readFileSync(full);
  // 简单判定：前 8KB 里有没有 NUL
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

// ============ 主流程 ============

(async () => {
  const files = walk(ROOT, "", []);

  console.log(`仓库：${OWNER}/${REPO}（分支 ${BRANCH}）`);
  console.log(`文件：${files.length} 个，共 ${(files.reduce((s, f) => s + f.size, 0) / 1024).toFixed(0)} KB\n`);

  if (DRY) {
    for (const f of files) console.log(`  ${String(f.size).padStart(7)}  ${f.rel}`);
    console.log("\n--dry 模式，没有真的发请求。");
    return;
  }

  if (!TOKEN) {
    console.error("没有 token。");
    console.error("  方式一：把 PAT 写到 " + path.join(__dirname, ".token"));
    console.error("  方式二：set GITHUB_TOKEN=xxx 再跑");
    process.exit(2);
  }

  // 1. 验 token
  const me = await api("GET", "/user");
  if (me.status !== 200) {
    console.error(`token 无效（HTTP ${me.status}）：${me.body && me.body.message || ""}`);
    process.exit(1);
  }
  console.log(`token 属于：${me.body.login}`);

  if (me.body.login !== OWNER) {
    console.error(`token 属于 ${me.body.login}，但目标仓库是 ${OWNER}/${REPO}。`);
    console.error("要么换 token，要么改脚本顶部的 OWNER。");
    process.exit(1);
  }

  // 2. 确保仓库存在
  const repoCheck = await api("GET", `/repos/${OWNER}/${REPO}`);
  if (repoCheck.status === 404) {
    console.log(`仓库不存在，创建中…`);
    const created = await api("POST", "/user/repos", {
      name: REPO,
      description: "Quantumult X 脚本：建行生活签到 + QX 探针 + 开发手册",
      private: false,
      has_issues: true,
      has_wiki: false
    });
    if (created.status !== 201) {
      console.error(`创建失败（HTTP ${created.status}）：`, JSON.stringify(created.body).slice(0, 400));
      process.exit(1);
    }
    console.log(`已创建：${created.body.html_url}`);
    await new Promise(r => setTimeout(r, 1500)); // 等仓库初始化
  } else if (repoCheck.status === 200) {
    console.log(`仓库已存在：${repoCheck.body.html_url}`);
  } else {
    console.error(`查仓库失败（HTTP ${repoCheck.status}）`);
    process.exit(1);
  }

  // 3. 逐个上传
  let ok = 0, skip = 0, fail = 0;

  for (const f of files) {
    const content = fs.readFileSync(f.full);
    const text = isText(f.full);

    // 已有的文件要先拿 sha，否则 422
    let sha = null;
    const head = await api("GET", `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(f.rel).replace(/%2F/g, "/")}?ref=${BRANCH}`);
    if (head.status === 200 && head.body && head.body.sha) sha = head.body.sha;

    const putBody = {
      message: (sha ? "update " : "add ") + f.rel,
      content: content.toString("base64"),
      branch: BRANCH
    };
    if (sha) putBody.sha = sha;

    const res = await api("PUT", `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(f.rel).replace(/%2F/g, "/")}`, putBody);

    if (res.status === 200 || res.status === 201) {
      console.log(`  ${sha ? "改" : "增"}  ${f.rel}`);
      ok++;
    } else {
      console.log(`  失败 ${f.rel}  HTTP ${res.status}  ${res.body && res.body.message || ""}`);
      fail++;
    }

    // 顺序太快可能撞二级限流，稍微歇一下
    await new Promise(r => setTimeout(r, 350));
  }

  console.log(`\n完成：成功 ${ok}，失败 ${fail}`);
  console.log(`地址：https://github.com/${OWNER}/${REPO}`);

  if (fail > 0) process.exit(1);
})();
