import { BASE, type Event, type SegmentPayload } from './shared';

interface Clip {
  data: SegmentPayload;
  buffer?: AudioBuffer;
  loading?: Promise<void>;
  resumeOffsetSeconds?: number;
}

let token = '';
let generation = 0;
let context: AudioContext | null = null;
let volumeNode: GainNode | null = null;
let requestedVolume: unknown = null;
let clips: Clip[] = [];
let playing: AudioBufferSourceNode | null = null;
let playingClip: Clip | null = null;
let playingId = '';
let lastPosition = 0;
let lastSpeed = 1;
let lastPaused = true;
let lastMediaPaused = true;
let lastHoldSegmentId = '';
let lastClockAt = performance.now();
let playingScheduledAt = 0;
let playingStartMs = 0;
let playingOffsetSeconds = 0;
let playingSpeed = 1;

function videoPositionNow(): number {
  return lastPosition + (lastMediaPaused ? 0 : Math.max(0, performance.now() - lastClockAt) * lastSpeed);
}

function syncErrorMs(): number | null {
  if (!playing || !context || lastMediaPaused) return null;
  const audioPosition = playingStartMs +
    (playingOffsetSeconds + context.currentTime - playingScheduledAt) * playingSpeed * 1000;
  return Math.round(audioPosition - videoPositionNow());
}

function ctx(): AudioContext {
  context ||= new AudioContext({ latencyHint: 'interactive' });
  if (!volumeNode) {
    volumeNode = context.createGain();
    volumeNode.connect(context.destination);
  }
  return context;
}

function setVolume(value: unknown): void {
  requestedVolume = value;
  const volume = Number(value);
  if (volumeNode) volumeNode.gain.value = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
}

function stopCurrent(rememberPosition = false): void {
  if (playing) {
    if (playingClip) {
      if (rememberPosition && context) {
        const heard = playingOffsetSeconds + Math.max(0, context.currentTime - playingScheduledAt);
        playingClip.resumeOffsetSeconds = Math.min(playingClip.buffer?.duration || heard,
          Math.max(playingClip.resumeOffsetSeconds || 0, heard));
      } else playingClip.resumeOffsetSeconds = undefined;
    }
    playing.onended = null;
    try { playing.stop(); } catch { /* already ended */ }
    playing.disconnect();
  }
  playing = null;
  playingClip = null;
  playingId = '';
  playingScheduledAt = 0;
}

function reset(nextGeneration?: number): void {
  stopCurrent();
  clips = [];
  lastHoldSegmentId = '';
  if (nextGeneration !== undefined) generation = nextGeneration;
}

