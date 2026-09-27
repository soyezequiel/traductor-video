export const BASE = 'http://127.0.0.1:8765';

export interface SegmentPayload {
  segment_id: string;
  start_ms: number;
  end_ms: number;
  sync_deadline_ms: number;
  text_es_ar: string;
  audio_id: string;
  sample_rate_hz: number;
  channels: number;
  natural_duration_ms: number;
  rendered_duration_ms: number;
  render_rate: number;
  sha256: string;
}

export interface Event {
  protocol_version: number;
  type: string;
  session_id: string;
  video_id: string;
  generation: number;
  seq: number;
  payload: Record<string, unknown> & Partial<SegmentPayload>;
}

export interface SessionInfo {
  session_id: string;
  video_id: string;
  generation: number;
  tab_id: number;
  ready_through_ms: number;
  state: string;
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const { token } = await chrome.storage.local.get('token');
  if (!token) throw new Error('Primero emparejá la extensión en Opciones.');
  let response: Response;
  try {
    response = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('El servicio local no responde. Ejecutá scripts/start.ps1.');
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { detail?: string };
    throw new Error(detail.detail || `Error del servicio (${response.status})`);
  }
  return response.json() as Promise<T>;
}
