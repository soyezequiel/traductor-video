import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  await page.route('https://www.youtube.com/**', route => route.fulfill({
    contentType: 'text/html', body: `<!doctype html><style>
      body{margin:0;background:#181818;color:white;font-family:Arial}
      main{display:flex;gap:16px;padding:4px}
      .html5-video-player{position:relative;width:calc(100vw - 300px);height:620px;background:#171010;overflow:hidden}
      video{display:block;width:100%;height:100%}
      aside{width:260px;background:#292929}
      @media(max-width:700px){main{padding:0}.html5-video-player{width:100vw;height:240px}aside{display:none}}
    </style><main><div class="html5-video-player"><video class="html5-main-video"></video></div><aside>Recomendaciones</aside></main>`,
  }));
  await page.goto('https://www.youtube.com/watch?v=ABCDEFGHIJK');
  await page.evaluate(() => {
    const video = document.querySelector('video');
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 100 });
    window.chrome = { runtime: {
      onMessage: { addListener: listener => { window.contentMessage = listener; } },
      sendMessage: async () => ({ ok: true }),
    } };
  });
  await page.addScriptTag({ path: resolve('dist/content.js') });
  await page.evaluate(() => {
    window.contentMessage({ type: 'SESSION_START', session: {
      session_id: 'test', video_id: 'ABCDEFGHIJK', generation: 1, tab_id: 1,
      ready_through_ms: 0, state: 'BUFFERING',
    } }, {}, () => {});
    window.contentMessage({ type: 'SEGMENT_TEXT', event: { generation: 1, payload: {
      segment_id: 'test', start_ms: 99000, end_ms: 105000, sync_deadline_ms: 105000,
      rendered_duration_ms: 5000,
      text_es_ar: 'En 2013 intentamos entender cómo funciona este lugar. La historia empieza acá y continúa con una explicación bastante larga para probar varias líneas de subtítulos.',
    } } }, {}, () => {});
  });
  const subtitle = page.locator('#doblaje-local-subtitle');
  await subtitle.waitFor({ state: 'visible' });
  await page.evaluate(() => window.contentMessage({ type: 'BUFFER_STATUS', generation: 1,
    ready_through_ms: 102000, eof: false }, {}, () => {}));
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.contentMessage({ type: 'BUFFER_STATUS', generation: 1,
    ready_through_ms: 104000, eof: false }, {}, () => {}));
  await page.getByText(/aprox\. \d+ s de espera/).waitFor();
  const progress = page.getByRole('progressbar', { name: 'Audio preparado' });
  assert.ok(Number(await progress.getAttribute('aria-valuenow')) > 0);
  for (const [name, size] of [['desktop', { width: 1400, height: 800 }],
                              ['narrow', { width: 430, height: 800 }]]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(150);
    const bounds = await page.evaluate(() => {
      const player = document.querySelector('.html5-video-player').getBoundingClientRect();
      const subtitle = document.querySelector('#doblaje-local-subtitle').getBoundingClientRect();
      const progress = document.querySelector('#doblaje-local-progress').getBoundingClientRect();
      const overlay = document.querySelector('#doblaje-local-overlay');
      return { player: player.toJSON(), subtitle: subtitle.toJSON(), progress: progress.toJSON(), parentIsPlayer:
        overlay.parentElement === document.querySelector('.html5-video-player') };
    });
    assert.equal(bounds.parentIsPlayer, true);
    assert.ok(bounds.subtitle.left >= bounds.player.left - 1 &&
              bounds.subtitle.right <= bounds.player.right + 1, `${name}: subtítulo fuera del ancho del video`);
    assert.ok(bounds.subtitle.top >= bounds.player.top - 1 &&
              bounds.subtitle.bottom <= bounds.player.bottom - 35, `${name}: subtítulo fuera del alto útil`);
    assert.ok(bounds.progress.left >= bounds.player.left - 1 && bounds.progress.right <= bounds.player.right + 1 &&
              bounds.progress.top >= bounds.player.top - 1, `${name}: progreso fuera del video`);
    await page.screenshot({ path: resolve(`../reports/subtitles-${name}.png`) });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('#doblaje-local-progress .activity').evaluate(el =>
    getComputedStyle(el).animationName), 'none');
  console.log(JSON.stringify({ desktop: 'within player', narrow: 'within player' }));
} finally {
  await browser.close();
}
