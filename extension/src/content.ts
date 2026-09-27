import type { Event as BackendEvent, SessionInfo } from './shared';
import { BufferPlanner } from './buffering';

let video: HTMLVideoElement | null = null;
let session: SessionInfo | null = null;
let originalVolume = 1;
let originalMuted = false;
let adShowing = false;
let readyThrough = 0;
let eof = false;
let waiting = false;
let playbackStarted = false;
const bufferPlanner = new BufferPlanner();
let preparationStage = 'Conectando con el video…';
let stoppedByUs = false;
let userPaused = false;
let fitHold = false;
let fitClipId = '';
let fitDeadline = 0;
let fitCandidates: { id: string; end_ms: number; extra_ms: number }[] = [];
let subtitleQueue: { start_ms: number; end_ms: number; text: string }[] = [];
function videoKey(href: string): string {
  const url = new URL(href);
  return url.pathname === '/watch' ? `watch:${url.searchParams.get('v') || ''}` : url.pathname;
}
let lastVideoKey = videoKey(location.href);
let lastTick = 0;
let seekVersion = 0;
let sentSeekVersion = 0;
let seekTimer: ReturnType<typeof setTimeout> | null = null;
let seekInFlight = false;
let generationPending = false;
let label: HTMLDivElement | null = null;
let subtitle: HTMLDivElement | null = null;
let overlayRoot: HTMLDivElement | null = null;
let progress: HTMLDivElement | null = null;
let progressFill: HTMLDivElement | null = null;
let progressText: HTMLDivElement | null = null;
let progressDetail: HTMLDivElement | null = null;

function player(): HTMLVideoElement | null {
  const found = document.querySelector('video.html5-main-video') as HTMLVideoElement | null;
  if (found !== video) video = found;
  return video;
}

function playButton(current: HTMLVideoElement): HTMLButtonElement | null {
  return current.closest('.html5-video-player')?.querySelector('.ytp-play-button') as HTMLButtonElement | null;
}

function pausePlayer(current: HTMLVideoElement): void {
  if (current.paused) return;
  playButton(current)?.click();
  if (!current.paused) current.pause();
}

function resumePlayer(current: HTMLVideoElement, attempts = 0): void {
  if (!session || waiting || fitHold || userPaused || !current.paused) return;
  const button = playButton(current);
  if (!button) {
    void current.play().catch(() => showStatus('Presioná reproducir para activar el audio'));
    return;
  }
  button.click();
  setTimeout(() => {
    if (!session || waiting || !current.paused) return;
    if (attempts < 2) resumePlayer(current, attempts + 1);
    else showStatus('Presioná reproducir para activar el audio');
  }, 180);
}

function pauseByUser(current: HTMLVideoElement): void {
  userPaused = true;
  fitHold = false;
  if (!current.paused) {
    stoppedByUs = true;
    pausePlayer(current);
  }
  showStatus('Pausado');
  lastTick = 0;
  tick();
}

