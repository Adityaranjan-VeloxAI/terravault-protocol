// Terravault local app server.
//
//   npm run app    ->  http://localhost:3000
//
// Serves the consumer web app and runs the protocol's off-chain services (the
// guardian price keeper and the AI risk monitor) as child processes. A small
// presenter API stages demo scenarios by writing the keeper's control file.
// The web app itself reads the chain directly, so it also works as a static
// deploy; the presenter controls only appear when this server is running.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);
const NETWORK = process.env.NETWORK || "hashkeyTestnet";
const CONTROL_FILE = path.join(ROOT, "scripts", "keeper", "demo-control.json");
const TS_NODE = path.join(ROOT, "node_modules", "ts-node", "dist", "bin.js");
const HARDHAT = fs.realpathSync(path.join(ROOT, "node_modules", ".bin", "hardhat"));
// The public HashKey RPC rate-limits by IP (Cloudflare error 1015), so keep the
// services' polling gentle unless the environment overrides it.
process.env.PUSHER_INTERVAL_MS ||= "20000";
process.env.AGENT_INTERVAL_MS ||= "10000";
process.env.LIQUIDATOR_INTERVAL_MS ||= "15000";

const SERVICES = {
  keeper: "scripts/keeper/guardian-price-pusher.ts",
  agent: "agents/risk-monitor.ts",
  liquidator: "agents/liquidator.ts",
};

const STATIC = {
  "/": [path.join(__dirname, "index.html"), "text/html; charset=utf-8"],
  "/index.html": [path.join(__dirname, "index.html"), "text/html; charset=utf-8"],
  "/vendor/ethers.umd.min.js": [
    path.join(ROOT, "node_modules", "ethers", "dist", "ethers.umd.min.js"),
    "application/javascript; charset=utf-8",
  ],
};

// Scenario edits merged into the bMTB entry of the keeper's control file.
const SCENARIOS = {
  steady: { priceA: 1.02, priceB: 1.02, skipA: false, skipB: false },
  decline: { priceA: 0.85, priceB: 0.85, skipA: false, skipB: false },
  attack: { priceB: 0.51 }, // one feed 40% below the honest $0.85 feed
  crash: { priceA: 0.7, priceB: 0.7, skipA: false, skipB: false }, // agreed crash: HF < 1.0
};
let scenario = "steady";
let resetting = false;

// ---- child processes -------------------------------------------------------
const procs = {};
const logs = { keeper: [], agent: [], liquidator: [] };
const ANSI = /\x1b\[[0-9;]*m/g;

function start(name) {
  const child = spawn(process.execPath, [TS_NODE, SERVICES[name]], { cwd: ROOT, env: process.env });
  procs[name] = child;
  let carry = "";
  const onData = (buf) => {
    const parts = (carry + buf.toString()).split("\n");
    carry = parts.pop();
    for (const raw of parts) {
      const line = raw.replace(ANSI, "").trimEnd();
      if (!line) continue;
      logs[name].push({ t: Date.now(), line });
      if (logs[name].length > 300) logs[name].shift();
      console.log(`[${name}] ${line}`);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    if (procs[name] === child) delete procs[name];
    console.log(`[${name}] exited (${code})`);
  });
}

function stop(name) {
  return new Promise((resolve) => {
    const child = procs[name];
    if (!child) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(resolve, 4000);
  });
}

function writeScenario(name) {
  const ctrl = JSON.parse(fs.readFileSync(CONTROL_FILE, "utf8"));
  ctrl.bMTB = { ...ctrl.bMTB, ...SCENARIOS[name] };
  fs.writeFileSync(CONTROL_FILE, JSON.stringify(ctrl, null, 2) + "\n");
  scenario = name;
}

async function runReset() {
  resetting = true;
  try {
    // The agent keeps its spent-buffer counter in memory, so restart it afterwards.
    await stop("agent");
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HARDHAT, "run", "scripts/reset-demo.ts", "--network", NETWORK], {
        cwd: ROOT,
        env: process.env,
      });
      const out = (d) => process.stdout.write(`[reset] ${d}`);
      child.stdout.on("data", out);
      child.stderr.on("data", out);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`reset exited ${code}`))));
    });
    scenario = "steady";
  } catch (e) {
    console.error(`[reset] failed: ${e.message}`);
  } finally {
    if (!procs.agent) start("agent");
    resetting = false;
  }
}

// ---- http ------------------------------------------------------------------
function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    return fs.createReadStream(file).pipe(res);
  }

  if (url.pathname === "/api/status") {
    return json(res, 200, {
      network: NETWORK,
      services: { keeper: !!procs.keeper, agent: !!procs.agent },
      scenario,
      resetting,
    });
  }

  if (url.pathname === "/api/scenario" && req.method === "POST") {
    const { name } = await readBody(req);
    if (!SCENARIOS[name]) return json(res, 400, { error: `unknown scenario "${name}"` });
    if (resetting) return json(res, 409, { error: "a reset is in progress" });
    writeScenario(name);
    return json(res, 200, { ok: true, scenario });
  }

  if (url.pathname === "/api/reset" && req.method === "POST") {
    if (resetting) return json(res, 409, { error: "a reset is already running" });
    runReset();
    return json(res, 202, { ok: true });
  }

  if (url.pathname === "/api/try-liquidate" && req.method === "POST") {
    const out = await new Promise((resolve) => {
      let buf = "";
      const child = spawn(process.execPath, [HARDHAT, "run", "scripts/try-liquidate.ts", "--network", NETWORK], { cwd: ROOT, env: process.env });
      child.stdout.on("data", (d) => (buf += d));
      child.stderr.on("data", (d) => (buf += d));
      child.on("exit", () => resolve(buf.replace(ANSI, "")));
    });
    const line = out.split("\n").find((l) => /result\s*:/.test(l)) || "no result";
    return json(res, 200, { result: line.replace(/^\s*result\s*:\s*/, "").trim() });
  }

  if (url.pathname === "/api/logs") {
    const req_ = url.searchParams.get("name");
    const name = logs[req_] ? req_ : "agent";
    const since = Number(url.searchParams.get("since") || 0);
    return json(res, 200, { lines: logs[name].filter((l) => l.t > since).slice(-50) });
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Terravault app on ${url} (${NETWORK})`);
  if (process.env.SKIP_SERVICES !== "1") {
    start("keeper");
    // Give the keeper one tick to refresh prices so the agents don't start on a stale feed.
    setTimeout(() => procs.agent || start("agent"), 15000);
    setTimeout(() => procs.liquidator || start("liquidator"), 17000);
  }
  if (process.platform === "darwin" && process.env.NO_OPEN !== "1") spawn("open", [url]);
});

async function shutdown() {
  await Promise.all([stop("keeper"), stop("agent"), stop("liquidator")]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
