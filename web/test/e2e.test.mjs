// Drives the real server and UI in Chromium. Build first: `npm run build && cargo build`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';

let ORIGIN;
const binary = resolve('../target/debug/omareader');
const browserPath = process.env.CHROMIUM ?? '/usr/bin/chromium';
const data = mkdtempSync(join(tmpdir(), 'koyo-e2e-'));
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
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(url);
  await page.waitForSelector('.shelf');
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
const signedIn = (models = []) => (route) => route.fulfill({ json: { providers: [{ id: 'codex', name: 'Test provider', signed_in: true, installed: true, models, help: '' }], selected: 'codex', model: '' } });
const stream = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const openPanel = async (key, selector) => {
  if (!(await page.locator(selector).isVisible())) await page.keyboard.press(key);
  await page.waitForSelector(selector);
};

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

test('narration is not compiled into the default build, and unknown API paths are 404', async () => {
  const response = await fetch(`${ORIGIN}/api/tts`, { headers: { Cookie: `oma_session=${token}` } });
  assert.equal(response.status, 404);
});

test('an empty shelf invites a first book, and the theme toggles from the keyboard', async () => {
  await page.waitForSelector('.welcome');
  assert.match(await page.textContent('.brand'), /Kōyō/);
  const before = await page.evaluate(() => document.documentElement.dataset.theme ?? 'auto');
  await page.keyboard.press('d');
  const after = await page.evaluate(() => document.documentElement.dataset.theme);
  assert.ok(['day', 'night'].includes(after) && after !== before);
  await page.reload();
  await page.waitForSelector('.shelf');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), after);
  await page.evaluate(() => { localStorage.removeItem('koyo:theme'); delete document.documentElement.dataset.theme; });
});

test('a dropped file is imported, read, noted and survives a reload', async () => {
  const file = join(data, 'guide.md');
  writeFileSync(file, '---\ntitle: Field Guide\nauthor: T. Author\n---\n\n# Lanterns\n\nThe lamp burned low across the quiet water tonight.\n\n# Bells\n\nTemple bells answered in the dark, and nothing here was lost.\n');
  await page.setInputFiles('[data-testid=file-input]', file);
  await page.waitForSelector('.card[title="Field Guide"]:not(.processing) .card-open:not([disabled])');
  await page.click('.card[title="Field Guide"] .card-open');
  await page.waitForSelector('.prose p');
  await select(1);
  await page.click('.selection-bar button:has-text("Note")');
  await page.fill('.note textarea', 'remember this');
  const id = (await api('/api/books')).find((b) => b.title === 'Field Guide').id;
  await eventually(async () => (await api(`/api/annotations?book=${id}`)).some((a) => a.note === 'remember this'));
  await page.reload();
  await page.waitForSelector('.note-text');
  assert.match(await page.textContent('.note-text'), /remember this/);
  assert.equal(await page.evaluate(() => CSS.highlights.get('oma-yellow')?.size), 1);
  const notes = await api('/api/storage');
  const [mirror] = readdirSync(notes.notes_dir);
  assert.match(readFileSync(join(notes.notes_dir, mirror), 'utf8'), /remember this/);
});

test('contents, search and the companion tabs open from the keyboard', async () => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await page.click('.toc button:has-text("Bells")');
  await page.waitForFunction(() => document.querySelector('.prose')?.textContent.includes('Temple bells'));
  await page.keyboard.press('/');
  await page.fill('.panel-search input', 'temple');
  await page.waitForSelector('.hits button');
  await page.click('.hits button');
  await page.waitForSelector('.flash');
  for (const [key, tab] of [['h', 'Highlights'], ['n', 'Notes'], ['q', 'Ask']]) {
    await page.locator('.prose').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press(key);
    await page.waitForSelector(`[role="tab"][aria-selected="true"]:has-text("${tab}")`);
  }
  await page.locator('.prose').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.panel', { state: 'hidden' });
  assert.deepEqual(errors, []);
});

