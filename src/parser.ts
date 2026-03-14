export type LogRecord = {
  ts?: string;
  level: string;         // "ERROR"/"FATAL"/"UNKNOWN"
  service?: string;
  corrId?: string;
  msg: string;
  stack?: string[];
};

export type Group = {
  signature: string;
  count: number;
  samples: LogRecord[];
  topFrame?: string;
};

export type Analysis = { groups: Group[] };

/**
 * Strict header format (kept for classic ALF lines):
 * 2026-03-11T09:03:15.123Z [ERROR] service corrId=abc-123 - Message
 */
const HEAD_RE =
  /^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+\[([A-Z]+)\]\s*([a-zA-Z0-9._-]+)?\s*(corr(?:Id|elationId)?=[\w-]+)?\s*-\s*(.*)$/;

/** Fallback: any line that has ERROR/FATAL anywhere */
const LOOSE_MARK_RE = /(ERROR|FATAL)/i;

/** Lines that look like stack frames */
const FRAME_RE = /^\s*(?:at\s+|\S+\(.*\))\s*$/;

export function analyzeAlfText(raw: string): Analysis {
  const lines = raw.split(/\r?\n/);
  const strictRecords: LogRecord[] = [];
  const looseRecords: LogRecord[] = [];

  let current: LogRecord | null = null;
  let inLoose = false;
  const buf: string[] = [];

  const flush = () => {
    if (current) {
      if (buf.length) current.stack = [...buf];
      strictRecords.push(current);
      current = null;
    }
    buf.length = 0;
    inLoose = false;
  };

  for (const l of lines) {
    const m = HEAD_RE.exec(l);
    if (m) {
      flush();
      current = {
        ts: m[1],
        level: m[2],
        service: m[3],
        corrId: m[4],
        msg: m[5]
      };
      continue;
    }
    if (current && FRAME_RE.test(l)) {
      buf.push(l.trim());
      continue;
    }

    // Fallback capture
    if (!current && LOOSE_MARK_RE.test(l)) {
      inLoose = true;
      looseRecords.push({ level: /fatal/i.test(l) ? 'FATAL' : 'ERROR', msg: l.trim() });
      continue;
    }
    if (inLoose) {
      const last = looseRecords[looseRecords.length - 1];
      if (last) last.msg += '\n' + l;
      if (!l.trim()) inLoose = false;
      continue;
    }

    if (current) {
      current.msg += '\n' + l;
    }
  }
  flush();

  const all = [...strictRecords, ...looseRecords];

  // Group by (level + top frame + first 160 chars)
  const groups = new Map<string, Group>();
  for (const r of all.filter(r => /ERROR|FATAL/i.test(r.level))) {
    const top = (r.stack ?? [])[0] || '';
    const gist = (r.msg || '').replace(/\s+/g, ' ').slice(0, 160);
    const key = `${r.level}|${top}|${gist}`;
    const g = groups.get(key) ?? { signature: key, count: 0, samples: [], topFrame: top };
    g.count++;
    g.samples.push(r);
    groups.set(key, g);
  }

  return { groups: [...groups.values()].sort((a, b) => b.count - a.count) };
}