import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const chromium = process.env.QRATOR_CHROMIUM || '/usr/bin/chromium-browser';

class PipeCdp {
  constructor(profileDirectory) {
    this.buffer = '';
    this.closing = false;
    this.events = [];
    this.failure = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.process = spawn(chromium, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-domain-reliability',
      '--disable-features=OptimizationHints,MediaRouter',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-pipe',
      `--user-data-dir=${profileDirectory}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    this.closed = new Promise((resolve) => this.process.once('close', resolve));
    this.process.stdio[4].on('data', (chunk) => this.#receive(chunk));
    this.process.stdio[3].on('error', (error) => this.#fail(`CDP input pipe failed: ${error.message}`));
    this.process.stdio[4].on('error', (error) => this.#fail(`CDP output pipe failed: ${error.message}`));
    this.process.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-4_000);
    });
    this.process.once('error', (error) => this.#fail(`could not start ${chromium}: ${error.message}`));
    this.process.once('exit', (code, signal) => {
      if (!this.closing) this.#fail(`Chromium exited before the audit completed (code=${code}, signal=${signal})`);
    });
  }

  #receive(chunk) {
    try {
      this.buffer += chunk.toString('utf8');
      for (;;) {
        const boundary = this.buffer.indexOf('\0');
        if (boundary === -1) return;
        const raw = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 1);
        if (!raw) continue;
        const message = JSON.parse(raw);
        if (!message.id) {
          this.events.push(message);
          continue;
        }
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    } catch (error) {
      this.#fail(`invalid CDP response: ${error.message}`);
    }
  }

  #fail(reason) {
    if (this.failure) return;
    const detail = this.stderr.trim();
    this.failure = new Error([
      `Headless Chromium startup/CDP failure: ${reason}.`,
      detail ? `Chromium stderr:\n${detail}` : 'Chromium produced no stderr.',
      'Run this browser regression outside restricted sandboxes or set QRATOR_CHROMIUM to a working Chromium binary.',
    ].join('\n'));
    for (const waiter of this.pending.values()) waiter.reject(this.failure);
    this.pending.clear();
  }

  send(method, params = {}, sessionId) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    try {
      this.process.stdio[3].write(`${JSON.stringify(message)}\0`, (error) => {
        if (error) this.#fail(`could not write ${method} to the CDP pipe: ${error.message}`);
      });
    } catch (error) {
      this.#fail(`could not write ${method} to the CDP pipe: ${error.message}`);
    }
    return response;
  }

  async close() {
    this.closing = true;
    if (this.process.exitCode === null && this.process.signalCode === null) {
      try {
        this.process.kill('SIGTERM');
      } catch {
        // An early spawn failure is already captured with actionable detail.
      }
    }
    await this.closed;
  }
}

function send(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src https://w.soundcloud.com https://open.spotify.com; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function scenario(req) {
  try {
    return new URL(req.headers.referer).searchParams.get('case') || 'normal';
  } catch {
    return 'normal';
  }
}

async function createMockServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', await readFile(path.join(publicDir, 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/app.js') {
      return send(res, 200, 'text/javascript; charset=utf-8', await readFile(path.join(publicDir, 'app.js')));
    }
    if (req.method === 'GET' && url.pathname === '/styles.css') {
      return send(res, 200, 'text/css; charset=utf-8', await readFile(path.join(publicDir, 'styles.css')));
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const mode = scenario(req);
      if (mode === 'slow-status') await new Promise((resolve) => setTimeout(resolve, 600));
      if (mode === 'failed-status') return json(res, 503, { error: 'Synthetic status failure.' });
      if (mode === 'non-json-status') return send(res, 200, 'text/plain; charset=utf-8', 'not json');
      return json(res, 200, {
        configured: false,
        authenticated: false,
        lastfmConfigured: false,
        listenbrainzAvailable: true,
        soundcloudConfigured: false,
        redirectUri: 'http://127.0.0.1/callback',
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/profile') {
      if (scenario(req) === 'slow-profile') await new Promise((resolve) => setTimeout(resolve, 600));
      return json(res, 200, {
        schema_version: 1,
        usedForRanking: true,
        summary: { total: 0, kept: 0, skipped: 0, artists: [], sources: [] },
        judgments: [],
      });
    }
    if (req.method === 'PUT' && url.pathname === '/api/profile/judgments') {
      return json(res, 200, {
        judgment: { archive_id: 'synthetic-first', preference: 'keep' },
        profile: {
          schema_version: 1,
          usedForRanking: true,
          summary: { total: 1, kept: 1, skipped: 0, artists: [], sources: [] },
          judgments: [],
        },
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/discover/playback') {
      return json(res, 422, { error: 'Synthetic playback unavailable.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/discover') {
      if (scenario(req) === 'successful-discovery') {
        return json(res, 200, {
          runId: 'synthetic-success',
          mode: 'distill',
          total: 2,
          resolved: 0,
          playlist: 'Synthetic Artist — First Track\nSecond Artist — Second Track',
          sources: 'Synthetic fixture shelf',
          unresolved: '',
          log: 'Synthetic successful discovery.',
          items: [
            {
              archive_id: 'synthetic-first',
              artist: 'Synthetic Artist',
              title: 'First Track',
              album: 'Fixture One',
              why: 'Found on the synthetic fixture shelf.',
              shelf_confidence: 0.8,
              discovery_distance: 'one shelf hop',
              recording_confidence: 0.9,
              spotify_uri: null,
              soundcloud_url: null,
              musicbrainz_id: null,
            },
            {
              archive_id: 'synthetic-second',
              artist: 'Second Artist',
              title: 'Second Track',
              album: 'Fixture Two',
              why: 'Found beside the first synthetic track.',
              shelf_confidence: 0.7,
              discovery_distance: 'one shelf hop',
              recording_confidence: 0.8,
              spotify_uri: null,
              soundcloud_url: null,
              musicbrainz_id: null,
            },
          ],
        });
      }
      return json(res, 503, { error: 'Synthetic discovery stop.' });
    }
    return json(res, 404, { error: 'Synthetic route not found.' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeDisposableProfile(profile) {
  await rm(profile, { recursive: true, force: true });
  await assert.rejects(access(profile), (error) => error.code === 'ENOENT');
}

async function evaluate(cdp, sessionId, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId);
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}

async function waitFor(cdp, sessionId, expression, timeout = 3_000) {
  const started = Date.now();
  for (;;) {
    if (await evaluate(cdp, sessionId, `Boolean(${expression})`)) return;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${expression}`);
    await wait(25);
  }
}