async function load(clip: Clip): Promise<void> {
  if (clip.buffer) return;
  if (!token) throw new Error('Falta la credencial del audio local');
  clip.loading ||= (async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${BASE}/v1/audio/${encodeURIComponent(clip.data.audio_id)}`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('No se pudo leer el audio local');
        const bytes = await response.arrayBuffer();
        clip.buffer = await ctx().decodeAudioData(bytes);
        maybePlay();
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  })();
  try { await clip.loading; }
  catch (error) { clip.loading = undefined; throw error; }
}

function maybePlay(): void {
  if (lastPaused || (lastMediaPaused && !lastHoldSegmentId) || playing || !clips.length) return;
  const audio = ctx();
  void audio.resume();
  const position = videoPositionNow();
  const clip = lastHoldSegmentId
    ? clips.find(item => item.data.segment_id === lastHoldSegmentId && item.buffer)
    : clips.find(item => item.data.sync_deadline_ms > position &&
      item.data.start_ms < position + 500 && item.buffer);
  if (!clip?.buffer) return;
  const { start_ms, segment_id } = clip.data;
  const elapsed = Math.max(clip.resumeOffsetSeconds || 0,
    Math.max(0, (position - start_ms) / (1000 * lastSpeed)));
  const delay = Math.max(0, (start_ms - position) / (1000 * lastSpeed));
  if (elapsed >= clip.buffer.duration - 0.02) {
    clips = clips.filter(item => item !== clip);
    void chrome.runtime.sendMessage({ type: 'AUDIO_SEGMENT_DONE', segment_id, generation });
    return;
  }
  const node = audio.createBufferSource();
  node.buffer = clip.buffer;
  node.connect(volumeNode!);
  playing = node;
  playingClip = clip;
  playingId = segment_id;
  playingScheduledAt = audio.currentTime + delay;
  playingStartMs = start_ms;
  playingOffsetSeconds = elapsed;
  playingSpeed = lastSpeed;
  node.onended = () => {
    if (playing !== node) return;
    node.disconnect();
    playing = null;
    playingClip = null;
    playingId = '';
    clips = clips.filter(item => item !== clip);
    void chrome.runtime.sendMessage({ type: 'AUDIO_SEGMENT_DONE', segment_id, generation });
    maybePlay();
  };
  try { node.start(playingScheduledAt, elapsed); }
  catch { stopCurrent(); }
}

chrome.runtime.onMessage.addListener((request: Record<string, unknown>, _sender, sendResponse) => {
  if (request.recipient !== 'offscreen') return false;
  try {
    if (request.type === 'AUDIO_INIT') {
      token = String(request.token || '');
      void ctx().resume();
      setVolume(request.volume ?? 1);
    } else if (request.type === 'AUDIO_VOLUME') {
      setVolume(request.volume);
    } else if (request.type === 'AUDIO_RESET') {
      reset(request.generation === undefined ? undefined : Number(request.generation));
    } else if (request.type === 'AUDIO_SKIP_SEGMENT') {
      if (Number(request.generation) !== generation) return false;
      const segmentId = String(request.segment_id || '');
      if (segmentId && playingId === segmentId) stopCurrent();
      clips = clips.filter(clip => clip.data.segment_id !== segmentId);
      if (lastHoldSegmentId === segmentId) lastHoldSegmentId = '';
    } else if (request.type === 'AUDIO_SEGMENT') {
      const event = request.event as Event;
      if (event.generation === generation) {
        const payload = event.payload as SegmentPayload;
        let clip = clips.find(c => c.data.segment_id === payload.segment_id);
        if (!clip) {
          clip = { data: payload };
          clips.push(clip);
          clips.sort((a, b) => a.data.start_ms - b.data.start_ms);
        }
        void load(clip).then(() => sendResponse({ ok: true }),
          error => sendResponse({ error: String(error) }));
        return true;
      }
    } else if (request.type === 'AUDIO_CLOCK') {
      if (Number(request.generation) !== generation) return false;
      const position = Number(request.position_ms);
      const paused = Boolean(request.paused);
      const mediaPaused = Boolean(request.media_paused);
      const holdSegmentId = String(request.hold_segment_id || '');
      const speed = Number(request.speed) || 1;
      const sentAt = Number(request.sent_at_ms);
      const transit = Number.isFinite(sentAt) ? Math.max(0, Math.min(250, Date.now() - sentAt)) : 0;
      const projectedPosition = position + (mediaPaused ? 0 : transit * speed);
      const jumped = Math.abs(projectedPosition - videoPositionNow()) > 750;
      if (paused) stopCurrent(true);
      else if (jumped || Math.abs(speed - lastSpeed) > 0.01) stopCurrent();
      lastPosition = projectedPosition;
      lastClockAt = performance.now();
      lastPaused = paused;
      lastMediaPaused = mediaPaused;
      lastHoldSegmentId = holdSegmentId;
      lastSpeed = speed;
      // Correct at phrase boundaries. Restarting a word for small clock jitter stutters.
      // Explicit seeks/generation resets and jumps above 750 ms still stop the clip.
      clips = clips.filter(c => c.data.sync_deadline_ms > projectedPosition ||
        c.data.segment_id === playingId || c.data.segment_id === lastHoldSegmentId);
      maybePlay();
    } else if (request.type === 'AUDIO_DIAG') {
      sendResponse({ generation, playing_id: playingId, clips: clips.length,
        audio_context: context?.state || 'not-created', position_ms: lastPosition,
        volume: volumeNode?.gain.value ?? 1, requested_volume: requestedVolume,
        playing_start_ms: playing ? playingStartMs : null, sync_error_ms: syncErrorMs() });
      return false;
    }
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ error: String(error) });
  }
  return false;
});
