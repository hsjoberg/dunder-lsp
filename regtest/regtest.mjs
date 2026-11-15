#!/usr/bin/env node
// Regtest orchestration for Dunder integration tests.
//
//   npm run regtest:up        start bitcoind + 3 lnd nodes, fund them, open channels
//   npm run regtest:test      run the integration tests (Dunder runs in-process)
//   npm run regtest:down      stop everything and delete regtest/.data
//   npm run regtest -- mine 6                 mine blocks
//   npm run regtest -- lncli lsp getinfo      run lncli on lsp, wallet or payer
//   npm run regtest -- status                 node pubkeys, balances, channels
//
// Topology: payer --(public channel)--> lsp --(Dunder, on demand)--> wallet

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGTEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(REGTEST_DIR, "..");
const DATA_DIR = join(REGTEST_DIR, ".data");
const COMPOSE_FILE = join(REGTEST_DIR, "docker-compose.yml");
const PROJECT = "dunder-regtest";
const NODES = ["lsp", "wallet", "payer"];
const GRPC_PORTS = { lsp: 20009, wallet: 20010, payer: 20011 };
const FUNDING_BTC = { lsp: 10, wallet: 1, payer: 5 };
const PAYER_CHANNEL_SAT = 5_000_000;
export const DUNDER_CONFIG_DIR = join(DATA_DIR, "dunder-config");

