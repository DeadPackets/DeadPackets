// Live terminal sessions for the MacBook screen (LLM-AD-Defense): a timed script drawn on a canvas, looping. Illustrative: the repo is private.
const C = { ink: '#e6e8eb', dim: '#8b919a', green: '#6ad07a', yellow: '#e3b341', blue: '#58a6ff', purple: '#c08cf0', red: '#ff7b72' };
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏', spin = (t) => SPIN[Math.floor(t * 12) % 10];
const typed = (s, t, cps = 38) => s.slice(0, Math.max(0, Math.floor(t * cps)));
const count = (n, t, dur) => String(Math.round(n * Math.min(1, Math.max(0, t / dur))));
// a line: { at, segs(t) -> [[col, text, color, { bold, bg }], ...] }, t = seconds since it appeared
const prompt = (cmd, args) => (t) => { const s = typed(cmd + args, t, 34); return [[0, '❯', C.green], [2, s.slice(0, cmd.length), C.ink], [2 + cmd.length, s.slice(cmd.length), C.blue]]; };
const row = (cells) => () => cells;

const tag = (name, color) => [0, `[${name}]`, color];
const stream = (s, t) => typed(s, t, 46); // the model's words arrive as a stream
export const AD = { title: 'LLM-AD-Defense', dur: 18, lines: [
  { at: 0, segs: prompt('ad-defense watch ', '--source wazuh --model gemini-2.5-pro') },
  { at: 1.6, segs: row([[0, 'autonomous SOC analyst · reads EDR alerts · acts on Active Directory', C.dim]]) },
  { at: 2.3, gap: 1, segs: row([tag('alert', C.yellow), [10, 'rule 92213 · kerberoasting pattern from WS-0142', C.ink]]) },
  { at: 3, segs: (t) => [tag('triage', C.purple), [10, t < 0.8 ? `correlating ${count(14, t, 0.8)} events ${spin(t)}` : 'correlated 14 events · 3 hosts · 1 service account', C.ink]] },
  { at: 3.9, segs: (t) => [tag('reason', C.purple), [10, stream('ticket requests for 11 SPNs in 40 s, from a user session', t), C.ink]] },
  { at: 5.1, segs: (t) => [[10, stream('that never requested service tickets before. likely attack.', t), C.ink]] },
  ...[['disable account', 'svc-backup', '', 6.4], ['reset password', 'svc-backup', '', 7.3], ['isolate host', 'WS-0142', 'via EDR', 8.2]].map(([act, obj, via, at]) => ({ at, segs: (t) => [tag('act', C.red), [10, act, C.ink], [27, obj, C.ink, { bold: 1 }], [38, via, C.ink], [47, t < 0.6 ? spin(t) : 'ok', t < 0.6 ? C.dim : C.green]] })),
  { at: 9.2, segs: row([tag('report', C.blue), [10, 'incident summary sent to the SOC channel', C.ink]]) },
  { at: 10.4, gap: 1, segs: row([tag('alert', C.yellow), [10, 'rule 60122 · failed logons burst on DC-01', C.ink]]) },
  { at: 11.1, segs: (t) => [tag('triage', C.purple), [10, stream("source is the patch server's scheduled job. benign.", t), C.ink]] },
  { at: 12.6, segs: row([tag('close', C.green), [10, 'no action, tuned the rule threshold', C.ink]]) },
  { at: 13.2, gap: 1, segs: (t) => [[0, '❯', C.green], [2, t % 1 < 0.5 ? '_' : '', C.purple]] },
] };

export function makeTerm(sess) {
  const cv = Object.assign(document.createElement('canvas'), { width: 1280, height: 800 }), x = cv.getContext('2d'), F = '"JetBrains Mono", ui-monospace, monospace';
  return { canvas: cv, draw(sec) {
    const t = sec % sess.dur, fade = Math.min(1, (sess.dur - t) / 0.5); // a short fade before the loop restarts
    x.fillStyle = '#0d1016'; x.fillRect(0, 0, 1280, 800); x.fillStyle = '#151a22'; x.fillRect(0, 0, 1280, 52); x.fillStyle = '#232a35'; x.fillRect(0, 52, 1280, 1);
    ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => { x.fillStyle = c; x.beginPath(); x.arc(30 + i * 26, 26, 8, 0, 7); x.fill(); });
    x.font = `700 19px ${F}`; x.fillStyle = C.ink; x.textBaseline = 'middle'; x.fillText(sess.title, 122, 27);
    x.font = `400 15px ${F}`; const pill = 'illustrative session · private repository', pw = x.measureText(pill).width + 28; x.strokeStyle = '#2b3340'; x.lineWidth = 1.5; x.beginPath(); x.roundRect(1258 - pw, 11, pw, 32, 16); x.stroke(); x.fillStyle = C.dim; x.fillText(pill, 1272 - pw, 27);
    x.globalAlpha = fade; x.font = `400 23px ${F}`; const cw = x.measureText('M').width, lh = 36; let y = 104;
    for (const ln of sess.lines) {
      if (ln.gap) y += lh * 0.55 * ln.gap; if (t < ln.at) break;
      for (const [col, text, color, o = {}] of ln.segs(t - ln.at)) {
        if (!text) continue; const px = 42 + col * cw; x.font = `${o.bold ? 700 : 400} 23px ${F}`;
        if (o.bg) { x.fillStyle = o.bg; x.beginPath(); x.roundRect(px - 8, y - 17, x.measureText(text).width + 16, 34, 4); x.fill(); }
        x.fillStyle = color; x.fillText(text, px, y);
      }
      y += lh;
    }
    x.globalAlpha = 1;
  } };
}
