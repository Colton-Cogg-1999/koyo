// Drives the real server and UI in Chromium. Build first: `npm run build && cargo build`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';

const PORT = 47950;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const binary = resolve('../target/debug/omareader');
const browserPath = process.env.CHROMIUM ?? '/usr/bin/chromium';
const data = mkdtempSync(join(tmpdir(), 'omareader-e2e-'));
let server, browser, page, token;
const errors = [];

before(async () => {
  server = spawn(binary, ['serve', String(PORT)], { env: { ...process.env, OMAREADER_DATA_DIR: join(data, 'lib') }, stdio: 'pipe' });
  const url = await new Promise((done, fail) => {
    let output = '', diagnostics = '';
    const timer = setTimeout(() => fail(new Error(`server startup timed out: ${diagnostics}`)), 15000);
    server.stderr.on('data', (chunk) => { diagnostics += chunk.toString(); });
    server.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('\n')) { clearTimeout(timer); done(output.split('\n')[0].trim()); }
    });
    server.once('error', (error) => { clearTimeout(timer); fail(error); });
    server.once('exit', (code) => { clearTimeout(timer); fail(new Error(`server exited (${code}): ${diagnostics}`)); });
  });
  token = new URL(url).searchParams.get('t');
  browser = await chromium.launch({ executablePath: browserPath, args: ['--no-sandbox'] });
  page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForSelector('.main .pane');
});

after(async () => {
  await browser?.close();
  server?.kill();
  rmSync(data, { recursive: true, force: true });
});

const select = (block) => page.evaluate((seq) => {
  const element = document.querySelector(`[data-b="${seq}"]`);
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}, block);

test('the API refuses other users, sites and hostnames', async () => {
  const anonymous = await fetch(`${ORIGIN}/api/books`);
  assert.equal(anonymous.status, 401);
  const headers = { Cookie: `oma_session=${token}`, 'Content-Type': 'application/json' };
  const crossSite = await fetch(`${ORIGIN}/api/settings`, { method: 'PUT', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(crossSite.status, 403);
  const noOrigin = await fetch(`${ORIGIN}/api/settings`, { method: 'PUT', headers, body: '{}' });
  assert.equal(noOrigin.status, 403);
  const page2 = await fetch(`${ORIGIN}/`);
  assert.match(page2.headers.get('content-security-policy'), /default-src 'self'/);
});

test('a dropped file is imported, read, marked and survives a reload', async () => {
  const file = join(data, 'guide.md');
  writeFileSync(file, '---\ntitle: Field Guide\nauthor: T. Author\n---\n\n# Lanterns\n\nThe lamp burned low across the quiet water tonight.\n\n# Bells\n\nTemple bells answered in the dark, and nothing here was lost.\n');
  await page.setInputFiles('[data-testid=file-input]', file);
  await page.waitForSelector('.row[title="Field Guide"]:not(.processing)');
  await page.dblclick('.row[title="Field Guide"]');
  await page.waitForSelector('.prose p');
  await select(1);
  await page.click('.pick-menu button[title="Add a note"]');
  await page.fill('.note-editor textarea', 'remember this');
  await page.click('.note-editor .solid');
  await page.waitForSelector('.ref');
  await page.reload();
  await page.waitForSelector('.ref');
  assert.match(await page.textContent('.ref'), /remember this/);
  assert.equal(await page.evaluate(() => CSS.highlights.get('oma-blue')?.size), 1);
});

test('the notes pane switches tabs and notes become Markdown files', async () => {
  await page.click('.tab:has-text("index")');
  await page.click('.index button:has-text("Bells")');
  await page.click('.tab:has-text("notebook")');
  await page.click('.tab:has-text("margin")');
  assert.equal(await page.locator('.crash').count(), 0);
  const notes = await page.evaluate(() => fetch('/api/storage').then((r) => r.json()));
  const { readdirSync } = await import('node:fs');
  const [file] = readdirSync(notes.notes_dir);
  assert.match(readFileSync(join(notes.notes_dir, file), 'utf8'), /remember this/);
});

test('search finds text and jumps to it', async () => {
  await page.keyboard.press('/');
  await page.fill('.search-sheet input', 'temple');
  await page.waitForSelector('.hits button');
  await page.click('.hits button');
  await page.waitForSelector('.flash');
});

test('workspaces open from the keyboard', async () => {
  for (const [key, text] of [['3', 'MARKS'], ['5', 'NOTEBOOK'], ['6', 'SYS'], ['4', 'AUDIOBOOKS'], ['1', 'LIBRARY']]) {
    await page.keyboard.press(key);
    await page.waitForFunction((t) => document.querySelector('.main .pane-title h2')?.textContent.startsWith(t), text);
  }
  assert.deepEqual(errors, []);
});
