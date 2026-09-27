import { api, BASE, type Event, type SessionInfo } from './shared';

let current: SessionInfo | null = null;
let socket: WebSocket | null = null;
let openingSocket: Promise<void> | null = null;
let eventChain: Promise<void> = Promise.resolve();
let lastPositionSent = 0;
let lastSeq = 0;
let lastOffscreenCheck = 0;
let openingOffscreen: Promise<void> | null = null;
const pendingSegments = new Map<string, Event>();
let changingSession = false;
let deferredEvents: Event[] = [];

void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

async function ensureCurrent(): Promise<void> {
  if (current) return;
  const saved = await chrome.storage.session.get('current');
  if (!saved.current) return;
  try {
    const backend = await api<{ session: SessionInfo | null }>('/v1/status');
    const candidate = saved.current as SessionInfo;
    if (backend.session?.session_id !== candidate.session_id) {
      await chrome.storage.session.remove('current');
      return;
    }
    current = { ...candidate, ...backend.session };
    await connectEvents();
    await ensureOffscreen();
  } catch { /* backend can be restarted manually */ }
}

async function audioMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
  try {
    const reply = await chrome.runtime.sendMessage({ ...message, recipient: 'offscreen' }) as
      { ok?: boolean; error?: string } | undefined;
    if (message.type === 'AUDIO_SEGMENT' && !reply?.ok)
      throw new Error(reply?.error || 'No se pudo preparar el audio local');
  } catch (error) {
    if (message.type === 'AUDIO_SEGMENT') throw error;
  }
}

async function tabMessage(tabId: number, message: object): Promise<void> {
  try { await chrome.tabs.sendMessage(tabId, message); } catch { /* tab navigated */ }
}

async function ensureOffscreen(): Promise<void> {
  if (openingOffscreen) return openingOffscreen;
  openingOffscreen = (async () => {
    const contexts = await chrome.runtime.getContexts({}) as chrome.runtime.ExtensionContext[];
    if (contexts.some(context => context.contextType === 'OFFSCREEN_DOCUMENT')) return;
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'],
      justification: 'Reproducir audio doblado local sincronizado con YouTube' });
    const { token, dubVolume } = await chrome.storage.local.get(['token', 'dubVolume']);
    await audioMessage({ type: 'AUDIO_INIT', token, volume: dubVolume ?? 1 });
    if (current) {
      await audioMessage({ type: 'AUDIO_RESET', generation: current.generation });
      for (const event of pendingSegments.values()) {
        await audioMessage({ type: 'AUDIO_SEGMENT', event });
      }
    }
  })().finally(() => { openingOffscreen = null; });
  return openingOffscreen;
}

async function handleEvent(event: Event): Promise<void> {
  if (!current || event.session_id !== current.session_id || event.generation !== current.generation) return;
  if (event.seq && event.seq <= lastSeq) return;
  lastSeq = event.seq || lastSeq;
  if (event.type === 'segment_ready') {
    pendingSegments.set(String(event.payload.segment_id), event);
    await ensureOffscreen();
    await audioMessage({ type: 'AUDIO_SEGMENT', event });
    await tabMessage(current.tab_id, { type: 'SEGMENT_TEXT', event });
  } else if (event.type === 'buffer_status') {
    current.ready_through_ms = Number(event.payload.ready_through_ms || current.ready_through_ms);
    await tabMessage(current.tab_id, { type: 'BUFFER_STATUS', ...event.payload,
      generation: current.generation });
  } else if (event.type === 'session_state') {
    current.state = String(event.payload.state);
    await tabMessage(current.tab_id, { type: 'SESSION_STATE', ...event.payload });
  } else if (event.type === 'source_info') {
    await tabMessage(current.tab_id, { type: 'SOURCE_INFO', ...event.payload });
  }
}

function queueEvent(event: Event): void {
  if (changingSession) { deferredEvents.push(event); return; }
  eventChain = eventChain.then(() => handleEvent(event)).catch(async error => {
    console.error('Doblaje:', error);
    if (current?.session_id !== event.session_id || current.generation !== event.generation) return;
    await stop('No se pudo cargar la voz. Volvé a activar el doblaje para reintentar.');
  });
}

function releaseEvents(): void {
  changingSession = false;
  const events = deferredEvents;
  deferredEvents = [];
  for (const event of events) queueEvent(event);
}

async function connectEvents(): Promise<void> {
  if (socket?.readyState === WebSocket.OPEN) return;
  if (openingSocket) return openingSocket;
  openingSocket = (async () => {
    const { ticket } = await api<{ ticket: string }>('/v1/ws-ticket', 'POST');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:8765/v1/events');
      socket = ws;
      const timer = setTimeout(() => reject(new Error('Sin conexión de eventos')), 5000);
      ws.onopen = () => { ws.send(JSON.stringify({ ticket })); clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Falló la conexión de eventos')); };
      ws.onmessage = (message) => {
        const data = JSON.parse(message.data as string) as Event & { history?: Event[] };
        if (data.type === 'hello') {
          for (const past of data.history || []) queueEvent(past);
        } else queueEvent(data);
      };
      ws.onclose = () => {
        if (socket === ws) socket = null;
        if (current) setTimeout(() => void connectEvents().catch(() => {}), 2000);
      };
    });
  })().finally(() => { openingSocket = null; });
  return openingSocket;
}

async function stop(detail = ''): Promise<void> {
  await ensureCurrent();
  const previous = current;
  current = null;
  pendingSegments.clear();
  eventChain = Promise.resolve();
  await chrome.storage.session.remove('current');
  await audioMessage({ type: 'AUDIO_RESET' });
  if (previous) {
    await tabMessage(previous.tab_id, { type: 'SESSION_STOP', detail });
    await api(`/v1/sessions/${previous.session_id}/control`, 'POST', { action: 'stop' }).catch(() => {});
  }
}

