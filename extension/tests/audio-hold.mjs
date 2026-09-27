import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const profileRoot = resolve('../data');
const profile = mkdtempSync(resolve(profileRoot, 'playwright-audio-hold-'));
const sampleRate = 24000;
const durationSeconds = 2.5;
const sampleCount = Math.round(sampleRate * durationSeconds);
const wav = Buffer.alloc(44 + sampleCount * 2);
wav.write('RIFF', 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(sampleCount * 2, 40);
for (let index = 0; index < sampleCount; index += 1) {
  wav.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 220 * index / sampleRate)), 44 + index * 2);
}
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`,
    '--autoplay-policy=no-user-gesture-required'],
});
try {
  let downloads = 0;
  await context.route('http://127.0.0.1:8765/v1/audio/test-audio', route => {
    downloads += 1;
    return downloads === 1 ? route.fulfill({ status: 503, body: 'Retry' }) :
      route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const offscreen = await context.newPage();
  await offscreen.goto(`chrome-extension://${id}/offscreen.html`);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_INIT', token: 'test', volume: 0 });
    await chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_RESET', generation: 1 });
    await chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_SEGMENT', event: {
      generation: 1, payload: { segment_id: 'test-segment', audio_id: 'test-audio',
        start_ms: 0, end_ms: 500, sync_deadline_ms: 500,
        rendered_duration_ms: 2500, text_es_ar: 'Frase de prueba',
      },
    } });
    await chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_CLOCK',
      generation: 1, position_ms: 0, paused: false, media_paused: true,
      hold_segment_id: 'test-segment', sent_at_ms: Date.now(), speed: 1 });
  });
  await page.waitForFunction(async () => {
    const diag = await chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_DIAG' });
    return diag?.playing_id === 'test-segment';
  }, null, { timeout: 5000 });
  assert.equal(downloads, 2, 'Una descarga transitoria debe recuperarse antes de confirmar el audio');
  await page.evaluate(() => chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_CLOCK',
    generation: 1, position_ms: 600, paused: false, media_paused: true,
    hold_segment_id: 'test-segment', sent_at_ms: Date.now(), speed: 1 }));
  await page.waitForTimeout(900);
  const during = await page.evaluate(() => chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_DIAG' }));
  assert.equal(during.playing_id, 'test-segment', 'El audio se cortó al cruzar el límite de la frase');
  await page.waitForFunction(async () => {
    const diag = await chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_DIAG' });
    return diag && !diag.playing_id;
  }, null, { timeout: 5000 });
  await offscreen.evaluate(() => {
    window.audioStarts = 0;
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.audioStarts += 1;
      return original.apply(this, args);
    };
  });
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_RESET', generation: 2 });
    await chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_SEGMENT', event: {
      generation: 2, payload: { segment_id: 'jitter', audio_id: 'test-audio',
        start_ms: 0, end_ms: 3000, sync_deadline_ms: 3000, rendered_duration_ms: 2500 },
    } });
    window.jitterStart = Date.now();
    await chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_CLOCK',
      generation: 2, position_ms: 0, paused: false, media_paused: false,
      sent_at_ms: Date.now(), speed: 1 });
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => chrome.runtime.sendMessage({ recipient: 'offscreen', type: 'AUDIO_CLOCK',
    generation: 2, position_ms: Date.now() - window.jitterStart + 240,
    paused: false, media_paused: false, sent_at_ms: Date.now(), speed: 1 }));
  assert.equal(await offscreen.evaluate(() => window.audioStarts), 1,
    'El jitter del reloj reinició una palabra a mitad de frase');
  console.log(JSON.stringify({ download_retry: true, continued_past_deadline: true,
    ended_naturally: true, clock_jitter_without_restart: true }));
} finally {
  await context.close();
  if (dirname(profile) !== profileRoot || !basename(profile).startsWith('playwright-audio-hold-'))
    throw new Error('Ruta del perfil temporal inesperada');
  rmSync(profile, { recursive: true, force: true });
}
