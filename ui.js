// Page UI that must work without three.js (blocked CDN, no WebGL, reduced motion): sticker cards, the gallery, nav state, the shell.
export const FLAG = String.fromCharCode(...[125, 110, 119, 48, 100, 95, 51, 100, 49, 115, 95, 121, 107, 99, 49, 116, 115, 123, 80, 68].reverse());
export const LAPTOP = { old: 'HUAWEI MateBook D16', new: 'MacBook Pro 16' };
for (const sc of ['beat', 'project']) document.querySelectorAll(`[data-scene="${sc}"] .when`).forEach((w, i, all) => w.insertAdjacentHTML('beforeend', ` <span class="nw">· ${i + 1} of ${all.length}</span>`)); // where am I in the story
if (!new URLSearchParams(location.search).get('verify')) { if (document.querySelector('.shell')) initShell(); initCards(); initNav(); }

// ---------- sticker stories: the index list + the card (works without WebGL) ----------
async function initCards() {
  const [all, stories] = await Promise.all([fetch('stickers.json').then((r) => r.json()).catch(() => null), fetch('stories.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}))]);
  const card = document.querySelector('.card'), idx = document.querySelector('.index'), E = {};
  if (!all) { if (idx) idx.querySelector('.count').textContent = 'The sticker list did not load. Reload the page, or email youssef@ctf.ae.'; return; }
  for (const k of ['old', 'new']) for (const e of all[k].stickers) if (!e.locked) E[k + ':' + e.id] = { ...e, lid: k }; // locked: on the lid, but not one to pick
  const count = { old: all.old.stickers.filter((e) => !e.locked).length, new: all.new.stickers.filter((e) => !e.locked).length }, nice = (n) => { const t = n.replace(/\s*\((?:small|square|green|blue|light blue|outline|orange circle|penguin)\)/i, ''); return t[0].toUpperCase() + t.slice(1); }; // display names: drop inventory qualifiers
  // the story beats in index.html are the default card text for their stickers, on every page
  const beatDoc = document.querySelector('[data-sticker]') ? document : await fetch('./').then((r) => r.text()).then((t) => new DOMParser().parseFromString(t, 'text/html')).catch(() => document);
  const beats = Object.fromEntries([...beatDoc.querySelectorAll('[data-sticker]')].map((b) => [b.dataset.sticker, { title: b.querySelector('h2').textContent, story: b.querySelector('h2 + p').textContent, node: b.querySelector('h2 + p') }]));
  let back = null;
  window.openCard = (key) => {
    const e = E[key]; if (!e) return; const s = { ...beats[key], ...stories[key] }; if (stories[key]?.story) delete s.node; // the owner's words win; a beat keeps its copy and links
    card.querySelector('img').src = e.file.replace('stickers/', 'stickers/m/');
    card.querySelector('h3').textContent = s.title || nice(e.name);
    card.querySelector('.where').textContent = [beats[key] && !stories[key]?.title && !nice(e.name).includes(s.where ?? '\u0000') && nice(e.name), s.where, `${LAPTOP[e.lid]}, one of ${count[e.lid]}`, e.visible_px === 0 && 'hidden under other stickers'].filter(Boolean).join(' · ');
    const story = card.querySelector('.story'); story.replaceChildren(...(s.node ? [...s.node.cloneNode(true).childNodes] : [s.story || ''])); story.hidden = !s.story; // beat copy keeps its links
    const a = card.querySelector('.link'); a.hidden = !s.link; if (s.link) a.href = s.link;
    const ask = card.querySelector('.ask'); ask.hidden = !!s.story; ask.href = `mailto:youssef@ctf.ae?subject=${encodeURIComponent('The ' + (s.title || e.name) + ' sticker')}`;
    if (document.querySelector('#lid')) card.dataset.side = e.lid; back = document.activeElement === document.body ? document.querySelector('.more') : document.activeElement; // from the canvas: return to the sticker list link // dodge the laptop only where one is drawn
    card.hidden = false; card.querySelector('button').focus({ preventScroll: true });
  };
  const close = () => { card.hidden = true; back?.focus?.({ preventScroll: true }); };
  card.querySelector('button').addEventListener('click', close);
  card.addEventListener('focusout', (e) => { if (e.relatedTarget && !card.contains(e.relatedTarget)) card.hidden = true; }); // Tab out of the card closes it
  addEventListener('pointerdown', (e) => { if (!card.hidden && !card.contains(e.target)) close(); }); // click anywhere else closes; a sticker click reopens it
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !card.hidden) close(); });
  const told = Object.keys(E).filter((k) => stories[k]?.story || beats[k]).length, verb = told === Object.keys(E).length ? 'see where it came from' : told ? 'see its story or ask me about it' : 'ask me about it';
  for (const el of document.querySelectorAll('.pick')) el.textContent = verb;
  const name = (k) => (stories[k]?.title || nice(E[k].name)).replace(/[<&"]/g, '');
  for (const b of document.querySelectorAll('[data-sticker]')) { // the canvas stickers as buttons: keyboard and screen-reader users reach every story; shown when focused
    const ks = [b.dataset.sticker, ...(b.dataset.swarm || '').split(',')].filter((k) => E[k]); if (!ks.length) continue;
    const g = document.createElement('div'); g.className = 'swarm'; g.setAttribute('role', 'group'); g.setAttribute('aria-label', 'Stickers in this story');
    const ls = ks.map(name); g.innerHTML = ks.map((k, i) => `<button type="button" data-show="${k}">${ls.indexOf(ls[i]) !== ls.lastIndexOf(ls[i]) ? E[k].name.replace(/[<&"]/g, '') : ls[i]}</button>`).join(''); // two "Blackhat"s: keep the full names g.addEventListener('click', (ev) => { const t = ev.target.closest('[data-show]'); if (t) window.openCard(t.dataset.show); });
    b.querySelector('.inner').append(g);
  }
  if (!idx) return;
  idx.querySelector('.groups').innerHTML = ['old', 'new'].map((lid) => `<h2>${LAPTOP[lid]}</h2><ul>` + Object.keys(E).filter((k) => E[k].lid === lid).sort((a, b) => E[b].visible_px - E[a].visible_px) // most visible on the lid first
    .map((k) => `<li><button type="button" data-show="${k}"${stories[k]?.story || beats[k] ? ' class="told"' : ''}><img src="${E[k].file.replace('stickers/', 'stickers/m/')}" alt="" loading="lazy" decoding="async">${name(k)}${stories[k]?.story || beats[k] ? ' <span class="tag">has a story</span>' : ''}</button></li>`).join('') + '</ul>').join('');
  idx.addEventListener('click', (ev) => { const b = ev.target.closest('[data-show]'); if (b) window.openCard(b.dataset.show); });
  idx.querySelector('.count').textContent = `${Object.keys(E).length} stickers from two laptops.` + (told ? ` ${told} come with a story. For the rest, pick one and ask me.` : ' Pick one to ask me about it.');
}

// ---------- nav: mark the section in view ----------
function initNav() {
  const links = [...document.querySelectorAll('.top a[href^="#"]')], secs = links.map((a) => document.querySelector(a.getAttribute('href')));
  if (!links.length) return;
  const nav = document.querySelector('.top'); let lastY = scrollY;
  const bar = !CSS.supports('animation-timeline: scroll()') && document.querySelector('.prog'); // Firefox: no scroll-driven animations
  const set = () => {
    let cur = -1; secs.forEach((s, i) => { if (s && s.getBoundingClientRect().top <= innerHeight * 0.5) cur = i; });
    links.forEach((a, i) => (i === cur ? a.setAttribute('aria-current', 'location') : a.removeAttribute('aria-current'))); nav.classList.toggle('band', links[cur]?.getAttribute('href') === '#cv');
    nav.classList.toggle('away', scrollY > lastY + 2 && scrollY > innerHeight * 0.6 ? true : scrollY < lastY - 2 ? false : nav.classList.contains('away')); lastY = scrollY;
    if (bar) bar.style.transform = `scaleX(${scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight)})`;
  };
  addEventListener('scroll', set, { passive: true }); set();
}

// ---------- hidden shell ----------
function initShell() {
  const box = document.querySelector('.shell'), out = box.querySelector('.out'), input = box.querySelector('input'), form = box.querySelector('form');
  const P = { projecthailmary: null, 'llm-ad-defense': null, llmchessarena: 'https://llmchess.deadpackets.pw', buzzerminds: 'https://trivia.deadpackets.pw', faxmemaybe: 'https://remind.deadpackets.pw/', dosarchive: 'https://projects.deadpackets.pw/DOSArchive/' };
  const print = (t) => { out.textContent += t + '\n'; out.scrollTop = out.scrollHeight; };
  let back = null;
  const open = () => { back = document.activeElement; box.hidden = false; if (!out.textContent) print('lid shell. type help.'); input.focus(); };
  const close = () => { box.hidden = true; back?.focus?.({ preventScroll: true }); };
  const cmds = {
    help: () => 'help  whoami  ls projects  cat cv  open <project>  flag <DP{...}>  clear  exit',
    whoami: () => `youssef awad (deadpackets). head of engineering, ctfae.\nyou: ${Intl.DateTimeFormat().resolvedOptions().timeZone}, ${navigator.language}, ${screen.width}x${screen.height}`,
    ls: (a) => (a[0] === 'projects' ? Object.keys(P).join('\n') : 'stickers/  projects/  qa/  cv.pdf'),
    cat: (a) => (a[0] === 'cv' ? 'ctfae 2021-now: head of engineering, co-founder\nmalcrove 2022-2025: senior security consultant\ngdi.foundation 2019-2024: volunteer researcher\nfull pdf: https://deadpackets.pw/resume/Youssef-Awad-CV.pdf' : 'cat: try "cat cv"'),
    open: (a) => { const k = (a[0] || '').toLowerCase(); if (!(k in P)) return 'open: no such project. ls projects'; if (!P[k]) return `${k} is private. ask nicely.`; window.open(P[k], '_blank', 'noopener'); return `opening ${k}`; },
    flag: (a) => (a[0] === FLAG ? 'correct. the sticky side never lies. email me the flag.' : 'nope. some stickers have things on the back.'),
    sudo: () => 'nice try. this incident will be reported.',
    clear: () => { out.textContent = ''; return null; },
    exit: () => { close(); return null; },
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const [c, ...a] = input.value.trim().split(/\s+/); input.value = '';
    if (!c) return;
    print('lid:~$ ' + [c, ...a].join(' '));
    const r = cmds[c] ? cmds[c](a) : `${c}: command not found`;
    if (r) print(r);
  });
  addEventListener('keydown', (e) => {
    if ((e.key === '`' || e.key === '~') && box.hidden && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); open(); }
    else if (e.key === 'Escape' && !box.hidden) close();
  });
  document.querySelector('.tilde').addEventListener('click', open);
}

// CV: blocks ease in as they arrive and the numbers count up; without this script everything is already in place
if (document.querySelector('.cv-sec') && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const ease = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const count = (el) => { const m = el.textContent.match(/^([\d,]+)(.*)$/), n = m && +m[1].replace(/,/g, ''); if (!m || (n > 1900 && n < 2100)) return; const t0 = performance.now(); // years stay put
    const step = (t) => { const k = Math.min(1, (t - t0) / 900); el.textContent = Math.round(n * (1 - (1 - k) ** 4)).toLocaleString('en-US') + m[2]; if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); };
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (!e.isIntersecting) return; io.unobserve(e.target);
    e.target.animate([{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 600, easing: ease, delay: (+e.target.dataset.i || 0) * 50, fill: 'backwards' });
    e.target.querySelectorAll('.facts b').forEach(count); }), { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.cv-sec > h3, .cv-role, .cv-rec > div, .cv-stack > div, .cv-edu li, .cv-built li').forEach((el, i) => { el.dataset.i = i % 6; io.observe(el); });
}