async function start(tabId: number): Promise<SessionInfo> {
  await stop();
  let player: { url: string; position_ms: number; speed: number } | undefined;
  for (let attempt = 0; attempt < 12 && !player; attempt += 1) {
    try {
      player = await chrome.tabs.sendMessage(tabId, { type: 'GET_PLAYER' }) as typeof player;
    } catch { /* YouTube may still be replacing its video page */ }
    if (!player) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!player?.url) throw new Error('Abrí un video de YouTube antes de activar el doblaje.');
  if (player.speed < 0.75 || player.speed > 1.25) throw new Error('Usá una velocidad entre 0,75× y 1,25×.');
  await connectEvents();
  changingSession = true;
  try {
    const result = await api<{ session_id: string; video_id: string; generation: number }>(
      '/v1/sessions', 'POST', { url: player.url, position_ms: player.position_ms,
        speed: player.speed, source_mode: 'auto', voice_id: 'video' });
    current = { ...result, tab_id: tabId, ready_through_ms: player.position_ms, state: 'BUFFERING' };
    await chrome.storage.session.set({ current });
    lastSeq = 0;
    await audioMessage({ type: 'AUDIO_RESET', generation: current.generation });
    await tabMessage(tabId, { type: 'SESSION_START', session: current });
    return current;
  } finally { releaseEvents(); }
}

async function message(request: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (request.type === 'UI_STATUS') {
    await ensureCurrent();
    const { token, dubVolume } = await chrome.storage.local.get(['token', 'dubVolume']);
    return { paired: Boolean(token), session: current, dubVolume };
  }
  if (request.type === 'START') return start(Number(request.tabId));
  if (request.type === 'STOP') { await stop(); return { ok: true }; }
  if (request.type === 'PLAYER_TICK' && current && sender.tab?.id === current.tab_id) {
    const position = Number(request.position_ms);
    if (Date.now() - lastOffscreenCheck > 2000) {
      lastOffscreenCheck = Date.now();
      for (const [id, event] of pendingSegments) {
        if (Number(event.payload.sync_deadline_ms) < position - 1000) pendingSegments.delete(id);
      }
      if (pendingSegments.size && !request.paused) await ensureOffscreen();
    }
    await audioMessage({ type: 'AUDIO_CLOCK', position_ms: position, paused: request.paused,
      media_paused: request.media_paused, hold_segment_id: request.hold_segment_id,
      sent_at_ms: request.sent_at_ms,
      speed: request.speed, generation: current.generation });
    if (Date.now() - lastPositionSent > 1000) {
      lastPositionSent = Date.now();
      void api(`/v1/sessions/${current.session_id}/position`, 'POST', { position_ms: position }).catch(() => {});
    }
  }
  if (request.type === 'PLAYER_SEEK' && current && sender.tab?.id === current.tab_id) {
    changingSession = true;
    try {
      const updated = await api<{ generation: number }>(`/v1/sessions/${current.session_id}/control`, 'POST',
        { action: 'seek', position_ms: request.position_ms });
      current.generation = Math.max(current.generation, updated.generation);
      pendingSegments.clear();
      eventChain = Promise.resolve();
      current.ready_through_ms = Number(request.position_ms);
      await chrome.storage.session.set({ current });
      await audioMessage({ type: 'AUDIO_RESET', generation: current.generation });
      await tabMessage(current.tab_id, { type: 'GENERATION_READY', generation: current.generation });
      return { generation: current.generation };
    } finally { releaseEvents(); }
  }
  if (request.type === 'PLAYER_SPEED' && current && sender.tab?.id === current.tab_id) {
    changingSession = true;
    try {
      const updated = await api<{ generation: number }>(`/v1/sessions/${current.session_id}/control`, 'POST',
        { action: 'speed', position_ms: request.position_ms, speed: request.speed });
      current.generation = updated.generation;
      pendingSegments.clear();
      eventChain = Promise.resolve();
      current.ready_through_ms = Number(request.position_ms);
      await chrome.storage.session.set({ current });
      await audioMessage({ type: 'AUDIO_RESET', generation: current.generation });
      await tabMessage(current.tab_id, { type: 'GENERATION_READY', generation: current.generation });
      return { generation: current.generation };
    } finally { releaseEvents(); }
  }
  if (request.type === 'VIDEO_CHANGED' && current && sender.tab?.id === current.tab_id) await stop();
  if (request.type === 'AUDIO_SKIP_SEGMENT' && current && sender.tab?.id === current.tab_id &&
      request.generation === current.generation) {
    pendingSegments.delete(String(request.segment_id));
    await audioMessage({ type: 'AUDIO_SKIP_SEGMENT', segment_id: request.segment_id,
      generation: current.generation });
  }
  if (request.type === 'AUDIO_SEGMENT_DONE' && current &&
      request.generation === current.generation) {
    pendingSegments.delete(String(request.segment_id));
    await tabMessage(current.tab_id, { type: 'AUDIO_SEGMENT_DONE',
      segment_id: request.segment_id, generation: current.generation });
  }
  return undefined;
}

chrome.runtime.onMessage.addListener((request: Record<string, unknown>, sender, sendResponse) => {
  if (request.recipient === 'offscreen') return false;
  void message(request, sender).then(sendResponse).catch((error: Error) => sendResponse({ error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => { if (current?.tab_id === tabId) void stop(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.dubVolume) {
    void audioMessage({ type: 'AUDIO_VOLUME', volume: changes.dubVolume.newValue });
  }
});
