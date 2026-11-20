// Package W: one feedback.log line (server/src/reports.ts `ReportLine`) as readable text.
import type { ReportLine } from '../server/src/reports';

export function formatReport(json: string): string {
    let r: ReportLine;
    try { r = JSON.parse(json) as ReportLine; } catch { return `(unreadable line) ${json.slice(0, 200)}`; }
    const s = r.server ?? { via: '?' };
    const who = [s.name && `${s.name}`, s.team, s.room && `room ${s.room}`, s.map && `map ${s.map}`].filter(Boolean).join(', ');
    const head = `${(r.time ?? '').slice(0, 19).replace('T', ' ')}  ${r.kind === 'error' ? 'ERROR REPORT' : 'FEEDBACK'}${who ? `  (${who})` : ''}`;
    const out = [head, ...String(r.text ?? '').split('\n').map(l => `  ${l}`)];
    if (r.stack) out.push(...r.stack.split('\n').slice(0, 6).map(l => `    | ${l}`));
    const c = r.ctx ?? {};
    const extra = [c.fps !== undefined && `${c.fps} fps`, c.ping !== undefined && `ping ${c.ping} ms`, c.renderScale !== undefined && `render ${c.renderScale}`,
        c.path && `page ${c.path}`, s.protocol !== undefined && `protocol ${s.protocol}`].filter(Boolean).join(', ');
    if (extra) out.push(`  [${extra}]`);
    if (c.gpu) out.push(`  [graphics: ${c.gpu}]`);
    if (c.ua) out.push(`  [browser: ${c.ua}]`);
    return out.join('\n');
}
