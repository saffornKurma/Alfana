"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeAlfText = analyzeAlfText;
/**
 * Provisional header regex — adjust to actual ALF schema once sample is shared.
 * Assumes a line like:
 *   2026-03-11T09:03:15.123Z [ERROR] booking.svc corrId=abc-123 - Something bad happened
 */
const HEAD_RE = /^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+\[([A-Z]+)\]\s*([a-zA-Z0-9._-]+)?\s*(corr(?:Id|elationId)?=[\w-]+)?\s*-\s*(.*)$/;
/**
 * Parses raw ALF text into records and returns grouped errors.
 */
function analyzeAlfText(raw) {
    const lines = raw.split(/\r?\n/);
    const records = [];
    let current = null;
    const stackBuf = [];
    const flush = () => {
        if (current) {
            if (stackBuf.length)
                current.stack = [...stackBuf];
            records.push(current);
            current = null;
            stackBuf.length = 0;
        }
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
        }
        else if (/^\s+at\s+/.test(l) || /^\s+[\w$.]+\(.*\)$/.test(l)) {
            // stack lines (Java/Node style)
            stackBuf.push(l.trim());
        }
        else {
            if (!current)
                current = { ts: '', level: 'INFO', msg: l };
            else
                current.msg += '\n' + l;
        }
    }
    flush();
    // Group only ERROR/FATAL for MVP
    const groupsMap = new Map();
    for (const r of records.filter(r => /ERROR|FATAL/i.test(r.level))) {
        const top2 = (r.stack ?? []).slice(0, 2).join('|');
        const gist = r.msg.replace(/\s+/g, ' ').slice(0, 140);
        const signature = `${r.level}|${top2}|${gist}`;
        const g = groupsMap.get(signature) ?? {
            signature,
            count: 0,
            samples: [],
            topFrame: (r.stack ?? [])[0]
        };
        g.count++;
        g.samples.push(r);
        groupsMap.set(signature, g);
    }
    return { groups: [...groupsMap.values()].sort((a, b) => b.count - a.count) };
}
//# sourceMappingURL=parser.js.map