// Drives the real server and UI in Chromium. Build first: `npm run build && cargo build`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';

let ORIGIN;
const binary = resolve('../target/debug/omareader');
const browserPath = process.env.CHROMIUM ?? '/usr/bin/chromium';
const data = mkdtempSync(join(tmpdir(), 'omareader-e2e-'));
let server, browser, page, token;
const errors = [];

before(async () => {
  server = spawn(binary, ['serve', '0'], { env: { ...process.env, OMAREADER_DATA_DIR: join(data, 'lib') }, stdio: 'pipe' });
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
  ORIGIN = new URL(url).origin;
  token = new URL(url).searchParams.get('t');
  const fixtures = spawnSync('python3', ['test/fixtures.py', data], { encoding: 'utf8' });
  assert.equal(fixtures.status, 0, fixtures.stderr);
  browser = await chromium.launch({ executablePath: browserPath, args: ['--no-sandbox'] });
  page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForSelector('.main .pane');
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    const stopped = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await stopped;
  }
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

const api = async (path, method = 'GET', body) => {
  const response = await fetch(`${ORIGIN}${path}`, {
    method, headers: { Cookie: `oma_session=${token}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${await (!response.ok ? response.text() : Promise.resolve(''))}`);
  return response.json();
};
const eventually = async (check, timeout = 10000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)); }
  assert.fail('condition did not become true');
};
const upload = async (name) => {
  const response = await fetch(`${ORIGIN}/api/books`, { method: 'POST',
    headers: { Cookie: `oma_session=${token}`, Origin: ORIGIN, 'x-file-name': encodeURIComponent(name) },
    body: readFileSync(join(data, name)),
  });
  assert.ok(response.ok);
  const { id } = await response.json();
  await eventually(async () => (await api(`/api/books/${id}`)).status === 'ready');
  return id;
};

let epub, pdf;
test('EPUB imports, navigates chapters, and sandboxes book assets', async () => {
  epub = await upload('fixture.epub');
  await page.goto(`${ORIGIN}/#/read/${epub}`);
  await page.waitForSelector('.prose h1');
  assert.match(await page.textContent('.prose'), /Open Shelves/);
  const asset = await page.locator('.prose img').getAttribute('src');
  const response = await fetch(new URL(asset, ORIGIN), { headers: { Cookie: `oma_session=${token}` } });
  assert.match(response.headers.get('content-security-policy'), /^sandbox;/);
  await page.click('.prose a:has-text("Next chapter")');
  await page.waitForFunction(() => document.querySelector('.prose h1')?.textContent === 'Room for Everyone');
  await eventually(async () => (await api(`/api/books/${epub}`)).position?.block > 0);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.prose h1')?.textContent === 'Room for Everyone');
});

test('encoded path separators cannot escape book storage', async () => {
  for (const id of ['..%2F..%2Fnotes', '%2Ftmp', 'not-a-book']) {
    const response = await fetch(`${ORIGIN}/api/books/${id}/cover`, { headers: { Cookie: `oma_session=${token}` } });
    assert.equal(response.status, 400);
  }
});

test('PDF pages keep their own aspect ratios and restore a blank-page position', async () => {
  pdf = await upload('mixed-pages.pdf');
  await page.goto(`${ORIGIN}/#/read/${pdf}`);
  await page.waitForSelector('.pdf-page canvas');
  await page.waitForFunction(() => document.querySelector('.textLayer')?.textContent.includes('open reading guide'));
  const ratios = await page.locator('.pdf-page').evaluateAll((pages) => pages.map((p) => p.clientHeight / p.clientWidth));
  assert.ok(Math.abs(ratios[0] - 792/612) < .01);
  assert.ok(Math.abs(ratios[1] - 612/792) < .01);
  await page.locator('.pdf-stage').evaluate((box) => { box.scrollTop = box.scrollHeight; });
  await eventually(async () => (await api(`/api/books/${pdf}`)).position?.page === 3);
  await page.reload();
  await page.waitForSelector('.pdf-page canvas');
  await page.waitForFunction(() => {
    const box = document.querySelector('.pdf-stage');
    const last = document.querySelector('[data-page="3"]');
    return box && last && last.getBoundingClientRect().top < box.getBoundingClientRect().bottom;
  });
  assert.equal((await api(`/api/books/${pdf}`)).position.page, 3);
});

