import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const extension = resolve('dist');
const bufferWait = process.argv.includes('--buffer-wait');
const profileRoot = resolve('../data');
const profile = mkdtempSync(resolve(profileRoot, 'playwright-youtube-'));
const pairing = JSON.parse(readFileSync(resolve('../data/pairing.json'), 'utf8'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    '--autoplay-policy=no-user-gesture-required'],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const id = new URL(worker.url()).host;
  const stalePopup = await context.newPage();
  await stalePopup.goto(`chrome-extension://${id}/popup.html`);
  await stalePopup.evaluate(() => chrome.storage.local.set({ token: 'credencial-anterior' }));
  await stalePopup.reload();
  await stalePopup.getByRole('button', { name: 'Vincular servicio' }).waitFor({ timeout: 10000 });
  await stalePopup.getByText('Volvé a vincular el servicio').waitFor();
  await stalePopup.close();
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  assert.ok(pairing.token, 'El servicio de pruebas debe estar vinculado previamente');
  await options.evaluate((token) => chrome.storage.local.set({ token }), pairing.token);
  await options.reload();
  await options.locator('#available-voice').filter({ hasText: 'El doblaje usa la voz del video' }).waitFor({ timeout: 10000 });

  const youtube = await context.newPage();
  await youtube.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await youtube.locator('video.html5-main-video').waitFor({ timeout: 45000 });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByRole('button', { name: 'Doblar este video' }).waitFor({ timeout: 10000 });
  await popup.locator('#dub-volume').evaluate((slider) => {
    slider.value = '65';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await popup.waitForFunction(async () =>
    (await chrome.storage.local.get('dubVolume')).dubVolume === 0.65, null, { timeout: 5000 });
  const volumeStatus = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'UI_STATUS' }));
  assert.equal(volumeStatus.dubVolume, 0.65, `El worker no recibió el volumen: ${JSON.stringify(volumeStatus)}`);
  await youtube.bringToFront();
  await popup.waitForFunction(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    try { return Boolean(await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PLAYER' })); }
    catch { return false; }
  }, null, { timeout: 20000 });
  await youtube.locator('video.html5-main-video').evaluate(async (video) => {
    video.currentTime = 0;
    await video.play();
  });
  const result = await popup.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.runtime.sendMessage({ type: 'START', tabId: tabs[0].id });
  });
  if (result?.error) throw new Error(result.error);
  assert.equal(result.video_id, 'jNQXAC9IVRw');
  await youtube.locator('#doblaje-local-overlay').waitFor({ timeout: 30000 });
  await popup.waitForFunction(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const state = await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PLAYER' });
    return state.ready_through_ms >= 4000;
  }, null, { timeout: 90000 });
  await youtube.bringToFront();
  await youtube.locator('video.html5-main-video').evaluate(async (video) => {
    if (video.paused) await video.play();
  });
  try {
    await youtube.waitForFunction(() => document.querySelector('#doblaje-local-overlay')?.textContent?.includes('elefantes'),
      null, { timeout: 30000 });
  } catch (error) {
    const videoState = await youtube.evaluate(() => ({ position: document.querySelector('video')?.currentTime,
      paused: document.querySelector('video')?.paused,
      overlay: document.querySelector('#doblaje-local-overlay')?.textContent,
      player_class: document.querySelector('.html5-video-player')?.className,
      button: document.querySelector('.ytp-play-button')?.getAttribute('aria-label') }));
    const audioState = await popup.evaluate(() => chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_DIAG' }));
    const workerState = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'UI_STATUS' }));
    const contentState = await popup.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PLAYER' });
    });
    console.error(JSON.stringify({ videoState, audioState, workerState, contentState }));
    throw error;
  }
  let audioDiag;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    audioDiag = await popup.evaluate(() => chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_DIAG' }));
    if (audioDiag?.playing_id && audioDiag.audio_context === 'running') break;
    await youtube.waitForTimeout(250);
  }
  assert.ok(audioDiag?.playing_id, `El WAV no se estaba reproduciendo: ${JSON.stringify(audioDiag)}`);
  assert.equal(audioDiag.audio_context, 'running');
  assert.ok(Math.abs(audioDiag.volume - 0.65) < 0.001, `Volumen incorrecto: ${JSON.stringify(audioDiag)}`);
  assert.ok(audioDiag.playing_start_ms >= 800 && audioDiag.playing_start_ms <= 1100,
    `El comienzo no siguió la voz original: ${JSON.stringify(audioDiag)}`);
  assert.ok(typeof audioDiag.sync_error_ms === 'number' && Math.abs(audioDiag.sync_error_ms) < 160,
    `El doblaje quedó fuera de tiempo: ${JSON.stringify(audioDiag)}`);
  const report = await youtube.evaluate(() => ({
    video_position: document.querySelector('video')?.currentTime,
    overlay: document.querySelector('#doblaje-local-overlay')?.textContent,
    video_volume: document.querySelector('video')?.volume,
    video_muted: document.querySelector('video')?.muted,
  }));
  assert.ok(report.video_muted || report.video_volume === 0, 'El audio original siguió activo');
  console.log(JSON.stringify({ extension_id: id, ...report, audio: audioDiag }));
  await youtube.screenshot({ path: resolve('../reports/youtube-e2e.png') });
  if (bufferWait) {
    const holdAt = Math.round(report.video_position * 1000) + 350;
    await popup.evaluate(({ tabId, generation, holdAt }) =>
      chrome.tabs.sendMessage(tabId, { type: 'SEGMENT_TEXT', event: { generation, payload: {
        segment_id: 'long-synthetic-phrase', start_ms: holdAt - 500, end_ms: holdAt,
        sync_deadline_ms: holdAt, rendered_duration_ms: 20000,
        text_es_ar: 'Prueba de frase larga sin pausa automática',
      } } }), { tabId: result.tab_id, generation: result.generation, holdAt });
    await popup.evaluate(({ tabId, generation, holdAt }) =>
      chrome.tabs.sendMessage(tabId, { type: 'BUFFER_STATUS', generation,
        ready_through_ms: holdAt + 100, eof: false }),
    { tabId: result.tab_id, generation: result.generation, holdAt });
    await youtube.waitForFunction(() => document.querySelector('video.html5-main-video')?.paused,
      null, { timeout: 5000 });
    await popup.evaluate(({ tabId, generation }) => chrome.tabs.sendMessage(tabId, {
      type: 'BUFFER_STATUS', generation, ready_through_ms: 30000, eof: false,
    }), { tabId: result.tab_id, generation: result.generation });
    await youtube.waitForFunction(() => !document.querySelector('video.html5-main-video')?.paused,
      null, { timeout: 5000 });
    await youtube.waitForFunction((holdAt) =>
      document.querySelector('video.html5-main-video')?.currentTime * 1000 > holdAt + 1500,
    holdAt, { timeout: 5000 });
    console.log(JSON.stringify({ buffer_wait: true, phrase_did_not_pause: true }));
  } else {
    await youtube.locator('.ytp-play-button').click();
    await youtube.waitForFunction(() => document.querySelector('video')?.paused, null, { timeout: 3000 });
    await popup.waitForFunction(async () => {
      const state = await chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_DIAG' });
      return state && !state.playing_id;
    }, null, { timeout: 3000 });
    await youtube.locator('.ytp-play-button').click();
    await popup.waitForFunction(async () => {
      const state = await chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_DIAG' });
      return state?.playing_id && typeof state.sync_error_ms === 'number' && Math.abs(state.sync_error_ms) < 160;
    }, null, { timeout: 5000 });
    await youtube.waitForFunction(() => (document.querySelector('video')?.currentTime || 0) >= 3.5,
      null, { timeout: 10000 });
    assert.equal(await youtube.locator('video.html5-main-video').evaluate((video) => video.paused), false,
      'El video se congeló al final del primer subtítulo aunque había silencio antes de la siguiente frase');
  }
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
  await youtube.waitForFunction(() => {
    const video = document.querySelector('video');
    return video && video.volume > 0 && !video.muted;
  }, null, { timeout: 5000 });
} finally {
  await context.close();
  if (dirname(profile) !== profileRoot || !basename(profile).startsWith('playwright-youtube-'))
    throw new Error('Ruta del perfil temporal inesperada');
  rmSync(profile, { recursive: true, force: true });
}
