import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  await page.route('https://www.youtube.com/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<div class="html5-video-player"><video class="html5-main-video"></video></div>',
  }));
  await page.goto('https://www.youtube.com/watch?v=ABCDEFGHIJK');
  await page.evaluate(() => {
    window.sent = [];
    window.chrome = { runtime: {
      onMessage: { addListener: listener => { window.contentMessage = listener; } },
      sendMessage: async message => { window.sent.push(message); return { ok: true }; },
    } };
  });
  await page.addScriptTag({ path: resolve('dist/content.js') });
  await page.evaluate(() => window.contentMessage({ type: 'SESSION_START', session: {
    session_id: 'test', video_id: 'ABCDEFGHIJK', generation: 1, tab_id: 1,
    ready_through_ms: 0, state: 'BUFFERING',
  } }, {}, () => {}));
  await page.evaluate(() => history.replaceState({}, '', '?v=ABCDEFGHIJK&t=30s'));
  await page.waitForTimeout(250);
  const sameVideo = await page.evaluate(() => window.sent.filter(item => item.type === 'VIDEO_CHANGED').length);
  assert.equal(sameVideo, 0, 'Cambiar el tiempo del mismo video detuvo el doblaje');
  await page.evaluate(() => {
    const video = document.querySelector('video');
    video.dispatchEvent(new Event('seeking'));
    video.dispatchEvent(new Event('seeking'));
    video.dispatchEvent(new Event('seeking'));
    video.dispatchEvent(new Event('seeked'));
  });
  await page.waitForTimeout(450);
  const seeks = await page.evaluate(() => window.sent.filter(item => item.type === 'PLAYER_SEEK').length);
  assert.equal(seeks, 1, 'Un solo salto reinició el doblaje varias veces');
  await page.evaluate(() => history.replaceState({}, '', '?v=LMNOPQRSTUV'));
  await page.waitForFunction(() => window.sent.some(item => item.type === 'VIDEO_CHANGED'));
  console.log(JSON.stringify({ time_parameter_kept_session: true, one_seek_per_jump: true,
    new_video_stopped_session: true }));
} finally {
  await browser.close();
}