document.addEventListener('click', event => {
  if (!session || !fitHold || !event.isTrusted ||
      !(event.target as Element).closest?.('.ytp-play-button')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const current = player();
  if (current) pauseByUser(current);
}, true);

document.addEventListener('keydown', event => {
  if (!session || !fitHold || !event.isTrusted ||
      !['k', ' ', 'MediaPlayPause'].includes(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const current = player();
  if (current) pauseByUser(current);
}, true);

function mount(): void {
  const host = player()?.closest('.html5-video-player') as HTMLElement | null;
  if (!host) return;
  if (!overlayRoot) {
    overlayRoot = document.createElement('div');
    overlayRoot.id = 'doblaje-local-overlay';
    overlayRoot.style.cssText = 'position:absolute;left:0;right:0;bottom:clamp(52px,10%,104px);z-index:2147483646;pointer-events:none;box-sizing:border-box;padding:0 min(4%,48px);display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;font-family:Arial,sans-serif';
    label = document.createElement('div');
    label.id = 'doblaje-local-status';
    label.style.cssText = 'display:none;box-sizing:border-box;max-width:100%;background:#101a22e8;color:#f8faf9;border:1px solid #89dcc8;border-radius:999px;padding:6px 12px;font-size:13px;font-weight:600;line-height:1.25;overflow-wrap:anywhere';
    subtitle = document.createElement('div');
    subtitle.id = 'doblaje-local-subtitle';
    subtitle.style.cssText = 'display:none;box-sizing:border-box;width:max-content;max-width:min(100%,980px);background:rgba(7,17,23,.84);color:#fff;border-radius:10px;padding:8px 14px;line-height:1.32;text-shadow:0 1px 2px #000;box-shadow:0 3px 14px rgba(0,0,0,.35);white-space:normal;overflow-wrap:break-word;text-wrap:balance';
    progress = document.createElement('div');
    progress.id = 'doblaje-local-progress';
    progress.style.cssText = 'display:none;box-sizing:border-box;width:320px;max-width:100%;padding:12px 16px;border:1px solid #89dcc866;border-radius:12px;background:#101a22f5;color:#f8faf9;text-align:left;box-shadow:0 4px 18px #0005';
    const style = document.createElement('style');
    style.textContent = `@keyframes doblaje-breathe{50%{opacity:.35}} #doblaje-local-progress .activity{display:inline-block;width:7px;height:7px;margin-right:8px;border-radius:50%;background:#89dcc8;animation:doblaje-breathe 1.4s ease-in-out infinite} #doblaje-local-progress .fill{transition:width .35s ease} @media(prefers-reduced-motion:reduce){#doblaje-local-progress .activity{animation:none} #doblaje-local-progress .fill{transition:none}}`;
    const heading = document.createElement('div');
    heading.style.cssText = 'display:flex;align-items:center;font-size:13px;font-weight:600;line-height:1.4';
    const activity = document.createElement('span');
    activity.className = 'activity';
    activity.setAttribute('aria-hidden', 'true');
    progressText = document.createElement('div');
    progressText.setAttribute('role', 'status');
    heading.append(activity, progressText);
    const track = document.createElement('div');
    track.style.cssText = 'height:4px;background:#ffffff26;border-radius:4px;margin:10px 0 8px;overflow:hidden';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', 'Audio preparado');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    progressFill = document.createElement('div');
    progressFill.className = 'fill';
    progressFill.style.cssText = 'height:100%;width:0;background:#89dcc8;border-radius:4px';
    track.append(progressFill);
    progressDetail = document.createElement('div');
    progressDetail.style.cssText = 'font-size:12px;line-height:1.4;color:#c2d1d8;font-variant-numeric:tabular-nums';
    progress.append(style, heading, track, progressDetail);
    overlayRoot.append(label, progress, subtitle);
  }
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  if (overlayRoot.parentElement !== host) host.appendChild(overlayRoot);
  const width = host.getBoundingClientRect().width;
  if (subtitle) {
    subtitle.style.fontSize = width < 500 ? '16px' : width < 900 ? '19px' : width < 1400 ? '22px' : '26px';
    subtitle.style.padding = width < 500 ? '6px 9px' : '8px 14px';
  }
}

function showStatus(value: string): void {
  mount();
  if (progress) progress.style.display = 'none';
  if (label) { label.textContent = value; label.style.display = value ? 'block' : 'none'; }
}

function showPreparation(position: number): void {
  if (!progress || !progressFill || !progressText || !progressDetail || userPaused) return;
  if (label) label.style.display = 'none';
  progress.style.display = 'block';
  const prepared = Math.max(0, readyThrough - position);
  const percent = Math.min(99, Math.floor(prepared / bufferPlanner.targetMs * 100));
  progressFill.style.width = `${percent}%`;
  progressFill.parentElement!.setAttribute('aria-valuenow', String(percent));
  const title = prepared ? (playbackStarted ? 'Recuperando audio para continuar…' : 'Preparando la voz…') : preparationStage;
  if (progressText.textContent !== title) progressText.textContent = title;
  const eta = bufferPlanner.estimate(Math.max(0, bufferPlanner.targetMs - prepared), Date.now());
  progressDetail.textContent = `${Math.floor(prepared / 1000)} / ${Math.ceil(bufferPlanner.targetMs / 1000)} s de audio · ${eta === null ? 'Calculando espera…' : `aprox. ${eta} s de espera`}`;
}

function restore(): void {
  seekVersion += 1;
  if (seekTimer) clearTimeout(seekTimer);
  seekTimer = null;
  generationPending = false;
  if (video) {
    video.volume = originalVolume;
    video.muted = originalMuted;
  }
  session = null;
  waiting = false;
  playbackStarted = false;
  bufferPlanner.reset();
  userPaused = false;
  fitHold = false;
  fitClipId = '';
  fitCandidates = [];
  subtitleQueue = [];
  if (subtitle) subtitle.style.display = 'none';
  showStatus('');
}

function scheduleSeek(delayMs: number): void {
  if (seekTimer) clearTimeout(seekTimer);
  seekTimer = setTimeout(() => { seekTimer = null; void flushSeek(); }, delayMs);
}

async function flushSeek(): Promise<void> {
  if (!session || seekInFlight) return;
  const current = player();
  if (!current) return;
  const version = seekVersion;
  const sessionId = session.session_id;
  const position = Math.round(current.currentTime * 1000);
  seekInFlight = true;
  sentSeekVersion = version;
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'PLAYER_SEEK', position_ms: position }) as
      { generation?: number; error?: string };
    if (!session || session.session_id !== sessionId || version !== seekVersion) return;
    if (reply.generation) {
      session.generation = reply.generation;
      generationPending = false;
    }
    if (reply.error) showStatus(reply.error);
  } catch (error) {
    if (version === seekVersion) showStatus(String(error));
  } finally {
    seekInFlight = false;
    if (session && session.session_id === sessionId && version !== seekVersion) scheduleSeek(0);
  }
}