test('notebook autosaves on navigation, survives reload, and retains failed saves', async () => {
  await page.goto(`${ORIGIN}/#/notebook`);
  await page.click('button:has-text("new")');
  await page.fill('[aria-label="Note title"]', 'Portable knowledge');
  await page.fill('[aria-label="Note body"]', 'Keep the doors open.');
  await page.evaluate(() => { location.hash = '#/library'; });
  await eventually(async () => (await api('/api/notes')).some((n) => n.body === 'Keep the doors open.'));
  await page.goto(`${ORIGIN}/#/notebook`);
  await page.click('.note-card:has-text("Portable knowledge")');
  assert.equal(await page.inputValue('[aria-label="Note body"]'), 'Keep the doors open.');
  await page.route('**/api/notes/*', (route) => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"simulated storage failure"}' }) : route.continue());
  await page.fill('[aria-label="Note body"]', 'These edits must stay visible.');
  await page.click('button:has-text("save & back")');
  await page.waitForSelector('.note-sheet [role="status"]:has-text("save failed")');
  assert.equal(await page.inputValue('[aria-label="Note body"]'), 'These edits must stay visible.');
  await page.evaluate(() => { location.hash = '#/library'; });
  await page.waitForSelector('.pane-title h2:has-text("LIBRARY")');
  await page.goto(`${ORIGIN}/#/notebook`);
  await page.click('.note-card:has-text("Portable knowledge")');
  assert.equal(await page.inputValue('[aria-label="Note body"]'), 'These edits must stay visible.');
  await page.unroute('**/api/notes/*');
  await page.click('button:has-text("save & back")');
  await page.waitForSelector('.note-card');
  assert.match(readFileSync(join(data,'lib','notes','notebook.md'), 'utf8'), /These edits must stay visible/);
  await page.click('.note-card:has-text("Portable knowledge")');
  const longNote = 'A long notebook remains portable. '.repeat(2500);
  await page.fill('[aria-label="Note body"]', longNote);
  await page.click('button:has-text("save & back")');
  await page.waitForSelector('.note-card');
  assert.ok((await api('/api/notes')).some((n) => n.body === longNote));
});

test('collections, favorites, duplicate imports, and deletion persist', async () => {
  assert.equal(await upload('fixture.epub'), epub);
  const collection = await api('/api/collections', 'POST', { name: 'Open shelf' });
  await api(`/api/books/${epub}`, 'PATCH', { favorite: true, collections: [collection.id] });
  const book = await api(`/api/books/${epub}`);
  assert.equal(book.favorite, 1);
  assert.equal(book.collection_ids, String(collection.id));
  await api(`/api/collections/${collection.id}`, 'DELETE');
  assert.equal((await api(`/api/books/${epub}`)).collection_ids, '');
  await api(`/api/books/${pdf}`, 'DELETE');
  assert.ok(!(await api('/api/books')).some((b) => b.id === pdf));
});

test('capture the real reader with original test content', async () => {
  await api('/api/settings', 'PUT', { reader: { paper: 'ivory', font: 'newsreader', size: 22 } });
  await page.goto(`${ORIGIN}/#/read/${epub}?b=0`);
  await page.reload();
  await page.waitForSelector('.prose h1');
  await page.evaluate(() => document.fonts.ready);
  await select(1);
  await page.click('.pick-menu button[title="Add a note"]');
  await page.fill('.note-editor textarea', 'Knowledge grows when people can read, question, and share it.');
  await page.click('.note-editor .solid');
  await page.waitForSelector('.ref');
  await page.waitForTimeout(2500);
  if (process.env.OMAREADER_SCREENSHOT) await page.screenshot({ path: process.env.OMAREADER_SCREENSHOT });
  assert.deepEqual(errors, []);
});

test('real Kokoro narration and M4B export', { skip: !process.env.OMAREADER_TEST_TTS, timeout: 900000 }, async () => {
  await api('/api/tts/install', 'POST');
  await eventually(async () => (await api('/api/tts')).installed, 600000);
  await api(`/api/books/${epub}/audio`, 'POST', { voice: 'af_heart' });
  await eventually(async () => {
    const audio = await api(`/api/books/${epub}/audio`);
    assert.notEqual(audio.status, 'failed', audio.error);
    return audio.status === 'done';
  }, 240000);
  const audio = await api(`/api/books/${epub}/audio`);
  assert.ok(audio.tracks.length > 0 && audio.tracks.every((t) => t.ready && t.duration_ms > 0));
  const detail = await api(`/api/books/${epub}/audio/tracks/0/detail`);
  assert.ok(detail.marks.length > 0);
  await api(`/api/books/${epub}/audio/export`, 'POST');
  await eventually(async () => (await api(`/api/books/${epub}/audio`)).has_export, 30000);
  const file = join(data, 'lib', 'audio', epub, 'audiobook.m4b');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(Number(JSON.parse(probe.stdout).format.duration) > 1);
});

