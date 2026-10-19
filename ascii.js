// ASCII light: the page's living background. A slow light field (fbm, a pool under the laptop, one at the cursor) drawn in glyphs; black stays the base.
// Two passes: the field at one texel per glyph cell, then glyphs at full resolution, so the noise runs ~10k times a frame, not ~5M.
const NOISE = `float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float s = 0., a = .5; for (int i = 0; i < 5; i++) { s += a * n(p); p *= 2.03; a *= .5; } return s; }`;
const FIELD = `precision mediump float; uniform vec2 C; uniform float T, A, P; uniform vec2 M, L; ${NOISE}
void main() { vec2 uv = gl_FragCoord.xy / C, a = vec2(A, 1.); float t = T * .05; vec2 q = uv * a;
  float f = fbm(q * 1.6 + vec2(t, -t * .7)) * fbm(q * 2.4 - vec2(t * .6, t * .2));
  float pool = exp(-5. * length((uv - L) * a)) * .55 * P + exp(-9. * length((uv - M) * a)) * .35;
  gl_FragColor = vec4(clamp(f * 1.25 + pool - .2, 0., 1.), 0., 0., 1.); }`;
const GLYPH = `precision mediump float; uniform vec2 C; uniform float S, T; uniform vec3 K; uniform sampler2D F, G; ${NOISE}
void main() { vec2 cell = floor(gl_FragCoord.xy / S), f = fract(gl_FragCoord.xy / S); float b = texture2D(F, (cell + .5) / C).r;
  float g = floor(clamp(b + step(.985, h(cell + floor(T * 4.))) * .3, 0., .999) * 10.); // a few cells flicker to a brighter glyph
  float ink = texture2D(G, vec2((g + f.x) / 10., 1. - f.y)).r;
  gl_FragColor = vec4(vec3(.012, .016, .026) + mix(K, vec3(.75, .2, .45), smoothstep(.6, .95, b)) * ink * (.35 + b * .8), 1.); }`;

export function asciiBg() {
  const cv = document.createElement('canvas'), gl = cv.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' });
  if (!gl) return null;
  cv.className = 'ascii'; cv.setAttribute('aria-hidden', 'true'); document.body.prepend(cv);
  const prog = (fs) => { const p = gl.createProgram(); for (const [t, s] of [[gl.VERTEX_SHADER, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0., 1.); }'], [gl.FRAGMENT_SHADER, fs]]) { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); gl.attachShader(p, o); } gl.linkProgram(p); return p; };
  const pf = prog(FIELD), pg = prog(GLYPH), u = (p, n) => gl.getUniformLocation(p, n);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const tex = (unit, filter) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); return t; };
  const fieldT = tex(0, gl.NEAREST), fb = gl.createFramebuffer(), atlasT = tex(1, gl.LINEAR);
  const atlas = Object.assign(document.createElement('canvas'), { width: 320, height: 32 }), ax = atlas.getContext('2d');
  const drawAtlas = () => { ax.clearRect(0, 0, 320, 32); ax.fillStyle = '#fff'; ax.font = '600 26px "JetBrains Mono", monospace'; ax.textAlign = 'center'; ax.textBaseline = 'middle'; [...' .:-=+*#%@'].forEach((c, i) => ax.fillText(c, i * 32 + 16, 17)); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, atlasT); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas); };
  drawAtlas(); document.fonts?.load('600 26px "JetBrains Mono"').then(drawAtlas);
  let W = 0, H = 0, S = 1, cols = 1, rows = 1, last = -1e9;
  const size = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2); W = cv.width = Math.round(innerWidth * dpr); H = cv.height = Math.round(innerHeight * dpr); S = 11 * dpr; cols = Math.ceil(W / S); rows = Math.ceil(H / S);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fieldT); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fieldT, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null); last = -1e9;
  };
  size(); addEventListener('resize', size);
  // m, l: cursor and laptop in 0..1, y up; pool: how lit the laptop's pool is; k: tint (rgb, linear-ish)
  return function draw(now, m, l, pool, k, still) {
    if (now - last < 33 && !still) return; last = now; const t = still ? 0 : now / 1000; // 30 fps is plenty for drifting light
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, cols, rows); gl.useProgram(pf);
    gl.uniform2f(u(pf, 'C'), cols, rows); gl.uniform1f(u(pf, 'T'), t); gl.uniform1f(u(pf, 'A'), W / H); gl.uniform1f(u(pf, 'P'), pool); gl.uniform2f(u(pf, 'M'), m.x, m.y); gl.uniform2f(u(pf, 'L'), l.x, l.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.useProgram(pg);
    gl.uniform2f(u(pg, 'C'), cols, rows); gl.uniform1f(u(pg, 'S'), S); gl.uniform1f(u(pg, 'T'), t); gl.uniform3f(u(pg, 'K'), k[0], k[1], k[2]); gl.uniform1i(u(pg, 'F'), 0); gl.uniform1i(u(pg, 'G'), 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}