function tick(): void {
  const current = player();
  if (!session || !current) return;
  mount();
  const now = Date.now();
  if (now - lastTick < 70) return;
  lastTick = now;
  adShowing = Boolean(document.querySelector('.html5-video-player.ad-showing'));
  if (adShowing) {
    if (current.volume !== originalVolume) current.volume = originalVolume;
    if (current.muted !== originalMuted) current.muted = originalMuted;
  } else {
    if (current.volume !== 0) current.volume = 0;
    if (!current.muted) current.muted = true;
  }
  const position = Math.round(current.currentTime * 1000);
  const visible = subtitleQueue.find(item => item.start_ms <= position && item.end_ms > position);
  if (subtitle) {
    subtitle.textContent = visible?.text || '';
    subtitle.style.display = visible ? 'block' : 'none';
  }
  subtitleQueue = subtitleQueue.filter(item => item.end_ms > position - 2000);
  if (!fitClipId) {
    const next = fitCandidates[0];
    if (next) fitClipId = next.id;
  }
  const fitClip = fitCandidates.find(item => item.id === fitClipId);
  if (!fitHold && fitClip && !waiting && !userPaused && !current.paused &&
      position >= fitClip.end_ms - 100) {
    fitHold = true;
    fitDeadline = now + Math.max(5000, Math.min(20000, fitClip.extra_ms + 3000));
    stoppedByUs = true;
    pausePlayer(current);
    showStatus('Terminando esta frase…');
  }
  if (fitHold && now > fitDeadline) {
    const expiredId = fitClipId;
    fitCandidates = fitCandidates.filter(item => item.id !== expiredId);
    fitHold = false;
    fitClipId = '';
    showStatus('');
    void chrome.runtime.sendMessage({ type: 'AUDIO_SKIP_SEGMENT', segment_id: expiredId,
      generation: session.generation });
    resumePlayer(current);
  }
  if (waiting && !fitHold && !current.paused) {
    stoppedByUs = true;
    pausePlayer(current);
    showStatus('Preparando el doblaje…');
  }
  if (!waiting && !fitHold && !userPaused && !current.paused && !eof && position + 750 >= readyThrough) {
    waiting = true;
    bufferPlanner.rebuffer(current.playbackRate);
    stoppedByUs = true;
    pausePlayer(current);
    showStatus('Preparando más voz…');
  }
  if (waiting && !fitHold && !adShowing) showPreparation(position);
  void chrome.runtime.sendMessage({ type: 'PLAYER_TICK', position_ms: position,
    speed: current.playbackRate, paused: userPaused || adShowing || (current.paused && !fitHold) || waiting,
    media_paused: current.paused, hold_segment_id: fitHold && !userPaused ? fitClipId : '',
    sent_at_ms: Date.now() });
}