test('live AI answers use the selected provider and persist citations', { skip: !process.env.OMAREADER_TEST_AI, timeout: 180000 }, async (t) => {
  const status = await api('/api/ai/providers');
  const providers = status.providers.filter((p) => p.signed_in);
  if (!providers.length) { t.skip('No authenticated AI CLI is available'); return; }
  for (const provider of providers) {
    await api('/api/settings', 'PUT', { ai_provider: provider.id, ai_model: '' });
    const chat = await api(`/api/books/${epub}/chats`, 'POST');
    const response = await fetch(`${ORIGIN}/api/chats/${chat.id}/messages`, {
      method: 'POST', signal: AbortSignal.timeout(80000),
      headers: { Cookie: `oma_session=${token}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'According to the text, what should not stand between a person and their book? Answer in one sentence with a citation.', scope: 'book' }),
    });
    assert.ok(response.ok, provider.id);
    const events = (await response.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    const failure = events.find((event) => event.type === 'error');
    assert.ok(!failure, `${provider.id}: ${failure?.message}`);
    assert.ok(events.some((event) => event.type === 'done'), `${provider.id}: missing completion`);
    const messages = await api(`/api/chats/${chat.id}/messages`);
    assert.equal(messages.at(-1).provider, provider.id);
    assert.ok(messages.at(-1).content.length > 0);
    assert.ok(messages.at(-1).citations.length > 0);
    t.diagnostic(`${provider.id}: live response and citation persistence passed`);
  }
});

test('library exposes originals and asks about a chapter without opening the reader', async () => {
  const before = (await api(`/api/books/${epub}`)).position;
  const storage = await api('/api/storage');
  assert.equal(storage.books_dir, join(data, 'lib', 'books'));
  await page.goto(`${ORIGIN}/#/library`);
  await page.click('.row[title="Open Shelves"]');
  assert.match(await page.textContent('.library-location'), /books/);
  const download = page.waitForEvent('download');
  await page.click('a:has-text("Export original")');
  const original = await download;
  assert.deepEqual(readFileSync(await original.path()), readFileSync(join(data, 'fixture.epub')));
  await page.route('**/api/ai/providers', (route) => route.fulfill({ json: { providers: [{ id: 'codex', name: 'Test provider', signed_in: true, models: [] }], selected: 'codex' } }));
  let sent;
  await page.route('**/api/chats/*/messages', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent = route.request().postDataJSON();
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"delta","text":"Test transport only."}\n\ndata: {"type":"done","id":1}\n\n' });
  });
  await page.click('button:has-text("Ask this book")');
  await page.waitForSelector('.study .agent');
  assert.equal(await page.locator('.prose,.pdf-page').count(), 0);
  await page.selectOption('[aria-label="Question scope"]', 'chapter');
  const book = await api(`/api/books/${epub}`);
  const chapter = book.chapters.find((c) => c.title === 'Room for Everyone');
  await page.selectOption('[aria-label="Question chapter"]', String(chapter.idx));
  await page.fill('.ask textarea', 'What stands between a person and a book?');
  await page.click('.ask button[type="submit"]');
  await eventually(() => sent);
  assert.equal(sent.scope, 'chapter');
  assert.equal(sent.chapter, chapter.idx);
  assert.equal(sent.block, undefined);
  assert.deepEqual((await api(`/api/books/${epub}`)).position, before);
  await page.unroute('**/api/chats/*/messages');
  await page.unroute('**/api/ai/providers');
});

test('reader sends visible bounds and exact highlighted context', async () => {
  await page.route('**/api/ai/providers', (route) => route.fulfill({ json: { providers: [{ id: 'codex', name: 'Test provider', signed_in: true, models: [] }], selected: 'codex' } }));
  const sent = [];
  await page.route('**/api/chats/*/messages', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"delta","text":"Test transport only."}\n\ndata: {"type":"done","id":1}\n\n' });
  });
  await page.goto(`${ORIGIN}/#/read/${epub}?b=0`);
  await page.waitForSelector('.prose p');
  await page.fill('.ask textarea', 'Explain the visible page');
  await page.click('.ask button[type="submit"]');
  await eventually(() => sent.length === 1);
  assert.equal(sent[0].scope, 'page');
  assert.ok(Number.isInteger(sent[0].block) && sent[0].end_block >= sent[0].block);
  await select(1);
  const quote = await page.locator('[data-b="1"]').textContent();
  await page.click('.pick-menu button[title="Ask Oma"]');
  await page.fill('.ask textarea', 'What does this selected passage mean?');
  await page.click('.ask button[type="submit"]');
  await eventually(() => sent.length === 2);
  assert.equal(sent[1].scope, 'selection');
  assert.equal(sent[1].block, 1);
  assert.equal(sent[1].end_block, 1);
  assert.equal(sent[1].selection, quote.trim().replace(/\s+/g, ' '));
  await page.unroute('**/api/chats/*/messages');
  await page.unroute('**/api/ai/providers');
});