function compose(args, { capture = true, allowFailure = false } = {}) {
  const result = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, "-p", PROJECT, ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker compose ${args.join(" ")} failed:\n${result.stderr ?? ""}`);
  }
  return result;
}

export function bitcoinCli(args, { wallet = "miner", allowFailure = false } = {}) {
  const result = compose(
    [
      "exec",
      "-T",
      "bitcoind",
      "bitcoin-cli",
      "-regtest",
      "-rpcuser=dunder",
      "-rpcpassword=dunder",
      ...(wallet ? [`-rpcwallet=${wallet}`] : []),
      ...args,
    ],
    { allowFailure },
  );
  return result.stdout.trim();
}

export function lncli(node, args, { allowFailure = false } = {}) {
  const result = compose(["exec", "-T", node, "lncli", "--network=regtest", ...args], {
    allowFailure,
  });
  if (result.status !== 0) {
    return null;
  }
  const out = result.stdout.trim();
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

export function mine(blocks = 1) {
  const address = bitcoinCli(["getnewaddress"]);
  bitcoinCli(["generatetoaddress", String(blocks), address]);
}

async function waitFor(description, check, { timeoutMs = 120_000, intervalMs = 1000 } = {}) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

function getInfo(node) {
  return lncli(node, ["getinfo"], { allowFailure: true });
}

async function waitSynced(nodes = NODES) {
  for (const node of nodes) {
    await waitFor(`${node} to sync`, () => getInfo(node)?.synced_to_chain === true);
  }
}

function nodePaths(node) {
  const lndDir = join(DATA_DIR, node);
  return {
    cert: join(lndDir, "tls.cert"),
    macaroon: join(lndDir, "data", "chain", "bitcoin", "regtest", "admin.macaroon"),
  };
}

// gRPC targets use "localhost", not 127.0.0.1: with @grpc/grpc-js 1.9 the
// target host becomes the TLS server name, and Node 25 rejects IP addresses
// there. lnd's certificate includes localhost (--tlsextradomain).
function writeDunderConfig(lspPubkey) {
  mkdirSync(DUNDER_CONFIG_DIR, { recursive: true });
  const { cert, macaroon } = nodePaths("lsp");
  const config = {
    env: "regtest",
    serverHost: "127.0.0.1:18089",
    serverDomain: "http://127.0.0.1:18089",
    databasePath: join(DATA_DIR, "dunder.db"),
    htlcWaitSeconds: 10,
    minimumPaymentMultiplier: 5,
    maximumPaymentSat: 1000000,
    fee: { maxSat: 40000, maxSatPerVByte: 200, subsidyFactor: 1 },
    backend: "lnd",
    backendConfig: {
      // Address other nodes on the docker network use to reach the LSP.
      lndNode: "lsp:9735",
      grpcServer: `localhost:${GRPC_PORTS.lsp}`,
      cert,
      adminMacaroon: macaroon,
    },
    // Matches production: Blixt doesn't use zero-conf channels.
    allowZeroConfChannels: false,
    allowTaprootChannels: true,
    rejectPublicPublicHtlcForwards: false,
    allowLegacySignatures: true,
    maxOpenRequestsPerPubkey: 100,
    signedRequestRateLimitPerMinute: 10000,
    ipRateLimitPerMinute: 0,
    regtest: {
      lspPubkey,
      nodes: Object.fromEntries(
        NODES.map((node) => [node, { grpcServer: `localhost:${GRPC_PORTS[node]}`, ...nodePaths(node) }]),
      ),
    },
  };
  writeFileSync(join(DUNDER_CONFIG_DIR, "default.json"), JSON.stringify(config, null, 2));
}

async function up() {
  for (const node of NODES) {
    mkdirSync(join(DATA_DIR, node), { recursive: true });
  }
  console.log("Starting containers...");
  compose(["up", "-d"], { capture: false });

  await waitFor("bitcoind", () => bitcoinCli(["getblockchaininfo"], { wallet: null, allowFailure: true }));
  if (!bitcoinCli(["listwallets"], { wallet: null }).includes('"miner"')) {
    const created = compose(
      ["exec", "-T", "bitcoind", "bitcoin-cli", "-regtest", "-rpcuser=dunder", "-rpcpassword=dunder", "createwallet", "miner"],
      { allowFailure: true },
    );
    if (created.status !== 0) {
      bitcoinCli(["loadwallet", "miner"], { wallet: null, allowFailure: true });
    }
  }
  const height = Number(bitcoinCli(["getblockcount"], { wallet: null }));
  if (height < 101) {
    console.log("Mining initial blocks...");
    mine(101 - height);
  }

  console.log("Waiting for lnd nodes...");
  for (const node of NODES) {
    await waitFor(`${node} lnd`, () => getInfo(node)?.identity_pubkey, { timeoutMs: 180_000 });
    await waitFor(`${node} TLS cert and macaroon`, () =>
      Object.values(nodePaths(node)).every((path) => existsSync(path)),
    );
  }
  await waitSynced();

  console.log("Funding nodes...");
  let funded = false;
  for (const node of NODES) {
    const balance = lncli(node, ["walletbalance"]);
    if (Number(balance.total_balance) === 0) {
      const { address } = lncli(node, ["newaddress", "p2wkh"]);
      bitcoinCli(["sendtoaddress", address, String(FUNDING_BTC[node])]);
      funded = true;
    }
  }
  if (funded) {
    mine(6);
    await waitSynced();
    for (const node of NODES) {
      await waitFor(`${node} confirmed balance`, () => Number(lncli(node, ["walletbalance"]).confirmed_balance) > 0);
    }
  }

  const lspPubkey = getInfo("lsp").identity_pubkey;
  for (const node of ["payer", "wallet"]) {
    const peers = lncli(node, ["listpeers"]).peers ?? [];
    if (!peers.some((peer) => peer.pub_key === lspPubkey)) {
      lncli(node, ["connect", `${lspPubkey}@lsp:9735`], { allowFailure: true });
    }
  }

  const payerChannels = lncli("payer", ["listchannels"]).channels ?? [];
  const pending = lncli("payer", ["pendingchannels"]).pending_open_channels ?? [];
  if (!payerChannels.some((c) => c.remote_pubkey === lspPubkey) && pending.length === 0) {
    console.log("Opening payer -> lsp channel...");
    lncli("payer", ["openchannel", "--node_key", lspPubkey, "--local_amt", String(PAYER_CHANNEL_SAT)]);
  }
  mine(6);
  await waitSynced();
  await waitFor("payer -> lsp channel to become active", () =>
    (lncli("payer", ["listchannels"]).channels ?? []).some(
      (c) => c.remote_pubkey === lspPubkey && c.active,
    ),
  );

  writeDunderConfig(lspPubkey);
  console.log("\nRegtest network is ready.");
  status();
}

function status() {
  for (const node of NODES) {
    const info = getInfo(node);
    if (!info) {
      console.log(`${node}: not running`);
      continue;
    }
    const balance = lncli(node, ["walletbalance"]);
    const channels = lncli(node, ["listchannels"]).channels ?? [];
    console.log(
      `${node.padEnd(7)} ${info.identity_pubkey}  height ${info.block_height}  ` +
        `wallet ${balance.confirmed_balance} sat  channels ${channels.length}`,
    );
  }
}

function down() {
  compose(["down", "-v", "--remove-orphans"], { capture: false, allowFailure: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log("Regtest network removed.");
}

function test(extraArgs) {
  if (!existsSync(join(DUNDER_CONFIG_DIR, "default.json"))) {
    console.error("The regtest network isn't set up. Run `npm run regtest:up` first.");
    process.exit(1);
  }
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "jest", "bin", "jest.js"), "-c", join(ROOT, "jest.regtest.config.js"), "--runInBand", ...extraArgs],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, NODE_CONFIG_DIR: DUNDER_CONFIG_DIR, SUPPRESS_NO_CONFIG_WARNING: "1" },
    },
  );
  process.exit(result.status ?? 1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  try {
    switch (command) {
      case "up":
        await up();
        break;
      case "down":
        down();
        break;
      case "test":
        test(args);
        break;
      case "status":
        status();
        break;
      case "mine":
        mine(Number(args[0] ?? 1));
        await waitSynced();
        break;
      case "lncli": {
        const [node, ...rest] = args;
        compose(["exec", "-T", node, "lncli", "--network=regtest", ...rest], { capture: false });
        break;
      }
      default:
        console.log("Usage: node regtest/regtest.mjs <up|test|down|status|mine [n]|lncli <node> ...>");
        process.exit(command ? 1 : 0);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
