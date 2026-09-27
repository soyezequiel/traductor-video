import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<div class="html5-video-player"><video class="html5-main-video"></video><button class="ytp-play-button">Pausa</button></div>');
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const context = canvas.getContext('2d');
    context.fillRect(0, 0, 16, 16);
    let frame = 0;
    setInterval(() => {
      context.fillStyle = frame++ % 2 ? '#000' : '#fff';
      context.fillRect(0, 0, 16, 16);
    }, 33);
    const video = document.querySelector('video');
    video.srcObject = canvas.captureStream(30);
    document.querySelector('button').addEventListener('click', () => {
      if (video.paused) void video.play();
      else video.pause();
    });
    window.chrome = { runtime: {
      onMessage: { addListener: listener => { window.contentMessage = listener; } },
      sendMessage: async () => ({ ok: true }),
    } };
    await video.play();
  });
  await page.addScriptTag({ path: resolve('dist/content.js') });
  await page.evaluate(() => {
    window.contentMessage({ type: 'SESSION_START', session: {
      session_id: 'test', video_id: 'test', generation: 1, tab_id: 1,
      ready_through_ms: 0, state: 'BUFFERING',
    } }, {}, () => {});
  });
  assert.equal(await page.locator('video').evaluate(video => video.paused), true);
  await page.locator('button').click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('video').evaluate(video => video.paused), true,
    'El usuario pudo saltar la preparación inicial y quedarse sin doblaje');
  await page.evaluate(() => window.contentMessage({ type: 'BUFFER_STATUS', generation: 1,
    ready_through_ms: 5500, eof: false }, {}, () => {}));
  await page.waitForTimeout(200);
  assert.equal(await page.locator('video').evaluate(video => video.paused), true,
    'El video arrancó sin una reserva suficiente para una reproducción continua');
  await page.evaluate(() => window.contentMessage({ type: 'BUFFER_STATUS', generation: 1,
    ready_through_ms: 13000, eof: false }, {}, () => {}));
  await page.waitForFunction(() => !document.querySelector('video').paused);
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.4);
  await page.evaluate(() => window.contentMessage({ type: 'BUFFER_STATUS', generation: 1,
    ready_through_ms: 30000, eof: false }, {}, () => {}));
  await page.evaluate(() => {
    const position = Math.round(document.querySelector('video').currentTime * 1000);
    window.contentMessage({ type: 'SEGMENT_TEXT', event: { generation: 1, payload: {
      segment_id: 'long-phrase', start_ms: position, end_ms: position + 500,
      sync_deadline_ms: position + 500, rendered_duration_ms: 1600,
      text_es_ar: 'Frase larga',
    } } }, {}, () => {});
  });
  await page.getByText('Terminando esta frase…').waitFor({ timeout: 3000 });
  assert.equal(await page.locator('video').evaluate(video => video.paused), true,
    'El video avanzó y habría cortado la voz a mitad de frase');
  await page.evaluate(() => window.contentMessage({ type: 'AUDIO_SEGMENT_DONE',
    segment_id: 'long-phrase', generation: 1 }, {}, () => {}));
  await page.waitForFunction(() => !document.querySelector('video').paused);
  await page.evaluate(() => {
    const position = Math.round(document.querySelector('video').currentTime * 1000);
    window.contentMessage({ type: 'SEGMENT_TEXT', event: { generation: 1, payload: {
      segment_id: 'manual-pause', start_ms: position, end_ms: position + 400,
      sync_deadline_ms: position + 400, rendered_duration_ms: 1400,
      text_es_ar: 'Frase que se pausa manualmente',
    } } }, {}, () => {});
  });
  await page.getByText('Terminando esta frase…').waitFor({ timeout: 3000 });
  await page.locator('button').click();
  await page.getByText('Pausado', { exact: true }).waitFor({ timeout: 3000 });
  await page.evaluate(() => window.contentMessage({ type: 'AUDIO_SEGMENT_DONE',
    segment_id: 'manual-pause', generation: 1 }, {}, () => {}));
  await page.waitForTimeout(400);
  assert.equal(await page.locator('video').evaluate(video => video.paused), true,
    'La pausa manual se reanudó sola cuando terminó la voz');
  await page.locator('button').click();
  await page.waitForFunction(() => !document.querySelector('video').paused);
  await page.evaluate(() => {
    const position = Math.round(document.querySelector('video').currentTime * 1000);
    window.contentMessage({ type: 'SEGMENT_TEXT', event: { generation: 1, payload: {
      segment_id: 'missing-completion', start_ms: position, end_ms: position + 400,
      sync_deadline_ms: position + 400, rendered_duration_ms: 1400,
      text_es_ar: 'Frase sin aviso de fin',
    } } }, {}, () => {});
  });
  try {
    await page.getByText('Terminando esta frase…').waitFor({ timeout: 3000 });
  } catch (error) {
    console.error(await page.evaluate(() => {
      let state;
      window.contentMessage({ type: 'GET_PLAYER' }, {}, value => { state = value; });
      return { position: document.querySelector('video').currentTime,
        paused: document.querySelector('video').paused,
        overlay: document.querySelector('#doblaje-local-overlay')?.textContent, state };
    }));
    throw error;
  }
  await page.waitForFunction(() => !document.querySelector('video').paused,
    null, { timeout: 8000 });
  await page.waitForTimeout(400);
  assert.equal(await page.locator('video').evaluate(video => video.paused), false,
    'La misma frase volvió a pausar el video después del límite de espera');
  await page.evaluate(() => {
    const position = Math.round(document.querySelector('video').currentTime * 1000);
    window.contentMessage({ type: 'BUFFER_STATUS', generation: 1,
      ready_through_ms: position + 100, eof: false }, {}, () => {});
  });
  await page.waitForFunction(() => document.querySelector('video').paused);
  await page.evaluate(() => window.contentMessage({ type: 'BUFFER_STATUS', generation: 1,
    ready_through_ms: Math.round(document.querySelector('video').currentTime * 1000) + 4500,
    eof: false }, {}, () => {}));
  await page.waitForTimeout(150);
  assert.equal(await page.locator('video').evaluate(video => video.paused), true,
    'Una reserva pequeña después de un corte provocaría pausas repetidas');
  await page.evaluate(() => window.contentMessage({ type: 'BUFFER_STATUS', generation: 1,
    ready_through_ms: Math.round(document.querySelector('video').currentTime * 1000) + 31000,
    eof: false }, {}, () => {}));
  await page.waitForFunction(() => !document.querySelector('video').paused);
  await page.locator('button').click();
  await page.waitForFunction(() => document.querySelector('video').paused);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('video').evaluate(video => video.paused), true,
    'La pausa manual se reanudó sola');
  console.log(JSON.stringify({ buffer_exhaustion: 'waited for voice',
    full_phrase: 'resumed after audio', manual_pause: 'stayed paused',
    missing_completion: 'recovered' }));
} finally {
  await browser.close();
}