test('live AI answers page, selection, and chosen chapter questions from the correct evidence', { skip: !process.env.OMAREADER_TEST_AI, timeout: 900000 }, async (t) => {
  writeFileSync(join(data, 'signals.md'), '# Harbor\n\nThe harbor signal is amber. Its keeper is Mara. The access phrase is copper otter.\n\n# Observatory\n\nThe observatory signal is violet. Its keeper is Ivo. The access phrase is silver badger.\n');
  const id = await upload('signals.md');
  const providers = (await api('/api/ai/providers')).providers.filter((p) => p.signed_in);
  assert.ok(providers.length, 'Live AI verification requires an authenticated provider');
  const cases = [
    { name: 'page', body: { scope: 'page', block: 1, end_block: 1, question: 'What is the access phrase on this page? Give only the phrase and a citation.' }, expected: /copper otter/i, forbidden: /silver badger/i, block: 1 },
    { name: 'selection', body: { scope: 'selection', block: 1, end_block: 1, selection: 'Its keeper is Mara.', question: 'Who is the keeper named in the selected text? Give only the name and a citation.' }, expected: /Mara/, forbidden: /Ivo/, block: 1 },
    { name: 'chosen chapter', body: { scope: 'chapter', chapter: 1, block: 0, question: 'What is the access phrase in this chapter? Give only the phrase and a citation.' }, expected: /silver badger/i, forbidden: /copper otter/i, block: 2 },
    { name: 'unanswerable', body: { scope: 'selection', block: 1, selection: 'Its keeper is Mara.', question: 'What year was Mara born? If the provided text does not say, answer: Not stated in the selected text.' }, expected: /not stated/i, forbidden: /\b(?:19|20)\d\d\b/, block: 1 },
  ];
  for (const provider of providers) {
    await api('/api/settings', 'PUT', { ai_provider: provider.id, ai_model: '' });
    for (const item of cases) await t.test(`${provider.id}: ${item.name}`, async () => {
      const chat = await api(`/api/books/${id}/chats`, 'POST');
      const response = await fetch(`${ORIGIN}/api/chats/${chat.id}/messages`, { method: 'POST', signal: AbortSignal.timeout(120000),
        headers: { Cookie: `oma_session=${token}`, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(item.body) });
      assert.ok(response.ok, await (!response.ok ? response.text() : Promise.resolve('')));
      const events = (await response.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
      assert.ok(!events.some((e) => e.type === 'error'), JSON.stringify(events));
      assert.ok(events.some((e) => e.type === 'done'));
      const answer = (await api(`/api/chats/${chat.id}/messages`)).at(-1);
      assert.match(answer.content, item.expected);
      assert.doesNotMatch(answer.content, item.forbidden);
      assert.ok(answer.citations.length > 0);
      assert.ok(answer.citations.every((c) => c.block >= item.block));
      if (item.name !== 'unanswerable') {
        const used = [...answer.content.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
        assert.ok(used.length > 0, answer.content);
        for (const n of used) assert.match(answer.citations.find((c) => c.n === n)?.quote ?? '', item.expected);
      }
      t.diagnostic(`${provider.id}, ${item.name}: ${answer.content}`);
    });
  }
});
