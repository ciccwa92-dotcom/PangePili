const { chromium } = require('playwright');
const { spawn } = require('child_process');

const ROOT = __dirname;
const SERVER_URL = 'http://localhost:8080';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer() {
  const maxAttempts = 40;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      if (res.ok) return true;
    } catch (err) {
      // wait and retry
    }
    await sleep(250);
  }
  throw new Error('Server did not become ready at http://localhost:8080');
}

async function ensureServer() {
  try {
    const res = await fetch(`${SERVER_URL}/health`);
    if (res.ok) return null;
  } catch (err) {
    // not running
  }

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '8080' }
  });

  child.stdout.on('data', (data) => {
    process.stdout.write(`[SERVER] ${String(data)}`);
  });
  child.stderr.on('data', (data) => {
    process.stderr.write(`[SERVER_ERR] ${String(data)}`);
  });

  await waitForServer();
  return child;
}

function attachConsoleCapture(page, label, startTime, logs) {
  page.on('console', (msg) => {
    logs.push({
      label,
      ts: Date.now() - startTime,
      type: msg.type(),
      text: msg.text()
    });
  });

  page.on('pageerror', (error) => {
    logs.push({
      label,
      ts: Date.now() - startTime,
      type: 'pageerror',
      text: String(error)
    });
  });
}

async function main() {
  const startTime = Date.now();
  const hostLogs = [];
  const guestLogs = [];
  const server = await ensureServer();

  const browser = await chromium.launch({ headless: true });
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });

  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();

  attachConsoleCapture(hostPage, 'HOST', startTime, hostLogs);
  attachConsoleCapture(guestPage, 'GUEST', startTime, guestLogs);

  try {
    await hostPage.goto(`${SERVER_URL}/?nocache=host-e2e`);
    await hostPage.fill('#pname', 'HostPlaywright');
    await hostPage.click('#create-room-btn');
    await hostPage.waitForSelector('#lobby-start-btn');
    const roomCode = (await hostPage.locator('#lobby-code').textContent()).trim();
    console.log(`Created room: ${roomCode}`);

    await guestPage.goto(`${SERVER_URL}/?nocache=guest-e2e`);
    await guestPage.fill('#pname', 'GuestPlaywright');
    await guestPage.fill('#room-code', roomCode);
    await guestPage.click('#join-room-btn');
    await guestPage.waitForSelector('#lobby-start-btn', { state: 'visible' });

    const hostBefore = await hostPage.locator('#lobby').evaluate(el => getComputedStyle(el).display);
    const guestBefore = await guestPage.locator('#lobby').evaluate(el => getComputedStyle(el).display);
    console.log(`Before start - HOST lobby display: ${hostBefore}, GUEST lobby display: ${guestBefore}`);

    await hostPage.click('#lobby-start-btn');
    await sleep(5000);

    const hostMain = await hostPage.locator('#main').evaluate(el => getComputedStyle(el).display);
    const hostLobby = await hostPage.locator('#lobby').evaluate(el => getComputedStyle(el).display);
    const guestMain = await guestPage.locator('#main').evaluate(el => getComputedStyle(el).display);
    const guestLobby = await guestPage.locator('#lobby').evaluate(el => getComputedStyle(el).display);

    const merged = [...hostLogs, ...guestLogs].sort((a, b) => a.ts - b.ts);
    console.log('\n=== HOST + GUEST CONSOLE LOGS (chronological) ===');
    for (const entry of merged) {
      console.log(`[${entry.ts}ms] ${entry.label} [${entry.type}] ${entry.text}`);
    }

    console.log('\n=== FINAL STATE ===');
    console.log(`HOST: main=${hostMain} lobby=${hostLobby}`);
    console.log(`GUEST: main=${guestMain} lobby=${guestLobby}`);

    if (hostMain === 'flex' && guestMain === 'flex') {
      console.log('RESULT: both host and guest entered the game');
      process.exitCode = 0;
      return;
    }

    console.log('RESULT: host did not enter the game or guest did not enter the game');
    process.exitCode = 1;
  } finally {
    await hostContext.close();
    await guestContext.close();
    await browser.close();
    if (server) {
      server.kill('SIGTERM');
      await sleep(500);
    }
  }
}

main().catch((err) => {
  console.error('E2E test failed:', err);
  process.exit(1);
});