let epub, pdf;
test('EPUB imports, navigates chapters, and sandboxes book assets', async () => {
  epub = await upload('fixture.epub');
  await page.goto(`${ORIGIN}/#/read/${epub}`);
  await page.waitForSelector('.prose h1');
  assert.match(await page.textContent('.prose'), /Open Shelves/);
  assert.match(await page.textContent('.chapter-eyebrow'), /Chapter 1/);
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

test('duplicates are detected, originals download, and books leave the shelf from their menu', async () => {
  assert.equal(await upload('fixture.epub'), epub);
  await page.goto(`${ORIGIN}/#/library`);
  await page.waitForSelector('.card[title="Open Shelves"]');
  await page.hover('.card[title="Open Shelves"]');
  await page.click('.card[title="Open Shelves"] [aria-label^="Options"]');
  const download = page.waitForEvent('download');
  await page.click('[role="menuitem"]:has-text("Download original")');
  assert.deepEqual(readFileSync(await (await download).path()), readFileSync(join(data, 'fixture.epub')));
  const card = page.locator('.card').filter({ has: page.locator('.card-author:has-text("PDF")') }).first();
  await card.hover();
  await card.locator('[aria-label^="Options"]').click();
  await page.click('[role="menuitem"]:has-text("Remove from shelf")');
  await eventually(async () => !(await api('/api/books')).some((b) => b.id === pdf));
});

test('real Kokoro narration and M4B export (needs a `--features narration` build)', { skip: !process.env.OMAREADER_TEST_TTS, timeout: 900000 }, async () => {
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
  await api(`/api/books/${epub}/audio/export`, 'POST');
  await eventually(async () => (await api(`/api/books/${epub}/audio`)).has_export, 30000);
  const file = join(data, 'lib', 'audio', epub, 'audiobook.m4b');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(Number(JSON.parse(probe.stdout).format.duration) > 1);
  await api(`/api/books/${epub}/audio`, 'DELETE');
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

test('live AI answers page, selection, and chosen chapter questions from the correct evidence', { skip: !process.env.OMAREADER_TEST_AI, timeout: 900000 }, async (t) => {
  writeFileSync(join(data, 'signals.md'), '# Harbor\n\nThe harbor signal is amber. Its keeper is Mara. The access phrase is copper otter.\n\n# Observatory\n\nThe observatory signal is violet. Its keeper is Ivo. The access phrase is silver badger.\n');
  const id = await upload('signals.md');
  const providers = (await api('/api/ai/providers')).providers.filter((p) => p.signed_in);
  assert.ok(providers.length, 'Live AI verification requires an authenticated provider');
  const pdfBook = await upload('mixed-pages.pdf');
  const pdfBlocks = await api(`/api/books/${pdfBook}/pages/1/blocks`);
  const cases = [
    { name: 'PDF page', book: pdfBook, body: { scope: 'page', page: 2, question: 'What page number does the text itself say? Answer with the page number and a citation.' }, expected: /2/, forbidden: /page 1/i, block: 0, page: 2 },
    { name: 'PDF selection', book: pdfBook, body: { scope: 'selection', block: pdfBlocks[0].seq, end_block: pdfBlocks.at(-1).seq, selection: 'Books belong on open shelves.', question: 'Where do books belong according to the selected text? Answer with the location and a citation.' }, expected: /open shelves/i, forbidden: /closed shelves/i, block: 0 },
    { name: 'page', body: { scope: 'page', block: 1, end_block: 1, question: 'What is the access phrase on this page? Give only the phrase and a citation.' }, expected: /copper otter/i, forbidden: /silver badger/i, block: 1 },
    { name: 'selection', body: { scope: 'selection', block: 1, end_block: 1, selection: 'Its keeper is Mara.', question: 'Who is the keeper named in the selected text? Give only the name and a citation.' }, expected: /Mara/, forbidden: /Ivo/, block: 1 },
    { name: 'chosen chapter', body: { scope: 'chapter', chapter: 1, block: 0, question: 'What is the access phrase in this chapter? Give only the phrase and a citation.' }, expected: /silver badger/i, forbidden: /copper otter/i, block: 2 },
    { name: 'unanswerable', body: { scope: 'selection', block: 1, selection: 'Its keeper is Mara.', question: 'What year was Mara born? If the provided text does not say, answer: Not stated in the selected text.' }, expected: /not stated/i, forbidden: /\b(?:19|20)\d\d\b/, block: 1 },
  ];
  for (const provider of providers) {
    await api('/api/settings', 'PUT', { ai_provider: provider.id, ai_model: '' });
    for (const item of cases) await t.test(`${provider.id}: ${item.name}`, async () => {
      const chat = await api(`/api/books/${item.book ?? id}/chats`, 'POST');
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
      if (item.page) assert.ok(answer.citations.every((c) => c.page === item.page));
      t.diagnostic(`${provider.id}, ${item.name}: ${answer.content}`);
    });
  }
});

test('the reader sends visible bounds, and a selected passage asks about exactly that text', async () => {
  await page.route('**/api/ai/providers*', signedIn());
  const sent = [];
  await page.route('**/api/chats/*/messages', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'text/event-stream', body: stream([{ type: 'delta', text: 'Test transport only.' }, { type: 'done', id: 1 }]) });
  });
  await page.goto(`${ORIGIN}/#/read/${epub}?b=0`);
  await page.waitForSelector('.prose p');
  await openPanel('q', '.ask-input textarea:not([disabled])');
  await page.selectOption('[aria-label="Question scope"]', 'page');
  await page.fill('.ask-input textarea', 'Explain the visible page');
  await page.click('[aria-label="Send question"]');
  await eventually(() => sent.length === 1);
  assert.equal(sent[0].scope, 'page');
  assert.ok(Number.isInteger(sent[0].block) && sent[0].end_block >= sent[0].block);
  await select(1);
  const quote = await page.locator('[data-b="1"]').textContent();
  await page.click('.selection-bar .ask-action');
  await page.waitForSelector('.attached');
  assert.equal(await page.inputValue('[aria-label="Question scope"]'), 'selection');
  await page.fill('.ask-input textarea', 'What does this selected passage mean?');
  await page.click('[aria-label="Send question"]');
  await eventually(() => sent.length === 2);
  assert.equal(sent[1].scope, 'selection');
  assert.equal(sent[1].block, 1);
  assert.equal(sent[1].end_block, 1);
  assert.equal(sent[1].selection, quote.trim().replace(/\s+/g, ' '));
  assert.equal(await page.locator('.attached').count(), 0);
  assert.equal(await page.inputValue('[aria-label="Question scope"]'), 'chapter');
  await page.unroute('**/api/chats/*/messages');
  await page.unroute('**/api/ai/providers*');
});

test('EPUB passage notes survive reflow, and failed saves keep a recoverable draft', async () => {
  await page.goto(`${ORIGIN}/#/read/${epub}?b=0`);
  await page.waitForSelector('.prose p');
  await select(2);
  const quote = (await page.locator('[data-b="2"]').textContent()).trim();
  await page.route('**/api/annotations/*', (route) => route.request().method() === 'PATCH' ? route.fulfill({ status: 500, json: { error: 'disk unavailable' } }) : route.continue());
  await page.click('.selection-bar button:has-text("Note")');
  await page.fill('.note.editing textarea', 'Reflow must keep this passage.');
  await page.waitForSelector('.note [role="status"]:has-text("Not saved")');
  assert.equal(await page.inputValue('.note.editing textarea'), 'Reflow must keep this passage.');
  await page.reload();
  await page.waitForSelector('.prose p');
  await openPanel('n', '.notes');
  await page.waitForSelector('.note-text:has-text("Reflow must keep this passage.")');
  await page.unroute('**/api/annotations/*');
  await page.click('.note-text:has-text("Reflow must keep this passage.")');
  await page.click('.note.editing button:has-text("Done")');
  await eventually(async () => (await api(`/api/annotations?book=${epub}`)).some((a) => a.note === 'Reflow must keep this passage.'));
  const annotation = (await api(`/api/annotations?book=${epub}`)).find((a) => a.quote === quote);
  assert.ok(annotation);
  for (const [font, size, leading, width, viewport] of [
    ['serif', 28, 2, 28, { width: 1100, height: 800 }],
    ['sans', 14, 1.3, 48, { width: 1600, height: 1000 }],
    ['mincho', 22, 1.7, 36, { width: 900, height: 1200 }],
  ]) {
    await api('/api/settings', 'PUT', { reader: { font, size, leading, width } });
    await page.setViewportSize(viewport);
    await page.reload();
    await page.waitForSelector('.prose p');
    await eventually(async () => page.evaluate((q) => [...(CSS.highlights.get('oma-yellow') ?? [])].some((r) => r.toString().trim() === q), quote));
  }
  await page.setViewportSize({ width: 1600, height: 900 });
});

test('clicking a highlight recolours or removes it in place', async () => {
  await api('/api/settings', 'PUT', { reader: { font: 'serif', size: 20, width: 34 } });
  await page.goto(`${ORIGIN}/#/read/${epub}?b=0`);
  await page.waitForSelector('.prose p');
  await select(3);
  await page.click('.selection-bar .dot.green');
  await eventually(async () => (await api(`/api/annotations?book=${epub}`)).some((a) => a.block === 3 && a.color === 'green'));
  // The server can have it before this page has painted it; click only what is on screen.
  const painted = (color) => eventually(() => page.evaluate((c) => (CSS.highlights.get(`oma-${c}`)?.size ?? 0) > 0, color));
  await painted('green');
  const point = await page.locator('[data-b="3"]').evaluate((element) => { const r = document.createRange(); r.selectNodeContents(element); const box = r.getClientRects()[0]; return { x: box.left + 10, y: box.top + box.height / 2 }; });
  await page.mouse.click(point.x, point.y);
  await page.waitForSelector('.selection-bar .dot.green.on');
  await page.click('.selection-bar .dot.pink');
  await eventually(async () => (await api(`/api/annotations?book=${epub}`)).some((a) => a.block === 3 && a.color === 'pink'));
  await painted('pink');
  await page.mouse.click(point.x, point.y);
  await page.waitForSelector('.selection-bar .dot.pink.on');
  await page.click('.selection-bar [aria-label="Remove highlight"]');
  await eventually(async () => !(await api(`/api/annotations?book=${epub}`)).some((a) => a.block === 3));
});

test('PDF notes keep normalized geometry through zoom and reopening', async () => {
  const id = await upload('mixed-pages.pdf');
  await page.goto(`${ORIGIN}/#/read/${id}?b=0`);
  await page.waitForFunction(() => document.querySelector('.textLayer')?.textContent.includes('open reading guide'));
  await page.locator('[data-page="1"] .textLayer').evaluate((layer) => {
    const span = [...layer.querySelectorAll('span')].find((s) => s.textContent.includes('Books belong'));
    const range = document.createRange(); range.selectNodeContents(span);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.click('.selection-bar button:has-text("Note")');
  await page.fill('.note.editing textarea', 'PDF geometry stays put.');
  await eventually(async () => (await api(`/api/annotations?book=${id}`)).some((a) => a.note === 'PDF geometry stays put.'));
  const saved = (await api(`/api/annotations?book=${id}`))[0];
  const rect = JSON.parse(saved.anchor).rects[0];
  for (const zoom of [.65, 1.65]) {
    await api('/api/settings', 'PUT', { reader: { zoom } });
    await page.reload();
    await page.waitForSelector('[data-page="1"] .pdf-mark');
    const normalized = await page.locator('[data-page="1"] .pdf-mark').first().evaluate((mark) => {
      const parent = mark.closest('.pdf-page').getBoundingClientRect(), r = mark.getBoundingClientRect();
      return [(r.left-parent.left)/parent.width, (r.top-parent.top)/parent.height, r.width/parent.width, r.height/parent.height];
    });
    normalized.forEach((v, i) => assert.ok(Math.abs(v - rect[i+1]) < .003));
    assert.equal((await api(`/api/annotations?book=${id}`))[0].note, 'PDF geometry stays put.');
  }
  await api('/api/settings', 'PUT', { reader: { zoom: 1 } });
  assert.deepEqual(errors, []);
});

test('stale EPUB offsets recover by quote or visibly refuse an unsafe attachment', async () => {
  let damaged = false;
  await page.route(`**/api/books/${epub}/sections/*`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.html = body.html.replace(/(<p[^>]*data-b="2"[^>]*>)([\s\S]*?)(<\/p>)/, (_, open, text, close) => open + (damaged ? 'This paragraph was replaced.' : 'Inserted before the original. ' + text) + close);
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${ORIGIN}/#/read/${epub}?b=0`);
  await page.waitForSelector('.prose p');
  await eventually(async () => page.evaluate(() => [...(CSS.highlights.get('oma-yellow') ?? [])].some((r) => r.toString().startsWith('A book on your disk'))));
  damaged = true;
  await page.reload();
  await page.waitForSelector('.annotation-warning');
  const highlights = await page.evaluate(() => [...(CSS.highlights.get('oma-yellow') ?? [])].map((r) => r.toString()));
  assert.ok(!highlights.some((text) => text.includes('This paragraph was replaced')));
  assert.ok((await api(`/api/annotations?book=${epub}`)).some((a) => a.note === 'Reflow must keep this passage.'));
  await page.unroute(`**/api/books/${epub}/sections/*`);
});

test('appearance changes persist, and PDF zoom resizes pages', async () => {
  await page.goto(`${ORIGIN}/#/read/${epub}?b=0`);
  await page.waitForSelector('.prose p');
  const start = parseFloat(await page.locator('.prose p').first().evaluate((p) => getComputedStyle(p).fontSize));
  await page.click('[aria-label="Appearance"]');
  await page.click('[aria-label="More size"]');
  await eventually(async () => (await api('/api/settings')).reader.size === start + 1);
  assert.equal(await page.locator('.prose p').first().evaluate((p) => getComputedStyle(p).fontSize), `${start + 1}px`);
  await page.click('.segmented button:has-text("Night")');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'night');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForSelector('.prose p');
  assert.equal(await page.locator('.prose p').first().evaluate((p) => getComputedStyle(p).fontSize), `${start + 1}px`);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'night');
  await page.click('[aria-label="Appearance"]');
  await page.click('.segmented button:has-text("Auto")');
  await page.click('[aria-label="Less size"]');
  await eventually(async () => (await api('/api/settings')).reader.size === start);
  await page.keyboard.press('Escape');
  const id = await upload('mixed-pages.pdf');
  await page.goto(`${ORIGIN}/#/read/${id}?b=0`);
  await page.waitForSelector('.pdf-page canvas');
  const width = () => page.locator('.pdf-page').first().evaluate((p) => p.getBoundingClientRect().width);
  const before = await width();
  await page.click('[aria-label="Appearance"]');
  await page.click('[aria-label="More zoom"]');
  await eventually(async () => (await width()) > before * 1.05);
  await page.click('[aria-label="Less zoom"]');
  await eventually(async () => Math.abs((await width()) - before) < 2);
  assert.deepEqual(errors, []);
});

test('answers keep citations, save to notes, and attached passages can be removed', async () => {
  await page.evaluate((id) => localStorage.removeItem(`koyo:ask-draft:${id}`), epub);
  await page.route('**/api/ai/providers*', signedIn([{ id: 'test', label: 'Test model' }]));
  await page.goto(`${ORIGIN}/#/read/${epub}?b=0`);
  await page.waitForSelector('.prose p');
  await openPanel('q', '.ask-input textarea:not([disabled])');
  if (await page.locator('[aria-label="New conversation"]:not([disabled])').count()) await page.click('[aria-label="New conversation"]');
  await page.waitForSelector('.suggestions');
  await page.route('**/api/chats/*/messages', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.fulfill({ contentType: 'text/event-stream', body: stream([
      { type: 'citations', citations: [{ n: 1, block: 1, page: 0, chapter: 'Open Shelves', quote: 'Reading should belong to everyone.' }] },
      { type: 'delta', text: 'The passage treats reading as something everyone should have access to. [1]' },
      { type: 'done', id: 1 },
    ]) });
  });
  await page.fill('.ask-input textarea', 'What does the passage say about the reader?');
  await page.click('[aria-label="Send question"]');
  await page.waitForSelector('.answer .cite');
  assert.ok((await page.locator('.answer').evaluate((e) => getComputedStyle(e).fontFamily)).includes('Literata'));
  await page.click('.answer button:has-text("Save to notes")');
  await eventually(async () => (await api(`/api/annotations?book=${epub}`)).some((n) => n.note.includes('Reading should belong to everyone.') && n.block === 1));
  await page.click('.answer .cite');
  await page.waitForSelector('[data-b="1"].flash');
  await select(2);
  await page.click('.selection-bar .ask-action');
  await page.waitForSelector('.attached');
  if (process.env.OMAREADER_CHAT_SCREENSHOT) await page.screenshot({ path: process.env.OMAREADER_CHAT_SCREENSHOT });
  await page.click('[aria-label="Remove passage"]');
  assert.equal(await page.locator('.attached').count(), 0);
  assert.equal(await page.inputValue('[aria-label="Question scope"]'), 'chapter');
  await page.click('[aria-label="New conversation"]');
  assert.equal(await page.locator('.answer').count(), 0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('n');
  await page.waitForSelector('.note-kind:has-text("Saved answer")');
  await page.unroute('**/api/chats/*/messages');
  await page.unroute('**/api/ai/providers*');
  assert.deepEqual(errors, []);
});

test('an attached passage survives navigation, and missing providers keep the question', async () => {
  await page.route('**/api/ai/providers*', signedIn());
  await page.goto(`${ORIGIN}/#/read/${epub}?b=0`);
  await page.waitForSelector('.prose p');
  const sent = [];
  await page.route('**/api/chats/*/messages', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'text/event-stream', body: stream([{ type: 'context', context: { scope: 'chapter', partial: true } }, { type: 'delta', text: 'Only some passages were supplied. [99]' }, { type: 'done', id: 1 }]) });
  });
  await select(1);
  await page.click('.selection-bar .ask-action');
  assert.equal(sent.length, 0);
  await page.selectOption('[aria-label="Question scope"]', 'chapter');
  await page.click('.prose a:has-text("Next chapter")');
  await page.waitForFunction(() => document.querySelector('.prose h1')?.textContent === 'Room for Everyone');
  await page.fill('.ask-input textarea', 'Compare this chapter with my attached passage.');
  await page.click('[aria-label="Send question"]');
  await eventually(() => sent.length === 1);
  assert.equal(sent[0].attachment.block, 1);
  assert.equal(sent[0].chapter, 1);
  await page.waitForSelector('.answer .hint:has-text("partial")');
  assert.equal(await page.locator('[data-cite="99"]').count(), 0);
  await page.fill('.ask-input textarea', 'Keep this question until a tool is ready.');
  await page.unroute('**/api/chats/*/messages');
  await page.unroute('**/api/ai/providers*');
  await page.route('**/api/ai/providers*', (route) => route.fulfill({ json: { providers: [{ id: 'claude', name: 'Claude Code', installed: false, signed_in: false, models: [], help: 'Install Claude Code.' }], selected: null, model: '' } }));
  await page.reload();
  await page.waitForSelector('.setup button:has-text("Check again")');
  assert.equal(await page.inputValue('.ask-input textarea'), 'Keep this question until a tool is ready.');
  assert.ok(await page.locator('.prose p').first().isVisible());
  await page.unroute('**/api/ai/providers*');
  await page.evaluate((id) => localStorage.removeItem(`koyo:ask-draft:${id}`), epub);
  assert.deepEqual(errors, []);
});