function resumeIfReady(): void {
  const current = player();
  if (!session || !current || !waiting || fitHold) return;
  const position = Math.round(current.currentTime * 1000);
  const neededMs = bufferPlanner.targetMs;
  if (readyThrough >= position + neededMs || eof && readyThrough >= position) {
    waiting = false;
    playbackStarted = true;
    showStatus(userPaused ? 'Pausado' : '');
    if (!userPaused) resumePlayer(current);
  } else showPreparation(position);
}

function onVideoEvent(event: globalThis.Event): void {
  const current = player();
  if (!session || !current) return;
  if (event.type === 'seeking') {
    seekVersion += 1;
    generationPending = true;
    waiting = true;
    playbackStarted = false;
    bufferPlanner.reset();
    readyThrough = Math.round(current.currentTime * 1000);
    eof = false;
    preparationStage = 'Preparando desde esta posición…';
    fitHold = false; fitClipId = ''; fitCandidates = [];
    subtitleQueue = [];
    showStatus('Preparando desde la nueva posición…');
    scheduleSeek(250);
  } else if (event.type === 'seeked') {
    if (waiting && sentSeekVersion !== seekVersion) scheduleSeek(120);
  } else if (event.type === 'ratechange') {
    const speed = current.playbackRate;
    if (speed < 0.75 || speed > 1.25) {
      showStatus('El doblaje admite velocidades entre 0,75× y 1,25×');
      void chrome.runtime.sendMessage({ type: 'STOP' });
      return;
    }
    waiting = true;
    playbackStarted = false;
    bufferPlanner.reset();
    readyThrough = Math.round(current.currentTime * 1000);
    eof = false;
    preparationStage = 'Ajustando la velocidad…';
    generationPending = true;
    fitHold = false; fitClipId = ''; fitCandidates = [];
    subtitleQueue = [];
    showStatus('Ajustando velocidad…');
    void chrome.runtime.sendMessage({ type: 'PLAYER_SPEED', position_ms: Math.round(current.currentTime * 1000), speed })
      .then((reply: { generation?: number; error?: string }) => {
        if (reply.generation && session) { session.generation = reply.generation; generationPending = false; }
        if (reply.error) showStatus(reply.error);
      });
  } else if (event.type === 'play') {
    userPaused = false;
    if (fitHold) {
      stoppedByUs = true;
      pausePlayer(current);
    } else if (!waiting) showStatus('');
  } else if (event.type === 'pause') {
    if (!stoppedByUs) {
      userPaused = true;
      fitHold = false;
      showStatus('Pausado');
    }
    stoppedByUs = false;
  } else if (event.type === 'volumechange' && !adShowing) {
    if (current.volume > 0) originalVolume = current.volume;
    if (!current.muted) originalMuted = false;
  }
  tick();
}

