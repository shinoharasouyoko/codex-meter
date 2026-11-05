export interface CdpSession {
  evaluate(expression: string): Promise<unknown>;
}

export interface SessionProbe {
  codex: boolean;
  markers: Record<string, boolean>;
}

export interface QuotaWindow {
  percent: number;
  resetsAt: string | null;
}

export interface QuotaControlMessage {
  type: "quota";
  status: string;
  shortWindow: QuotaWindow | null;
  weeklyWindow: QuotaWindow | null;
}

export interface WeatherControlMessage {
  type: "weather";
  status: string;
  current: { emoji: string; description: string; temperature: number } | null;
  nextHour: { emoji: string; description: string; temperature: number } | null;
}

export function parseControlLine(line: string): QuotaControlMessage | WeatherControlMessage | { type: "shutdown" } | null;

export function probeSession(session: CdpSession): Promise<SessionProbe>;