test('narrow and portrait windows keep reading, the companion card and the shelf usable', async () => {
  for (const viewport of [{ width: 820, height: 1180 }, { width: 420, height: 860 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${ORIGIN}/#/library`);
    await page.waitForSelector('.card');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.goto(`${ORIGIN}/#/read/${epub}?b=0`);
    await page.waitForSelector('.prose p');
    await openPanel('q', '.ask-input textarea');
    assert.ok(await page.locator('.ask-input textarea').isVisible());
    const box = await page.locator('.panel:not([hidden])').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1);
    await page.locator('[aria-label="Close panel"]').click();
    await page.waitForSelector('.panel', { state: 'hidden' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.setViewportSize({ width: 1600, height: 900 });
});

test('managed books and notes survive server restart after deleting the imported source', async () => {
  const library = join(data, 'persistent-library');
  let child;
  const launch = async () => {
    child = spawn(binary, ['serve', '0'], { env: { ...process.env, OMAREADER_DATA_DIR: library }, stdio: 'pipe' });
    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      const timer = setTimeout(() => reject(new Error(`restart timed out: ${stderr}`)), 15000);
      child.stderr.on('data', (d) => { stderr += d; });
      child.stdout.on('data', (d) => { stdout += d; if (stdout.includes('\n')) { clearTimeout(timer); resolve(new URL(stdout.split('\n')[0].trim())); } });
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited: ${code} ${stderr}`)); });
    });
  };
  const stop = async () => {
    if (child && child.exitCode === null) { const ended = new Promise((r) => child.once('exit', r)); child.kill(); await ended; }
  };
  try {
    let url = await launch();
    const call = async (path, method = 'GET', body, extra = {}) => {
      const response = await fetch(`${url.origin}${path}`, { method, headers: { Cookie: `oma_session=${url.searchParams.get('t')}`, Origin: url.origin, 'Content-Type': 'application/json', ...extra }, body });
      assert.ok(response.ok, `${path}: ${response.status}`);
      return response;
    };
    const original = join(data, 'persistent-source.md');
    const text = '# A book to keep\n\nThis original file can go away. The imported book stays on the shelf.\n';
    writeFileSync(original, text);
    const imported = await (await call('/api/books', 'POST', readFileSync(original), { 'x-file-name': 'persistent-source.md', 'Content-Type': 'application/octet-stream' })).json();
    const id = imported.id;
    await eventually(async () => (await (await call(`/api/books/${id}`)).json()).status === 'ready');
    await call('/api/annotations', 'POST', JSON.stringify({ book_id: id, kind: 'highlight', color: 'yellow', block: 1, page: 0, quote: 'This original file can go away.', note: 'My notes survive too.', anchor: { kind: 'bookmark', block: 1, page: 0 } }));
    await call(`/api/books/${id}/position`, 'PUT', JSON.stringify({ block: 1, fraction: 0.3, page: 0 }));
    rmSync(original);
    await stop();
    url = await launch();
    const book = await (await call(`/api/books/${id}`)).json();
    assert.equal(book.status, 'ready');
    assert.equal(book.position.block, 1);
    assert.equal(book.position.fraction, 0.3);
    assert.equal(await (await call(`/api/books/${id}/file`)).text(), text);
    const notes = await (await call(`/api/annotations?book=${id}`)).json();
    assert.ok(notes.some((n) => n.note === 'My notes survive too.'));
  } finally { await stop(); }
});

test('resizing the window preserves a mid-book location', async () => {
  writeFileSync(join(data, 'reflow.md'), '# A long chapter\n\n' + Array.from({ length: 100 }, (_, i) => `Paragraph ${i}. ${'Long-form reading keeps its place when the margin moves. '.repeat(12)}`).join('\n\n'));
  const id = await upload('reflow.md');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${ORIGIN}/#/read/${id}?b=50`);
  await page.waitForSelector('[data-b="50"]');
  await eventually(async () => (await api(`/api/books/${id}`)).position?.block === 50);
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.waitForTimeout(900);
  assert.equal((await api(`/api/books/${id}`)).position.block, 50);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const pdfId = await upload('mixed-pages.pdf');
  await page.goto(`${ORIGIN}/#/read/${pdfId}?b=0&p=2`);
  await page.waitForSelector('.pdf-page canvas');
  await eventually(async () => (await api(`/api/books/${pdfId}`)).position?.page === 2);
  await page.setViewportSize({ width: 1000, height: 1000 });
  await page.waitForTimeout(900);
  assert.equal((await api(`/api/books/${pdfId}`)).position.page, 2);
  await page.setViewportSize({ width: 1600, height: 900 });
  if (process.env.OMAREADER_SCREENSHOT) {
    await page.goto(`${ORIGIN}/#/read/${epub}?b=0`);
    await page.waitForSelector('.prose p');
    await page.screenshot({ path: process.env.OMAREADER_SCREENSHOT });
  }
  assert.deepEqual(errors, []);
});