async function openPage(cdp, base, mode, viewport) {
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId);
  await cdp.send('Page.navigate', { url: `${base}/?case=${mode}` }, sessionId);
  await waitFor(cdp, sessionId, `document.documentElement?.dataset.qratorReady === 'true'`);
  return sessionId;
}

test('startup I/O cannot block handlers or credential-free discovery', { timeout: 30_000 }, async (context) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'qrator-ui-startup-'));
  context.after(() => removeDisposableProfile(profile));
  let server;
  let cdp;

  try {
    server = await createMockServer();
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    cdp = new PipeCdp(profile);
    const viewports = [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
    ];
    const modes = ['failed-status', 'non-json-status', 'slow-status', 'slow-profile'];

    for (const viewport of viewports) {
      for (const mode of modes) {
        const sessionId = await openPage(cdp, base, mode, viewport);

        // Interact before either delayed startup response could finish.
        const early = await evaluate(cdp, sessionId, `(() => {
          const manualTab = [...document.querySelectorAll('.tab')].find((tab) => tab.dataset.view === 'manual');
          manualTab.click();
          const manualWorked = document.querySelector('#manual-view').classList.contains('active');
          [...document.querySelectorAll('.tab')].find((tab) => tab.dataset.view === 'discover').click();
          document.querySelector('#discover-query').value = 'Seed One\\nSeed Two';
          let submitPrevented = null;
          document.querySelector('#discover-form').addEventListener('submit', (event) => {
            submitPrevented = event.defaultPrevented;
          }, { once: true });
          document.querySelector('#discover-button').click();
          return {
            manualWorked,
            submitPrevented,
            location: location.href,
            buttonDisabled: document.querySelector('#discover-button').disabled,
          };
        })()`);

        assert.equal(early.manualWorked, true, `${mode} ${viewport.width}: tabs should bind before startup I/O`);
        assert.equal(early.submitPrevented, true, `${mode} ${viewport.width}: form submit should be intercepted`);
        assert.equal(early.location, `${base}/?case=${mode}`, `${mode} ${viewport.width}: form must not navigate`);
        assert.equal(early.buttonDisabled, true, `${mode} ${viewport.width}: credential-free discovery handler should run`);

        if (mode === 'failed-status' || mode === 'non-json-status') {
          await waitFor(cdp, sessionId, `document.querySelector('#status').textContent.includes('SoundCloud user-shelf discovery status unknown')`);
          const degraded = await evaluate(cdp, sessionId, `({
            status: document.querySelector('#status').textContent,
            profile: document.querySelector('#profile-output').textContent
          })`);
          assert.equal(
            degraded.status,
            'Provider status unavailable / SoundCloud user-shelf discovery status unknown',
          );
          assert.match(degraded.profile, /Judge tracks in Discover/);
        } else {
          await waitFor(cdp, sessionId, `document.querySelector('#status').textContent.includes('Spotify credentials required')`);
          const successfulStatus = await evaluate(cdp, sessionId, `document.querySelector('#status').textContent`);
          assert.equal(successfulStatus, 'Spotify credentials required / SoundCloud credentials required / Connect SoundCloud for user-shelf discovery');
          if (mode === 'slow-profile') {
            await waitFor(cdp, sessionId, `document.querySelector('#profile-output').textContent.includes('Judge tracks in Discover')`);
          }
        }
      }
    }

    for (const viewport of viewports) {
      const sessionId = await openPage(cdp, base, 'successful-discovery', viewport);
      const before = await evaluate(cdp, sessionId, `(() => {
        const empty = document.querySelector('#discover-empty');
        const output = document.querySelector('#discover-output');
        return {
          emptyHidden: empty.hidden,
          emptyDisplay: getComputedStyle(empty).display,
          emptyHeight: empty.getBoundingClientRect().height,
          outputHidden: output.hidden,
          outputDisplay: getComputedStyle(output).display,
          outputHeight: output.getBoundingClientRect().height,
        };
      })()`);

      assert.equal(before.emptyHidden, false, `${viewport.width}: pre-run empty state should be enabled`);
      assert.notEqual(before.emptyDisplay, 'none', `${viewport.width}: pre-run empty state should render`);
      assert.ok(before.emptyHeight > 0, `${viewport.width}: pre-run empty state should occupy space`);
      assert.equal(before.outputHidden, true, `${viewport.width}: pre-run output should be hidden`);
      assert.equal(before.outputDisplay, 'none', `${viewport.width}: hidden pre-run output should not render`);
      assert.equal(before.outputHeight, 0, `${viewport.width}: hidden pre-run output should occupy no space`);

      await evaluate(cdp, sessionId, `(() => {
        document.querySelector('#discover-query').value = 'Synthetic Artist\\nSecond Artist';
        document.querySelector('#discover-button').click();
      })()`);
      await waitFor(cdp, sessionId, `document.querySelector('#result-title').textContent === 'Seed shortlist'`);

      const after = await evaluate(cdp, sessionId, `(() => {
        const empty = document.querySelector('#discover-empty');
        const output = document.querySelector('#discover-output');
        const actions = output.querySelector('.result-actions');
        const shortlist = output.querySelector('.candidate-list');
        return {
          emptyHidden: empty.hidden,
          emptyDisplay: getComputedStyle(empty).display,
          emptyHeight: empty.getBoundingClientRect().height,
          outputHidden: output.hidden,
          outputDisplay: getComputedStyle(output).display,
          outputHeight: output.getBoundingClientRect().height,
          actionTop: actions?.getBoundingClientRect().top,
          shortlistTop: shortlist?.getBoundingClientRect().top,
          candidates: shortlist?.children.length,
        };
      })()`);

      assert.equal(after.emptyHidden, true, `${viewport.width}: successful discovery should set hidden`);
      assert.equal(after.emptyDisplay, 'none', `${viewport.width}: hidden empty state must not render`);
      assert.equal(after.emptyHeight, 0, `${viewport.width}: hidden empty state must occupy no space`);
      assert.equal(after.outputHidden, false, `${viewport.width}: successful output should be enabled`);
      assert.notEqual(after.outputDisplay, 'none', `${viewport.width}: successful output should render`);
      assert.ok(after.outputHeight > 0, `${viewport.width}: successful output should occupy space`);
      assert.equal(after.candidates, 2, `${viewport.width}: synthetic shortlist should render`);
      assert.ok(
        after.actionTop >= 0 && after.actionTop < viewport.height,
        `${viewport.width}: action region should start inside the viewport`,
      );
      assert.ok(
        after.shortlistTop >= 0 && after.shortlistTop < viewport.height,
        `${viewport.width}: shortlist should start inside the viewport`,
      );

      const publishActions = await evaluate(cdp, sessionId, `([...document.querySelectorAll('.result-actions button')].map((button) => button.textContent))`);
      assert.equal(publishActions.includes('Publish to SoundCloud'), true, `${viewport.width}: SoundCloud publishing should be a first-class shortlist action`);
      await evaluate(cdp, sessionId, `([...document.querySelectorAll('.result-actions button')].find((button) => button.textContent === 'Publish to SoundCloud').click())`);
      assert.equal(
        await evaluate(cdp, sessionId, `document.querySelector('.publish-bar button[type="submit"]').textContent`),
        'Publish 2 to SoundCloud',
        `${viewport.width}: SoundCloud publish form should target the current reviewed mix directly`,
      );

      await evaluate(cdp, sessionId, `document.querySelector('.play-button').click()`);
      await waitFor(cdp, sessionId, `document.querySelector('#player-provider').textContent === 'Playback unavailable'`);
      const playerFailure = await evaluate(cdp, sessionId, `({
        visible: !document.querySelector('#player-shell').hidden,
        status: document.querySelector('#player-status').textContent,
        frames: document.querySelectorAll('#player-frame iframe').length
      })`);
      assert.equal(playerFailure.visible, true, `${viewport.width}: play action should open the stable player panel`);
      assert.equal(playerFailure.status, 'Synthetic playback unavailable.');
      assert.equal(playerFailure.frames, 0, `${viewport.width}: failed resolution must not load a provider frame`);
      await evaluate(cdp, sessionId, `document.querySelector('#player-close').click()`);
      assert.equal(await evaluate(cdp, sessionId, `document.querySelector('#player-shell').hidden`), true);

      const ratingSelector = viewport.width === 1920
        ? `.candidate:first-child .candidate-review button:nth-child(2)`
        : `.candidate:last-child .candidate-review button:nth-child(2)`;
      const expectedNextTitle = viewport.width === 1920 ? 'Second Track' : 'First Track';
      await evaluate(cdp, sessionId, `document.querySelector(${JSON.stringify(ratingSelector)}).click()`);
      await waitFor(cdp, sessionId, `document.querySelector('#player-title').textContent === ${JSON.stringify(expectedNextTitle)}`);
      await waitFor(cdp, sessionId, `document.querySelector('#player-status').textContent === 'Synthetic playback unavailable.'`);
      assert.equal(
        await evaluate(cdp, sessionId, `document.querySelector('#player-status').textContent`),
        'Synthetic playback unavailable.',
        `${viewport.width}: taste judgment should advance to the next unreviewed track, wrapping when needed`,
      );
    }

    const outbound = cdp.events
      .filter((event) => event.method === 'Network.requestWillBeSent')
      .map((event) => event.params.request.url)
      .filter((url) => /^https?:/.test(url))
      .filter((url) => new URL(url).hostname !== '127.0.0.1');
    assert.deepEqual(outbound, [], 'browser regression must not make non-loopback requests');
  } finally {
    try {
      if (cdp) await cdp.close();
    } finally {
      try {
        if (server) await new Promise((resolve) => server.close(resolve));
      } finally {
        await removeDisposableProfile(profile);
      }
    }
  }
});