const watchedEvents = ['play', 'pause', 'timeupdate', 'seeking', 'seeked', 'ratechange', 'ended', 'waiting', 'volumechange'] as const;
let attached: HTMLVideoElement | null = null;
function attach(): void {
  const found = player();
  if (found === attached) return;
  if (attached) for (const name of watchedEvents) attached.removeEventListener(name, onVideoEvent);
  attached = found;
  if (found) for (const name of watchedEvents) found.addEventListener(name, onVideoEvent);
}

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, _sender, sendResponse) => {
  const current = player();
  if (message.type === 'GET_PLAYER') {
    sendResponse(current ? { url: location.href, position_ms: Math.round(current.currentTime * 1000),
      speed: current.playbackRate, ready_through_ms: readyThrough, paused: current.paused,
      waiting, user_paused: userPaused, fit_hold: fitHold, fit_clip_id: fitClipId,
      fit_candidates: fitCandidates.length } : null);
    return false;
  }
  if (message.type === 'SESSION_START' && current) {
    session = message.session as SessionInfo;
    originalVolume = current.volume;
    originalMuted = current.muted;
    current.volume = 0;
    current.muted = true;
    readyThrough = Math.round(current.currentTime * 1000);
    eof = false;
    waiting = true;
    playbackStarted = false;
    bufferPlanner.reset();
    preparationStage = 'Conectando con el video…';
    userPaused = false;
    fitHold = false;
    fitClipId = '';
    fitCandidates = [];
    subtitleQueue = [];
    stoppedByUs = true;
    pausePlayer(current);
    showStatus('Preparando el doblaje…');
  } else if (message.type === 'SESSION_STOP') {
    restore();
    if (message.detail) showStatus(String(message.detail));
  } else if (message.type === 'GENERATION_READY' && session) {
    session.generation = Number(message.generation);
    generationPending = false;
  } else if (message.type === 'BUFFER_STATUS' && session && message.generation === session.generation) {
    if (generationPending) return false;
    readyThrough = Number(message.ready_through_ms);
    bufferPlanner.observe(readyThrough, Date.now(), current?.playbackRate || 1, waiting);
    eof = Boolean(message.eof);
    resumeIfReady();
  } else if (message.type === 'SEGMENT_TEXT' && session) {
    const event = message.event as BackendEvent;
    if (event.generation === session.generation && subtitle) {
      subtitleQueue.push({ start_ms: Number(event.payload.start_ms), end_ms: Number(event.payload.end_ms),
        text: String(event.payload.text_es_ar || '') });
      subtitleQueue.sort((a, b) => a.start_ms - b.start_ms);
      const startMs = Number(event.payload.start_ms);
      const endMs = Number(event.payload.sync_deadline_ms || event.payload.end_ms);
      const intervalMs = (endMs - startMs) / current!.playbackRate;
      const extraMs = Number(event.payload.rendered_duration_ms) - intervalMs;
      if (extraMs > 120 && endMs >= Math.round(current!.currentTime * 1000) - 500) {
        fitCandidates.push({ id: String(event.payload.segment_id), end_ms: endMs, extra_ms: extraMs });
        fitCandidates.sort((a, b) => a.end_ms - b.end_ms);
      }
    }
  } else if (message.type === 'AUDIO_SEGMENT_DONE' && session && message.generation === session.generation) {
    fitCandidates = fitCandidates.filter(item => item.id !== message.segment_id);
    if (message.segment_id === fitClipId) {
      fitClipId = '';
      if (fitHold) {
        fitHold = false;
        showStatus('');
        if (current && !waiting) resumePlayer(current);
      }
    }
  } else if (message.type === 'SESSION_STATE' && session) {
    if (message.detail && message.state !== 'ERROR') preparationStage = String(message.detail);
    if (message.state === 'ERROR') {
      const detail = String(message.detail || 'Error de doblaje');
      restore();
      showStatus(detail);
    }
  }
  sendResponse({ ok: true });
  return false;
});

setInterval(() => {
  const key = videoKey(location.href);
  if (key !== lastVideoKey) {
    lastVideoKey = key;
    if (session) { restore(); void chrome.runtime.sendMessage({ type: 'VIDEO_CHANGED' }); }
  }
  attach();
  tick();
}, 100);
attach();
