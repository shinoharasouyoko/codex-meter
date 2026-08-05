export interface CdpSession {
  evaluate(expression: string): Promise<unknown>;
}

export interface SessionProbe {
  codex: boolean;
  markers: Record<string, boolean>;
}

export function probeSession(session: CdpSession): Promise<SessionProbe>;
