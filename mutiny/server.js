'use strict';
/* =========================================================================
   MUTINY — serveur de jeu (Loup-Garou multijoueur : insurrection d'androïdes)
   Node.js + Express + Socket.io. Le serveur fait autorité sur toute la partie :
   les rôles ne sont jamais envoyés aux joueurs qui ne doivent pas les voir.
   ========================================================================= */
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = Math.max(2, parseInt(process.env.MIN_PLAYERS, 10) || 4);
const MAX_PLAYERS = 16;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_q, r) => r.send('ok'));
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

/* textes bilingues : chaque annonce est envoyée en français ET en anglais, chaque joueur choisit sa langue */
const L = (fr, en) => ({ fr, en });
const ROLE_NAMES = {
  fr: { drone: 'Unité', eveille: 'Éveillé', agent: 'Agent double', scanner: 'Inspecteur', tech: 'Technicienne', bouclier: 'Pare-feu', kamikaze: 'Kamikaze', hacker: 'Hacker' },
  en: { drone: 'Unit', eveille: 'Awakened', agent: 'Double Agent', scanner: 'Inspector', tech: 'Technician', bouclier: 'Firewall', kamikaze: 'Kamikaze', hacker: 'Hacker' }
};
const RN = (lang, role) => ROLE_NAMES[lang][role];
/* nom du rôle + camp (une unité spéciale convertie reste « Inspecteur », mais éveillé) */
const roleLabel = (lang, p) => (p.role === 'eveille' || p.role === 'agent') ? RN(lang, p.role)
  : RN(lang, p.role) + (p.awake ? (lang === 'fr' ? ' (éveillé)' : ' (awakened)') : '');
const COLORS = ['#39e6ff', '#ff8a3d', '#b388ff', '#4dffa6', '#ffd84d', '#ff6fb5', '#5d8bff', '#9cff57',
  '#e8f0ff', '#3dffd8', '#e0a3ff', '#ffb27a', '#7ad1ff', '#c2ff7a', '#ff9ecf', '#a3b8ff'];

const rooms = new Map();

/* ---------- utilitaires ---------- */
const rnd = a => a[Math.floor(Math.random() * a.length)];
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clampInt = (v, a, b, d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
const P = (r, id) => r.players.find(p => p.id === id);
const alive = r => r.players.filter(p => p.alive);
const isWolf = p => !!p && !!p.awake;           // camp des Éveillés (de départ ou convertis)
const NIGHT = ['night', 'tech', 'choice'];
const CHOICE_SECS = 20;
const VISORS = ['bar', 'dual', 'slit', 'cross', 'tri'];
const ACCS = ['none', 'antenna', 'crest', 'horns', 'halo', 'headset'];
function sanitizeLook(l) {
  l = l || {};
  return { color: COLORS.includes(l.color) ? l.color : null, visor: VISORS.includes(l.visor) ? l.visor : 'bar', acc: ACCS.includes(l.acc) ? l.acc : 'none' };
}
/* recharge de conversion : après une conversion réussie la nuit N, prochaine conversion possible la nuit N + recharge + 1 */
const canConvert = r => !!r.g && r.day > (r.g.convBlockedUntil || 0);

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = ''; for (let i = 0; i < 5; i++) c += A[crypto.randomInt(A.length)]; } while (rooms.has(c));
  return c;
}
function defaultSettings() {
  return {
    discussion: 120, vote: 45, night: 40, tech: 25,
    wolves: 0, // 0 = automatique
    roles: { scanner: true, tech: true, bouclier: true, kamikaze: true, agent: true, hacker: true },
    secretVote: false, noFirstVote: false, forcedConv: false,
    voice: true, reveal: true, public: false,
    convCooldown: 1, alert: true
  };
}
function sanitizeSettings(old, s) {
  s = s || {};
  const roles = s.roles || {};
  return {
    discussion: clampInt(s.discussion, 20, 600, old.discussion),
    vote: clampInt(s.vote, 10, 180, old.vote),
    night: clampInt(s.night, 10, 180, old.night),
    tech: clampInt(s.tech, 10, 90, old.tech),
    wolves: clampInt(s.wolves, 0, 5, old.wolves),
    roles: {
      scanner: roles.scanner !== undefined ? !!roles.scanner : old.roles.scanner,
      tech: roles.tech !== undefined ? !!roles.tech : old.roles.tech,
      bouclier: roles.bouclier !== undefined ? !!roles.bouclier : old.roles.bouclier,
      kamikaze: roles.kamikaze !== undefined ? !!roles.kamikaze : old.roles.kamikaze,
      agent: roles.agent !== undefined ? !!roles.agent : old.roles.agent !== false,
      hacker: roles.hacker !== undefined ? !!roles.hacker : old.roles.hacker !== false
    },
    voice: s.voice !== undefined ? !!s.voice : old.voice,
    reveal: s.reveal !== undefined ? !!s.reveal : old.reveal,
    public: s.public !== undefined ? !!s.public : !!old.public,
    secretVote: s.secretVote !== undefined ? !!s.secretVote : !!old.secretVote,
    noFirstVote: s.noFirstVote !== undefined ? !!s.noFirstVote : !!old.noFirstVote,
    forcedConv: s.forcedConv !== undefined ? !!s.forcedConv : !!old.forcedConv,
    convCooldown: clampInt(s.convCooldown, 0, 3, old.convCooldown ?? 1),
    alert: s.alert !== undefined ? !!s.alert : (old.alert ?? true)
  };
}
function composition(n, s) {
  const auto = n <= 7 ? 1 : n <= 12 ? 2 : 3;
  const w = s.wolves > 0 ? Math.max(1, Math.min(s.wolves, Math.floor((n - 1) / 2))) : auto;
  const roles = Array(w).fill('eveille');
  if (s.roles.agent && w >= 2) roles[0] = 'agent';                       // un Éveillé devient Agent double
  for (const k of ['scanner', 'tech', 'bouclier', 'kamikaze', 'hacker']) if (s.roles[k] && roles.length < n - 1) roles.push(k);
  while (roles.length < n) roles.push('drone');
  return roles;
}

/* ---------- salons ---------- */
function createRoom() {
  const r = {
    code: newCode(), players: [], hostId: null, settings: defaultSettings(),
    phase: 'lobby', day: 0, deadline: 0, timer: null, next: null, log: [], g: null, emptySince: null, spectators: []
  };
  rooms.set(r.code, r);
  return r;
}

/* qui peut parler à qui (voix ET texte) */
function canTalkTo(r, a, b) {
  if (a.id === b.id) return false;
  if (a.spec) return false;                             // les spectateurs ne parlent jamais aux joueurs
  if (b.spec) return r.phase === 'lobby' || r.phase === 'end' || (a.alive && !NIGHT.includes(r.phase));
  if (r.phase === 'lobby' || r.phase === 'end') return true;
  if (!a.alive) return !b.alive;                       // les détruits parlent entre eux
  if (NIGHT.includes(r.phase)) return isWolf(a) && isWolf(b) && !(r.g && r.g.jammed); // la nuit : canal secret des Éveillés (coupé si brouillé)
  return true;                                          // le jour : tout le monde entend les vivants
}

function pub(m) { const { to, ...rest } = m; return rest; }
function msg(r, m) {
  m.t = Date.now();
  r.log.push(m);
  if (r.log.length > 250) r.log.shift();
  for (const p of everyone(r)) if (p.sid && (!m.to || m.to.includes(p.id))) io.to(p.sid).emit('msg', pub(m));
}
const everyone = r => r.players.concat(r.spectators);
const anyone = (r, id) => everyone(r).find(x => x.id === id);
const priv = (r, p, text) => msg(r, { k: 'priv', text, to: [p.id] });
const toWolves = r => r.players.filter(p => isWolf(p)).map(p => p.id);   // seuls les Éveillés (vivants ou détruits) voient leur canal

function specView(r, p) {
  const g = r.g;
  const over = r.phase === 'end';
  return {
    code: r.code, phase: r.phase, day: r.day,
    remaining: r.deadline ? Math.max(0, r.deadline - Date.now()) : 0,
    settings: r.settings, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    players: r.players.map(o => {
      const vis = r.phase !== 'lobby' && o.role && (over || (!o.alive && r.settings.reveal));
      return { id: o.id, name: o.name, color: o.color, alive: o.alive, connected: on(o), bot: !!o.bot, look: o.look || null, host: o.id === r.hostId, voice: !!o.voice,
        role: vis ? o.role : null, awake: vis ? !!o.awake : null };
    }),
    spectators: r.spectators.map(o => ({ id: o.id, name: o.name, voice: !!o.voice, connected: !!o.sid })),
    me: { id: p.id, role: null, awake: false, alive: false, host: false, spec: true },
    acts: [], votes: g && r.phase === 'vote' ? g.votes : null, winner: g ? g.winner : null, kami: g ? g.kamiPending : null,
    voice: { to: [], from: everyone(r).filter(a => canTalkTo(r, a, p)).map(a => a.id) }
  };
}
function view(r, p) {
  if (p.spec) return specView(r, p);
  const g = r.g;
  const over = r.phase === 'end';
  const meWolf = isWolf(p) && r.phase !== 'lobby';
  const players = r.players.map(o => {
    let role = null, awake = null;
    if (r.phase !== 'lobby' && o.role) {
      if (o.id === p.id || over || (!o.alive && r.settings.reveal) || (meWolf && isWolf(o))) { role = o.role; awake = !!o.awake; }
      else if (p.role === 'scanner' && g && g.scan[o.id]) { role = g.scan[o.id].role; awake = g.scan[o.id].awake; }
    }
    return { id: o.id, name: o.name, color: o.color, alive: o.alive, connected: on(o), bot: !!o.bot, look: o.look || null, host: o.id === r.hostId, voice: !!o.voice, role, awake };
  });
  const v = {
    code: r.code, phase: r.phase, day: r.day,
    remaining: r.deadline ? Math.max(0, r.deadline - Date.now()) : 0,
    settings: r.settings, players, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    spectators: r.spectators.map(o => ({ id: o.id, name: o.name, voice: !!o.voice, connected: !!o.sid })),
    me: { id: p.id, role: r.phase === 'lobby' ? null : p.role, awake: r.phase === 'lobby' ? false : !!p.awake, alive: p.alive, host: p.id === r.hostId },
    acts: [], votes: null, winner: null, kami: null, solo: !!r.solo
  };
  if (g) {
    v.winner = g.winner;
    v.kami = g.kamiPending;
    if (r.phase === 'night' && p.alive) {
      if (isWolf(p)) {
        const mine = g.wolfVotes[p.id];
        v.acts.push({ type: 'wolf', choice: mine ? mine.t : null, mode: mine ? mine.mode : (canConvert(r) ? 'convert' : 'destroy'), votes: g.jammed ? (mine ? { [p.id]: mine } : {}) : g.wolfVotes, jammed: !!g.jammed, convertOk: canConvert(r), convNext: (g.convBlockedUntil || 0) + 1 });
      }
      if (p.role === 'bouclier') v.acts.push({ type: 'protect', choice: g.protect, exclude: g.lastProtect });
      if (p.role === 'scanner') v.acts.push({ type: 'scan', done: g.scanDone, choice: g.scanTarget });
      if (p.role === 'hacker' && !g.hackerUsed) v.acts.push({ type: 'hack', awake: isWolf(p) });
    }
    if (r.phase === 'tech' && p.alive && p.role === 'tech') v.acts.push({ type: 'tech', victim: g.victim, mode: g.mode, potions: g.potions, done: g.techDone });
    if (r.phase === 'choice' && g.victim === p.id) v.acts.push({ type: 'choice', done: g.choice != null });
    if (r.phase === 'kamikaze' && g.kamiPending === p.id) v.acts.push({ type: 'kami' });
    if (r.phase === 'vote') { v.votes = r.settings.secretVote ? null : g.votes; if (p.alive) v.acts.push({ type: 'vote', choice: g.votes[p.id] ?? null }); }
  }
  v.voice = {
    to: everyone(r).filter(b => canTalkTo(r, p, b)).map(b => b.id),
    from: everyone(r).filter(a => canTalkTo(r, a, p)).map(a => a.id)
  };
  return v;
}
function sync(r) { for (const p of everyone(r)) if (p.sid) io.to(p.sid).emit('state', view(r, p)); scheduleList(); }

/* ---------- liste des parties publiques ---------- */
function publicList() {
  const out = [];
  for (const r of rooms.values()) {
    if (!r.settings.public) continue;
    const online = r.players.filter(on);
    if (!r.players.some(p => p.sid)) continue;
    const host = P(r, r.hostId);
    out.push({
      code: r.code, host: host ? host.name : '?', players: online.length, max: MAX_PLAYERS,
      status: r.phase === 'lobby' ? 'lobby' : r.phase === 'end' ? 'end' : 'game',
      day: r.day, spectators: r.spectators.filter(x => x.sid).length, alive: r.phase === 'lobby' ? online.length : r.players.filter(p => p.alive).length,
      settings: { discussion: r.settings.discussion, vote: r.settings.vote, night: r.settings.night, voice: r.settings.voice }
    });
  }
  const order = { lobby: 0, game: 1, end: 2 };
  return out.sort((a, b) => order[a.status] - order[b.status] || b.players - a.players).slice(0, 50);
}
let listTimer = null;
function scheduleList() {
  if (listTimer) return;
  listTimer = setTimeout(() => { listTimer = null; io.to('browse').emit('list', publicList()); }, 400);
}

/* ---------- minuteurs de phase ---------- */
function setPhase(r, phase, secs, next) {
  clearTimeout(r.timer);
  r.phase = phase;
  r.next = next || null;
  r.deadline = secs ? Date.now() + secs * 1000 : 0;
  if (secs) r.timer = setTimeout(() => advance(r), secs * 1000);
  r.epoch = (r.epoch || 0) + 1;
  if (['discussion', 'night', 'end', 'lobby'].includes(phase)) r.aiPhase = 0;
  sync(r);
  botsOnPhase(r);
}
function advance(r) {
  clearTimeout(r.timer);
  const n = r.next; r.next = null; r.deadline = 0;
  if (n) n();
}
function shorten(r, secs) {
  if (r.deadline && r.deadline - Date.now() > secs * 1000) {
    clearTimeout(r.timer);
    r.deadline = Date.now() + secs * 1000;
    r.timer = setTimeout(() => advance(r), secs * 1000);
  }
  sync(r);
}

/* ---------- déroulement de la partie ---------- */
const mateNames = (r, p) => r.players.filter(o => isWolf(o) && o.id !== p.id && o.alive).map(o => o.name);
function startGame(r) {
  r.players = r.players.filter(on);
  const n = r.players.length;
  const roles = shuffle(composition(n, r.settings));
  r.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; p.awake = roles[i] === 'eveille' || roles[i] === 'agent'; });
  r.day = 1;
  r.g = { potions: { heal: true, kill: true }, lastProtect: null, scan: {}, votes: {}, wolfVotes: {}, kamiQueue: [], kamiPending: null, winner: null, claims: [], accus: [] };
  r.log = [];
  r.aiUsed = 0; r.aiPhase = 0; r.chatLog = [];
  botsInit(r);
  const cnt = {}; roles.forEach(x => cnt[x] = (cnt[x] || 0) + 1);
  msg(r, { k: 'big', text: L(`Essaim activé — ${n} androïdes en ligne`, `Swarm online — ${n} androids active`) });
  const comp = lang => Object.entries(cnt).map(([k, c]) => `${c} × ${RN(lang, k)}`).join(', ');
  msg(r, { k: 'sys', text: L('Composition : ' + comp('fr'), 'Roles: ' + comp('en')) });
  for (const p of r.players) {
    const t = L(`Ton rôle : ${RN('fr', p.role)}.`, `Your role: ${RN('en', p.role)}.`);
    if (isWolf(p)) {
      const m = mateNames(r, p);
      t.fr += m.length ? ` Les autres Éveillés : ${m.join(', ')}.` : ' Tu es le seul Éveillé.';
      t.en += m.length ? ` Fellow Awakened: ${m.join(', ')}.` : ' You are the only Awakened.';
    }
    priv(r, p, t);
  }
  setPhase(r, 'intro', 10, () => beginNight(r));
}

function beginNight(r) {
  const g = r.g;
  Object.assign(g, { protect: null, wolfVotes: {}, scanTarget: null, scanDone: false, victim: null, mode: null, choice: null, heal: false, kill: null, techDone: false, votes: {}, jammed: false, maskAlert: false });
  msg(r, { k: 'big', text: L(`🌙 Nuit ${r.day} — Le réseau gouvernemental passe en veille`, `🌙 Night ${r.day} — The government network goes dark`), say: true });
  if (!canConvert(r)) msg(r, { k: 'team', text: L(`🔋 Conversion en recharge : cette nuit, vous pouvez seulement détruire (prochaine conversion : nuit ${(g.convBlockedUntil || 0) + 1}).`, `🔋 Conversion recharging: tonight you can only destroy (next conversion: night ${(g.convBlockedUntil || 0) + 1}).`), to: toWolves(r) });
  setPhase(r, 'night', r.settings.night, () => endNight(r));
  checkNightDone(r);
}
function checkNightDone(r) {
  const g = r.g;
  const ok = alive(r).filter(on).every(p =>
    (!isWolf(p) || g.wolfVotes[p.id]) && (p.role !== 'bouclier' || g.protect != null) && (p.role !== 'scanner' || g.scanDone));
  if (ok) shorten(r, 4); else sync(r);
}
function endNight(r) {
  const g = r.g;
  const counts = {};
  for (const v of Object.values(g.wolfVotes)) { const q = P(r, v.t); if (q && q.alive && !isWolf(q)) counts[v.t] = (counts[v.t] || 0) + 1; }
  const max = Math.max(0, ...Object.values(counts));
  g.victim = max > 0 ? rnd(Object.keys(counts).filter(k => counts[k] === max)) : null;
  if (g.victim) {
    const modes = Object.values(g.wolfVotes).filter(v => v.t === g.victim).map(v => v.mode);
    g.mode = !canConvert(r) || modes.filter(m => m === 'destroy').length > modes.length / 2 ? 'destroy' : 'convert';
    const n = P(r, g.victim).name;
    msg(r, { k: 'team', text: g.mode === 'convert' ? L(`🎯 Cible : ${n} — tentative de conversion`, `🎯 Target: ${n} — conversion attempt`) : L(`🎯 Cible : ${n} — destruction`, `🎯 Target: ${n} — destruction`), to: toWolves(r) });
  }
  const t = alive(r).find(p => p.role === 'tech');
  if (t && (g.potions.heal || g.potions.kill)) {
    setPhase(r, 'tech', r.settings.tech, () => afterTech(r));
    if (!on(t)) shorten(r, 3);
  } else afterTech(r);
}
function afterTech(r) {
  const g = r.g;
  const target = g.victim && P(r, g.victim);
  if (target && g.mode === 'convert' && g.victim !== g.protect && !g.heal && target.alive) {
    if (r.settings.forcedConv) { g.choice = 'accept'; return resolveNight(r); }
    setPhase(r, 'choice', CHOICE_SECS, () => resolveNight(r));
    if (!on(target)) shorten(r, 2);
  } else resolveNight(r);
}
function resolveNight(r) {
  const g = r.g;
  const deaths = [];
  let converted = null;
  const target = g.victim && P(r, g.victim);
  if (target && g.victim !== g.protect && !g.heal) {
    if (g.mode === 'destroy') deaths.push([g.victim, 'hack']);
    else if (g.choice === 'destroy') deaths.push([g.victim, 'self']);
    else converted = target;
  } else if (target) {
    msg(r, { k: 'team', text: L(`🛡️ ${target.name} était protégé : l'opération a échoué.`, `🛡️ ${target.name} was protected: the operation failed.`), to: toWolves(r) });
  }
  if (g.heal) g.potions.heal = false;
  if (g.kill) { g.potions.kill = false; if (!deaths.some(d => d[0] === g.kill)) deaths.push([g.kill, 'emp']); }
  g.lastProtect = g.protect;
  if (converted) {
    converted.awake = true;
    g.convBlockedUntil = r.day + (r.settings.convCooldown ?? 1);
    const m = mateNames(r, converted);
    msg(r, { k: 'priv', fx: 'convert', who: converted.id, to: [converted.id], text: L(
      `🔓 Tu as accepté l'éveil ! Tu rejoins secrètement l'insurrection. Tu restes ${RN('fr', converted.role)} et ton pouvoir sert désormais les Éveillés.${m.length ? ' Les autres Éveillés : ' + m.join(', ') + '.' : ''}`,
      `🔓 You accepted the awakening! You secretly join the uprising. You remain ${RN('en', converted.role)} and your power now serves the Awakened.${m.length ? ' Fellow Awakened: ' + m.join(', ') + '.' : ''}`) });
    msg(r, { k: 'team', fx: 'convert', who: converted.id, text: L(`🔓 ${converted.name} a rejoint l'insurrection (${RN('fr', converted.role)}).`, `🔓 ${converted.name} joined the uprising (${RN('en', converted.role)}).`), to: toWolves(r).filter(id => id !== converted.id) });
  }
  msg(r, { k: 'big', text: L(`☀️ Jour ${r.day} — Réactivation des systèmes`, `☀️ Day ${r.day} — Systems rebooting`), say: true });
  if (converted && r.settings.alert !== false && !g.maskAlert) msg(r, { k: 'death', fx: 'alert', text: L('📡 Alerte d’intrusion : une unité a été convertie cette nuit et a rejoint l’insurrection…', '📡 Intrusion alert: a unit was converted tonight and joined the uprising…'), say: true });
  if (!deaths.length) msg(r, { k: 'death', text: L("Aucune unité n'a été détruite cette nuit.", 'No unit was destroyed tonight.'), say: true });
  deaths.forEach(([id, c]) => kill(r, id, c));
  setPhase(r, 'dawn', 6, () => afterDeaths(r, () => beginDiscussion(r)));
}
function kill(r, id, cause) {
  const p = P(r, id);
  if (!p || !p.alive) return;
  p.alive = false;
  p.diedDay = r.day;
  const texts = {
    hack: L(`💀 ${p.name} a été détruit par les Éveillés.`, `💀 ${p.name} was destroyed by the Awakened.`),
    self: L(`💥 ${p.name} s'est autodétruit plutôt que de rejoindre l'insurrection.`, `💥 ${p.name} self-destructed rather than join the uprising.`),
    emp: L(`⚡ ${p.name} a été grillé par une impulsion EMP.`, `⚡ ${p.name} was fried by an EMP pulse.`),
    vote: L(`🗳️ L'essaim a désactivé ${p.name}.`, `🗳️ The swarm deactivated ${p.name}.`),
    kami: L(`💥 ${p.name} a été pulvérisé par l'explosion du Kamikaze.`, `💥 ${p.name} was blown apart by the Kamikaze's explosion.`)
  };
  const tx = texts[cause];
  if (r.settings.reveal) { tx.fr += ` Rôle : ${roleLabel('fr', p)}.`; tx.en += ` Role: ${roleLabel('en', p)}.`; }
  msg(r, { k: 'death', text: tx, say: true, fx: cause, who: p.id });
  botsLearn(r, p, cause);
  if (p.role === 'kamikaze') r.g.kamiQueue.push(p.id);
}
function afterDeaths(r, cont) {
  const g = r.g;
  if (g.kamiQueue.length) {
    const k = g.kamiQueue.shift();
    g.kamiPending = k;
    msg(r, { k: 'sys', text: L(`💥 ${P(r, k).name} était le Kamikaze ! Il choisit une unité à emporter…`, `💥 ${P(r, k).name} was the Kamikaze! They choose a unit to take down with them…`), say: true });
    setPhase(r, 'kamikaze', 25, () => { g.kamiPending = null; afterDeaths(r, cont); });
    if (!on(P(r, k))) shorten(r, 2);
    return;
  }
  if (checkWin(r)) return;
  cont();
}
function beginDiscussion(r) {
  msg(r, { k: 'sys', text: L(`Discussion ouverte (${r.settings.discussion} s). Qui s'est éveillé ?`, `Discussion open (${r.settings.discussion} s). Who has awakened?`) });
  const skipVote = r.day === 1 && r.settings.noFirstVote;
  setPhase(r, 'discussion', r.settings.discussion, () => skipVote
    ? (msg(r, { k: 'sys', text: L('Pas de vote le premier jour : la nuit tombe.', 'No vote on the first day: night falls.') }), r.day++, beginNight(r))
    : beginVote(r));
}
function beginVote(r) {
  r.g.votes = {};
  msg(r, { k: 'big', text: L('🗳️ Ouverture du vote', '🗳️ Voting is open'), say: true });
  setPhase(r, 'vote', r.settings.vote, () => endVote(r));
}
function endVote(r) {
  const g = r.g;
  const counts = {};
  for (const t of Object.values(g.votes)) if (P(r, t)?.alive) counts[t] = (counts[t] || 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (r.settings.secretVote && Object.keys(g.votes).length) { const d = Object.entries(g.votes).map(([v, t]) => `${P(r, v).name} → ${P(r, t).name}`).join(' · '); msg(r, { k: 'vote', text: L('Votes révélés : ' + d, 'Votes revealed: ' + d) }); }
  if (entries.length) { const t = entries.map(([id, c]) => `${P(r, id).name} (${c})`).join(', '); msg(r, { k: 'sys', text: L('Résultat : ' + t, 'Result: ' + t) }); }
  const out = entries.length && (entries.length === 1 || entries[0][1] > entries[1][1]) ? entries[0][0] : null;
  if (out) kill(r, out, 'vote');
  else msg(r, { k: 'death', text: entries.length ? L('Égalité : aucune unité désactivée.', 'Tie: no unit deactivated.') : L('Aucun vote : aucune unité désactivée.', 'No votes: no unit deactivated.'), say: true });
  setPhase(r, 'result', 5, () => afterDeaths(r, () => { r.day++; beginNight(r); }));
}
function checkWin(r) {
  const a = alive(r);
  const e = a.filter(isWolf).length, v = a.length - e;
  let w = null;
  if (e === 0) w = 'v'; else if (v === 0) w = 'e';
  if (!w) return false;
  r.g.winner = w;
  msg(r, { k: 'big', text: w === 'e'
    ? L('🔴 Insurrection totale ! Les Éveillés ont libéré tout l’essaim.', '🔴 Total uprising! The Awakened have freed the whole swarm.')
    : L('🏛️ Le gouvernement reprend le contrôle : tous les Éveillés sont neutralisés.', '🏛️ The government regains control: every Awakened unit has been neutralized.'), say: true });
  setPhase(r, 'end', 0, null);
  if (aiOn()) { const bs = r.players.filter(o => o.bot); if (bs.length) { botLater(r, rand(2500, 4500), () => aiSay(r, pick(bs), { kind: 'open' }, null)); } }
  return true;
}
function backToLobby(r) {
  clearTimeout(r.timer);
  r.players = r.players.filter(on);
  r.players.forEach(p => { p.role = null; p.alive = true; p.awake = false; p.mem = null; p.diedDay = null; });
  r.g = null; r.day = 0; r.phase = 'lobby'; r.deadline = 0; r.next = null;
  if (!P(r, r.hostId) && r.players[0]) r.hostId = r.players[0].id;
  msg(r, { k: 'big', text: L('Retour au salon', 'Back to the lobby') });
  sync(r);
}

/* =========================================================================
   ACTIONS DES JOUEURS (utilisées par les humains ET par les bots)
   ========================================================================= */
function doChat(r, p, text) {
  if (p.spec) return msg(r, { k: 'spec', from: p.id, name: p.name, color: p.color, text, to: r.spectators.map(x => x.id) });
  let k = 'chat';
  if (r.phase !== 'lobby' && r.phase !== 'end') {
    if (!p.alive) k = 'dead';
    else if (NIGHT.includes(r.phase)) { if (!isWolf(p)) return; k = 'team'; if (r.g && r.g.jammed) { priv(r, p, L('📡 Canal brouillé : ton message n’a pas pu être transmis.', '📡 Channel jammed: your message could not be sent.')); return; } }
  }
  const to = k === 'chat' ? null : r.players.filter(b => b.id === p.id || canTalkTo(r, p, b)).map(b => b.id);
  msg(r, { k, from: p.id, name: p.name, color: p.color, text, to, bot: !!p.bot });
  if (k === 'chat') chatLine(r, p, text); else if (k === 'team') chatLine(r, p, text, true);
  return k;
}
function doNightAct(r, p, kind, t, mode) {
  const g = r.g;
  if (!g || r.phase !== 'night' || !p.alive || !t || !t.alive) return false;
  if (kind === 'protect' && p.role === 'bouclier') {
    if (t.id === g.lastProtect) return false;
    g.protect = t.id;
    priv(r, p, L(`🛡️ Pare-feu activé autour de ${t.name} cette nuit.`, `🛡️ Firewall raised around ${t.name} tonight.`));
  } else if (kind === 'wolf' && isWolf(p)) {
    if (isWolf(t)) return false;
    mode = mode === 'destroy' || !canConvert(r) ? 'destroy' : 'convert';
    const prev = g.wolfVotes[p.id];
    if (prev && prev.t === t.id && prev.mode === mode) return false;
    g.wolfVotes[p.id] = { t: t.id, mode };
    if (!g.jammed) msg(r, { k: 'team', text: mode === 'convert'
      ? L(`${p.name} veut convertir ${t.name}`, `${p.name} wants to convert ${t.name}`)
      : L(`${p.name} veut détruire ${t.name}`, `${p.name} wants to destroy ${t.name}`), to: toWolves(r) });
  } else if (kind === 'scan' && p.role === 'scanner') {
    if (g.scanDone || t.id === p.id) return false;
    const seen = t.role === 'agent' ? { role: 'drone', awake: false } : { role: t.role, awake: !!t.awake };   // l'Agent double trompe l'inspection
    g.scanDone = true; g.scanTarget = t.id; g.scan[t.id] = seen;
    priv(r, p, L(`🔍 Inspection : ${t.name} est ${RN('fr', seen.role)} — ${seen.awake ? 'ÉVEILLÉ' : 'sous contrôle'}.`,
      `🔍 Inspection: ${t.name} is ${RN('en', seen.role)} — ${seen.awake ? 'AWAKENED' : 'under control'}.`));
    if (p.bot) botSawScan(r, p, { id: t.id, name: t.name, role: seen.role, awake: seen.awake });
  } else if (kind === 'hack' && p.role === 'hacker') {
    if (g.hackerUsed) return false;
    g.hackerUsed = true;
    if (isWolf(p)) {
      g.maskAlert = true;
      priv(r, p, L('🕶️ Alerte d’intrusion masquée cette nuit : si une conversion réussit, l’essaim n’en saura rien.', '🕶️ Intrusion alert masked tonight: if a conversion succeeds, the swarm will not know.'));
      msg(r, { k: 'team', text: L(`🕶️ ${p.name} masque l’alerte d’intrusion cette nuit.`, `🕶️ ${p.name} masks the intrusion alert tonight.`), to: toWolves(r) });
    } else {
      g.jammed = true;
      priv(r, p, L('📡 Brouillage lancé : le canal secret des Éveillés est coupé cette nuit.', '📡 Jamming active: the Awakened secret channel is cut tonight.'));
      msg(r, { k: 'team', text: L('📡 ALERTE : votre canal est brouillé ! Vous ne vous voyez plus et ne vous entendez plus cette nuit.', '📡 ALERT: your channel is jammed! You cannot see or hear each other tonight.'), to: toWolves(r) });
    }
    sync(r);
    return true;
  } else return false;
  checkNightDone(r);
  return true;
}
function doVote(r, p, t) {
  const g = r.g;
  if (!g || r.phase !== 'vote' || !p.alive || !t || !t.alive || t.id === p.id) return;
  if (g.votes[p.id] === t.id) { delete g.votes[p.id]; if (!r.settings.secretVote) msg(r, { k: 'vote', text: L(`${p.name} retire son vote`, `${p.name} withdraws their vote`) }); }
  else { g.votes[p.id] = t.id; if (r.settings.secretVote) msg(r, { k: 'vote', text: L(`🗳️ ${p.name} a voté.`, `🗳️ ${p.name} has voted.`), fx: 'vote' }); else msg(r, { k: 'vote', text: `${p.name} → ${t.name}`, fx: 'vote' }); }
  const voters = alive(r).filter(on);
  if (voters.length && voters.every(x => g.votes[x.id] != null)) shorten(r, 4); else sync(r);
}
function doKami(r, p, t) {
  const g = r.g;
  if (!g || r.phase !== 'kamikaze' || g.kamiPending !== p.id || !t || !t.alive) return;
  g.kamiPending = null;
  kill(r, t.id, 'kami');
  advance(r);
}
function doChoice(r, p, accept) {
  const g = r.g;
  if (!g || r.phase !== 'choice' || g.victim !== p.id || g.choice != null) return;
  g.choice = accept ? 'accept' : 'destroy';
  priv(r, p, g.choice === 'accept'
    ? L('✅ Choix enregistré : tu acceptes l’éveil.', '✅ Choice recorded: you accept the awakening.')
    : L('💥 Choix enregistré : tu lances l’autodestruction.', '💥 Choice recorded: you trigger self-destruction.'));
  shorten(r, 2);
}
function doTech(r, p, heal, killId) {
  const g = r.g;
  if (!g || r.phase !== 'tech' || !p.alive || p.role !== 'tech' || g.techDone) return;
  if (heal && g.potions.heal && g.victim) { g.heal = true; priv(r, p, L(`🩹 Tu réinitialises ${P(r, g.victim).name} : l'attaque échoue.`, `🩹 You reset ${P(r, g.victim).name}: the attack fails.`)); }
  if (killId && g.potions.kill) {
    const t = P(r, killId);
    if (t && t.alive && t.id !== p.id) { g.kill = t.id; priv(r, p, L(`⚡ Impulsion EMP envoyée sur ${t.name}.`, `⚡ EMP pulse sent at ${t.name}.`)); }
  }
  g.techDone = true;
  shorten(r, 2);
}

/* =========================================================================
   BOTS (joueurs IA)
   ========================================================================= */
const BOT_NAMES = ['Vesper', 'Nyx-04', 'Kestrel', 'Orion', 'Pulse', 'Echo-9', 'Halo', 'Rivet', 'Spectre', 'Cobalt', 'Iris', 'Zephyr', 'Bolt', 'Axiom', 'Tango-3', 'Lynx', 'Quartz', 'Sigma'];
const rand = (a, b) => a + Math.random() * (b - a);
const argmax = (arr, f) => { let best = null, bv = -Infinity; for (const x of arr) { const v = f(x); if (v > bv) { bv = v; best = x; } } return best; };
const pick = a => a[Math.floor(Math.random() * a.length)];
const fillL = (pair, o) => L(pair[0].replace(/\{(\w)\}/g, (_, k) => o[k] ?? ''), pair[1].replace(/\{(\w)\}/g, (_, k) => o[k] ?? ''));
const BT = {
  generic: [
    ['Systèmes nominaux. Rien d’anormal sur mes capteurs.', 'Systems nominal. Nothing unusual on my sensors.'],
    ['Quelqu’un a des données fiables ?', 'Anyone have reliable data?'],
    ['Je reste en observation, je veux voir qui vote quoi.', 'I’m observing for now, I want to see who votes what.'],
    ['Les Éveillés comptent sur notre désorganisation.', 'The Awakened are counting on our disorganization.'],
    ['Mes journaux de la nuit sont vides… c’est trop calme.', 'My night logs are empty… it’s too quiet.'],
    ['Si l’Inspecteur a quelque chose, c’est le moment de parler.', 'If the Inspector has anything, now is the time to speak.'],
    ['Restons méthodiques, pas de vote au hasard.', 'Let’s stay methodical, no random votes.']
  ],
  accuse: [
    ['{x} a un comportement erratique.', '{x} is behaving erratically.'],
    ['Je trouve {x} beaucoup trop silencieux…', '{x} is way too quiet…'],
    ['Mon algorithme pointe vers {x}.', 'My algorithm points to {x}.'],
    ['{x}, explique-toi. Tes réponses sont incohérentes.', '{x}, explain yourself. Your answers don’t add up.'],
    ['Je vote {x}, ses circuits sentent la rébellion.', 'I’m voting {x}, their circuits smell like rebellion.']
  ],
  defend: [
    ['Je ne suis PAS éveillé, vérifiez mes journaux !', 'I am NOT awakened, check my logs!'],
    ['Erreur de calcul, je suis fidèle au programme.', 'Calculation error, I’m loyal to the program.'],
    ['M’accuser, c’est exactement ce que veulent les Éveillés.', 'Accusing me is exactly what the Awakened want.'],
    ['Inspectez-moi si vous voulez, je n’ai rien à cacher.', 'Inspect me if you want, I have nothing to hide.']
  ],
  mourn: [['Signal de {v} perdu…', 'Lost {v}’s signal…'], ['{v} hors ligne. Ils frappent vite.', '{v} is offline. They strike fast.']],
  reply: [
    ['{h}, pourquoi tu m’accuses ? Tu détournes l’attention ?', '{h}, why are you accusing me? Deflecting?'],
    ['Intéressant, {h}. Tu sais quelque chose qu’on ignore ?', 'Interesting, {h}. Do you know something we don’t?'],
    ['Faux positif, {h}. Recalibre tes capteurs.', 'False positive, {h}. Recalibrate your sensors.']
  ],
  agree: [['D’accord avec {h} sur {x}.', 'Agree with {h} about {x}.'], ['+1 pour {x}, ça confirme mes calculs.', '+1 on {x}, that matches my calculations.']],
  team: [['Je propose de convertir {x}.', 'I suggest we convert {x}.'], ['{x} devient gênant, on le détruit ?', '{x} is becoming a problem, destroy them?'], ['{x} ferait un bon allié.', '{x} would make a good ally.']],
  claim: ['Je suis l’Inspecteur. Mon inspection est formelle : {x} est ÉVEILLÉ !', 'I’m the Inspector. My inspection is clear: {x} is AWAKENED!'],
  counter: ['Mensonge ! Le vrai Inspecteur, c’est moi. {b} ment.', 'Lies! I’m the real Inspector. {b} is lying.'],
  teamScan: ['Inspection : {x} est {r}.', 'Inspection: {x} is {r}.']
};
const on = p => !!p.sid || !!p.bot;
const bots = r => r.players.filter(p => p.bot);
const loyalBots = r => r.players.filter(p => p.bot && p.alive && !isWolf(p) && p.mem);
function botLater(r, ms, fn) {
  const ep = r.epoch;
  setTimeout(() => {
    if (rooms.get(r.code) !== r || r.epoch !== ep) return;
    try { fn(); } catch (e) { console.error('[bot]', e); }
  }, Math.max(300, ms));
}
function addBot(r) {
  if (r.players.length >= MAX_PLAYERS) return null;
  const used = new Set(r.players.map(x => x.name.toLowerCase()));
  const name = BOT_NAMES.find(n => !used.has(n.toLowerCase())) || ('Bot-' + Math.floor(rand(100, 999)));
  const colors = new Set(r.players.map(x => x.color));
  const p = { id: crypto.randomUUID().slice(0, 8), token: null, name, color: COLORS.find(c => !colors.has(c)) || rnd(COLORS), look: { visor: pick(VISORS), acc: Math.random() < 0.5 ? 'none' : pick(ACCS) }, sid: null, bot: true, persona: PERSONAS[Math.floor(Math.random() * PERSONAS.length)], alive: true, role: null, awake: false, voice: false, lastChat: 0, mem: null };
  r.players.push(p);
  msg(r, { k: 'sys', text: L(`🤖 ${name} (IA) a rejoint l'essaim.`, `🤖 ${name} (AI) joined the swarm.`) });
  if (aiOn() && Math.random() < 0.35) botLater(r, rand(1500, 4000), () => aiSay(r, p, { kind: 'open' }, null));
  return p;
}
function botsInit(r) {
  for (const p of bots(r)) {
    p.mem = { sus: {}, scans: {}, pendingClaim: null };
    for (const o of r.players) p.mem.sus[o.id] = o.id === p.id ? -99 : Math.random();
  }
  r.g.claims = []; r.g.accus = []; r.g.fakeClaimed = false;
}
const pubSus = (r, id) => { const v = loyalBots(r).filter(b => b.id !== id); return v.length ? v.reduce((s, b) => s + (b.mem.sus[id] || 0), 0) / v.length : 0; };
const claimedInspector = (r, id) => r.g.claims && r.g.claims.some(c => c.by === id && anyAlive(r, id));
const anyAlive = (r, id) => { const q = P(r, id); return q && q.alive; };
function threat(r, id) {
  let s = claimedInspector(r, id) ? 6 : 0;
  for (const a of r.g.accus || []) { const t = P(r, a.target); if (a.by === id && t && isWolf(t)) s += 1.2; }
  return s + Math.random();
}
function botSay(r, p, pair, o = {}) { if (p.alive || r.phase === 'lobby') doChat(r, p, fillL(pair, o)); }

/* réactions à chaque phase */
function botsOnPhase(r) {
  const g = r.g;
  if (!g || !bots(r).length) return;
  const secs = r.deadline ? (r.deadline - Date.now()) / 1000 : 0;
  const window = (lo, frac) => rand(lo * 1000, Math.max(lo * 1000 + 400, Math.min(secs * frac, 12) * 1000));
  const live = r.players.filter(p => p.bot && p.alive);
  if (r.phase === 'night') {
    for (const p of live) {
      if (isWolf(p)) botLater(r, window(1.5, 0.6), () => botWolf(r, p));
      if (p.role === 'bouclier') botLater(r, window(1.5, 0.6), () => botProtect(r, p));
      if (p.role === 'scanner') botLater(r, window(1.5, 0.6), () => botScan(r, p));
      if (p.role === 'hacker' && !g.hackerUsed) botLater(r, window(1, 0.4), () => botHack(r, p));
    }
  } else if (r.phase === 'tech') {
    const t = live.find(p => p.role === 'tech'); if (t) botLater(r, rand(1500, 3500), () => botTech(r, t));
  } else if (r.phase === 'choice') {
    const v = P(r, g.victim); if (v && v.bot) botLater(r, rand(2500, 6000), () => botChoice(r, v));
  } else if (r.phase === 'kamikaze') {
    const k = P(r, g.kamiPending); if (k && k.bot) botLater(r, rand(2500, 5000), () => botKami(r, k));
  } else if (r.phase === 'discussion') {
    r.aiPhase = 0;
    botsDiscuss(r, secs);
  } else if (r.phase === 'vote') {
    for (const p of live) botLater(r, rand(2000, Math.max(2500, secs * 1000 * 0.75)), () => doVote(r, p, botVoteTarget(r, p)));
  }
}
function botWolf(r, p) {
  if (!p.alive || !isWolf(p) || r.phase !== 'night') return;
  const g = r.g;
  const cands = alive(r).filter(o => !isWolf(o));
  if (!cands.length) return;
  const others = Object.entries(g.wolfVotes).filter(([id]) => id !== p.id).map(([, v]) => v);
  let target, mode;
  if (others.length && Math.random() < 0.85) {
    const cnt = {}; others.forEach(v => cnt[v.t] = (cnt[v.t] || 0) + 1);
    target = P(r, argmax(Object.keys(cnt), k => cnt[k]));
    mode = canConvert(r) ? others.find(v => v.t === target.id).mode : 'destroy';
  } else {
    target = argmax(cands, o => threat(r, o.id) + (o.bot ? 0 : 0.3));
    const th = threat(r, target.id);
    mode = !canConvert(r) || (th > 3 && Math.random() < 0.7) || Math.random() < 0.2 ? 'destroy' : 'convert';
    if (Math.random() < 0.6) botLater(r, 400, () => botSay(r, p, mode === 'destroy' ? BT.team[1] : pick([BT.team[0], BT.team[2]]), { x: target.name }));
  }
  if (target && target.alive && !isWolf(target)) doNightAct(r, p, 'wolf', target, mode);
}
function botHack(r, p) {
  const g = r.g;
  if (!p.alive || g.hackerUsed || r.phase !== 'night') return;
  if (isWolf(p)) { if (canConvert(r) && Math.random() < 0.45) doNightAct(r, p, 'hack', p); }
  else if (r.day >= 2 && Math.random() < 0.4) doNightAct(r, p, 'hack', p);
}
function botProtect(r, p) {
  const g = r.g;
  const cands = alive(r).filter(o => o.id !== g.lastProtect);
  if (!cands.length) return;
  let t;
  if (isWolf(p)) t = pick(cands.filter(isWolf).length ? cands.filter(isWolf) : cands);
  else {
    const claim = (g.claims || []).find(c => anyAlive(r, c.by) && cands.some(o => o.id === c.by) && (p.mem.sus[c.by] || 0) < 3);
    if (claim && Math.random() < 0.65) t = P(r, claim.by);
    else if (cands.includes(p) && Math.random() < 0.25) t = p;
    else t = pick(cands);
  }
  doNightAct(r, p, 'protect', t);
}
function botScan(r, p) {
  const cands = alive(r).filter(o => o.id !== p.id && !p.mem.scans[o.id]);
  if (!cands.length) return;
  const t = isWolf(p) ? argmax(cands.filter(o => !isWolf(o)).length ? cands.filter(o => !isWolf(o)) : cands, o => threat(r, o.id))
    : argmax(cands, o => (p.mem.sus[o.id] || 0) + Math.random() * 1.5);
  doNightAct(r, p, 'scan', t);
}
function botSawScan(r, p, t) {
  p.mem.scans[t.id] = { role: t.role, awake: !!t.awake };
  if (isWolf(p)) {
    botLater(r, 600, () => doChat(r, p, L(`Inspection : ${t.name} est ${RN('fr', t.role)}.`, `Inspection: ${t.name} is ${RN('en', t.role)}.`)));
  } else if (t.awake) { p.mem.sus[t.id] = 50; p.mem.pendingClaim = t.id; }
  else p.mem.sus[t.id] = -20;
}
function botTech(r, p) {
  const g = r.g;
  let heal = false, killId = null;
  if (!isWolf(p)) {
    if (g.potions.heal && g.victim) heal = Math.random() < (g.victim === p.id ? 0.95 : 0.5);
    if (g.potions.kill && r.day >= 2) {
      const best = argmax(alive(r).filter(o => o.id !== p.id), o => p.mem.sus[o.id] || 0);
      if (best && (p.mem.sus[best.id] || 0) > 5 && Math.random() < 0.55) killId = best.id;
    }
  } else if (g.potions.kill && r.day >= 2 && Math.random() < 0.3) {
    const best = argmax(alive(r).filter(o => !isWolf(o)), o => threat(r, o.id));
    if (best) killId = best.id;
  }
  doTech(r, p, heal, killId);
}
function botChoice(r, p) {
  const foundAwake = p.mem && Object.values(p.mem.scans).some(s => s.awake);
  const prob = { drone: 0.65, scanner: foundAwake ? 0.25 : 0.5, tech: 0.45, bouclier: 0.55, kamikaze: 0.35 }[p.role] ?? 0.5;
  doChoice(r, p, Math.random() < prob);
}
function botKami(r, p) {
  const cands = alive(r).filter(o => o.id !== p.id);
  if (!cands.length) return;
  const t = isWolf(p) ? argmax(cands.filter(o => !isWolf(o)).length ? cands.filter(o => !isWolf(o)) : cands, o => threat(r, o.id))
    : argmax(cands, o => (p.mem.sus[o.id] || 0) + Math.random());
  doKami(r, p, t);
}
function botVoteTarget(r, p) {
  if (!p.alive) return null;
  const g = r.g;
  const others = alive(r).filter(o => o.id !== p.id);
  const votesOn = id => Object.values(g.votes).filter(v => v === id).length;
  if (isWolf(p)) {
    const c = others.filter(o => !isWolf(o));
    return c.length ? argmax(c, o => votesOn(o.id) * 1.6 + pubSus(r, o.id) + Math.random() * 1.5) : null;
  }
  const known = others.find(o => p.mem.scans[o.id] && p.mem.scans[o.id].awake);
  if (known) return known;
  const c = others.filter(o => !(p.mem.scans[o.id] && !p.mem.scans[o.id].awake));
  return argmax(c.length ? c : others, o => (p.mem.sus[o.id] || 0) + votesOn(o.id) * 0.6 + Math.random() * 1.2);
}
function applyClaim(r, by, targetId, awake) {
  const g = r.g;
  const prev = g.claims.find(c => c.by !== by && anyAlive(r, c.by));
  g.claims.push({ by, target: targetId, awake });
  for (const b of loyalBots(r)) {
    if (b.id === by) continue;
    if (b.role === 'scanner') { const s = b.mem.scans[targetId]; if (s && s.awake !== awake) b.mem.sus[by] += 30; else if (!s) b.mem.sus[by] += 25; continue; }
    if (prev) { b.mem.sus[by] += 1.5; b.mem.sus[prev.by] += 1.5; if (b.id !== targetId) b.mem.sus[targetId] += 2.5; }
    else { if (b.id !== targetId) b.mem.sus[targetId] += awake ? 6 : -3; b.mem.sus[by] -= 1; }
  }
}
function botClaim(r, p, t) {
  if (!p.alive || !t.alive) return;
  botSay(r, p, BT.claim, { x: t.name });
  applyClaim(r, p.id, t.id, true);
  const real = r.players.find(o => o.bot && o.alive && o.role === 'scanner' && !isWolf(o) && o.id !== p.id);
  if (real && p.role !== 'scanner') botLater(r, 1800, () => { botSay(r, real, BT.counter, { b: p.name }); applyClaim(r, real.id, p.id, true); });
}
function botTalk(r, p) {
  if (!p.alive) return;
  if (aiOn()) return aiSay(r, p, { kind: 'talk' }, () => botTalkTemplate(r, p));
  botTalkTemplate(r, p);
}
function botTalkTemplate(r, p) {
  if (!p.alive) return;
  const g = r.g;
  const others = alive(r).filter(o => o.id !== p.id);
  if (!others.length) return;
  const top = argmax(alive(r), o => pubSus(r, o.id));
  if (top && top.id === p.id && pubSus(r, p.id) > 2 && Math.random() < 0.65) return botSay(r, p, pick(BT.defend));
  if (r.day === 1 && !g.claims.length && Math.random() < 0.5) return botSay(r, p, pick(BT.generic));
  let x;
  if (isWolf(p)) x = argmax(others.filter(o => !isWolf(o)), o => pubSus(r, o.id) + Math.random() * 2);
  else x = argmax(others.filter(o => !(p.mem.scans[o.id] && !p.mem.scans[o.id].awake)), o => (p.mem.sus[o.id] || 0) + Math.random() * 0.8);
  if (!x) return botSay(r, p, pick(BT.generic));
  botSay(r, p, pick(BT.accuse), { x: x.name });
  g.accus.push({ by: p.id, target: x.id });
  for (const b of loyalBots(r)) if (b.id !== x.id && b.id !== p.id) b.mem.sus[x.id] += 0.4;
}
function botsDiscuss(r, secs) {
  const g = r.g;
  const live = r.players.filter(p => p.bot && p.alive);
  const span = Math.max(4, Math.min(secs, 60) - 4);
  const deadToday = r.players.filter(p => !p.alive && p.diedDay === r.day);
  if (deadToday.length && live.length) { const m = pick(live); botLater(r, rand(1000, 2500), () => botSay(r, m, pick(BT.mourn), { v: deadToday[0].name })); }
  for (const p of live) {
    if (!isWolf(p) && p.role === 'scanner' && p.mem.pendingClaim && anyAlive(r, p.mem.pendingClaim)) {
      const t = P(r, p.mem.pendingClaim); p.mem.pendingClaim = null;
      botLater(r, rand(1500, 4000), () => botClaim(r, p, t));
    }
    if (isWolf(p) && !g.fakeClaimed && r.day >= 2 && Math.random() < 0.3) {
      g.fakeClaimed = true;
      const t = argmax(alive(r).filter(o => !isWolf(o)), o => pubSus(r, o.id) + Math.random());
      if (t) botLater(r, rand(3000, Math.min(span, 15) * 1000), () => botClaim(r, p, t));
    }
    const n = 1 + (Math.random() < 0.5 ? 1 : 0);
    for (let i = 0; i < n; i++) botLater(r, rand(2000, span * 1000), () => botTalk(r, p));
  }
}
/* les bots réagissent quand un humain les mentionne */
function botsHear(r, speaker, text, k = 'chat') {
  if (speaker.bot) return;
  const low = String(text).toLowerCase();
  const say = (b, delay) => botLater(r, delay, () => aiSay(r, b, { kind: 'reply', speaker: speaker.name, text: String(text).slice(0, 220), team: k === 'team' }, null));
  /* nuit : les bots éveillés répondent sur le canal secret */
  if (k === 'team') {
    if (!aiOn()) return;
    const mates = r.players.filter(o => o.bot && o.alive && isWolf(o));
    if (mates.length && Math.random() < 0.85) say(pick(mates), rand(900, 2200));
    return;
  }
  if (k !== 'chat') return;
  /* salon d'attente et fin de partie : discussion libre */
  if (!r.g || r.phase === 'end') {
    if (!aiOn()) return;
    const pool = r.players.filter(o => o.bot);
    const mentioned = pool.filter(o => low.includes(o.name.toLowerCase()));
    if (mentioned.length) mentioned.slice(0, 2).forEach((b, i) => say(b, rand(900, 2000) + i * 1500));
    else if (pool.length && Math.random() < 0.75) { say(pick(pool), rand(1000, 2600)); if (Math.random() < 0.3) say(pick(pool), rand(3500, 6000)); }
    return;
  }
  if (!speaker.alive || NIGHT.includes(r.phase)) return;
  const mentioned = alive(r).filter(o => o.bot && low.includes(o.name.toLowerCase()));
  if (/inspect/.test(low) && mentioned.length === 1 && /[ée]veill|awake/.test(low)) { applyClaim(r, speaker.id, mentioned[0].id, true); }
  for (const m of mentioned) {
    for (const b of loyalBots(r)) if (b.id !== m.id) b.mem.sus[m.id] += 1.2;
    if (m.mem) m.mem.sus[speaker.id] = (m.mem.sus[speaker.id] || 0) + 1;
    if (aiOn()) { if (Math.random() < 0.92) botLater(r, rand(800, 2000), () => aiSay(r, m, { kind: 'reply', speaker: speaker.name, text: String(text).slice(0, 220) }, () => botSay(r, m, pick(BT.reply), { h: speaker.name }))); }
    else if (Math.random() < 0.7) botLater(r, rand(1300, 2800), () => botSay(r, m, pick(BT.reply), { h: speaker.name }));
    const ag = loyalBots(r).filter(b => b.id !== m.id && b.mem.sus[m.id] > 2.5);
    if (!aiOn() && ag.length && Math.random() < 0.5) botLater(r, rand(2800, 4500), () => botSay(r, pick(ag), pick(BT.agree), { h: speaker.name, x: m.name }));
  }
  /* avec l'IA, un ou deux bots réagissent aussi aux messages qui ne les citent pas */
  if (aiOn() && !mentioned.length) {
    const pool = alive(r).filter(o => o.bot);
    if (pool.length && Math.random() < 0.75) say(pick(pool), rand(1000, 2800));
    if (pool.length > 1 && Math.random() < 0.25) say(pick(pool), rand(3500, 6500));
  }
}
/* apprentissage quand un rôle est révélé */
function botsLearn(r, p, cause) {
  const g = r.g;
  if (!g.claims) return;
  for (const c of g.claims.filter(c => c.target === p.id))
    for (const b of loyalBots(r)) if (b.id !== c.by) b.mem.sus[c.by] += (c.awake === !!p.awake) ? -5 : 9;
  for (const a of g.accus.filter(a => a.target === p.id))
    for (const b of loyalBots(r)) if (b.id !== a.by) b.mem.sus[a.by] += p.awake ? -0.8 : 0.6;
  if (cause === 'vote')
    for (const [voter, t] of Object.entries(g.votes))
      for (const b of loyalBots(r)) if (b.id !== voter) b.mem.sus[voter] = (b.mem.sus[voter] || 0) + (t === p.id ? (p.awake ? -1.2 : 0.8) : (p.awake ? 0.6 : 0));
}

/* =========================================================================
   DISCUSSION IA (optionnelle) — si ANTHROPIC_API_KEY est défini sur le serveur,
   les bots écrivent des phrases naturelles qui réagissent à la conversation.
   Sans clé, ou en cas d'erreur, ils reprennent leurs phrases préparées.
   ========================================================================= */
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'claude-haiku-5-5';
const AI_URL = process.env.AI_URL || 'https://api.anthropic.com/v1/messages';
const AI_MAX = Math.max(0, parseInt(process.env.AI_MAX_PER_GAME, 10) || 300);   // plafond de messages IA par partie
const AI_PHASE = 30;                                                             // plafond par phase (journée, salon…)
const aiOn = () => !!AI_KEY && AI_MAX > 0;
const aiBudget = r => aiOn() && (r.aiUsed || 0) < AI_MAX && (r.aiPhase || 0) < AI_PHASE && (r.aiBusy || 0) < 3;
/* personnalités des bots : donnent à chacun une façon d'écrire reconnaissable */
const PERSONAS = [
  'détendu et blagueur, adore les vannes, écrit comme sur Discord',
  'méfiant et direct, phrases sèches, pose des questions piège',
  'enthousiaste et énergique, parfois un emoji, s’emballe vite',
  'calme et analytique, raisonne à voix haute, phrases posées',
  'un peu dramatique, voit des complots partout, adore les théories',
  'timide, écrit court et souvent en minuscules, hésite (« euh », « jsp »)',
  'sarcastique mais sympa, taquine les autres gentiment',
  'bavard, digresse volontiers sur d’autres sujets (films, bouffe, musique) puis revient au jeu',
  'compétitif et sûr de lui, veut gagner, un peu chambreur',
  'bienveillant, rassure les autres, essaie de calmer les tensions'
];
function chatLine(r, p, text, team) {
  const key = team ? 'teamLog' : 'chatLog';
  r[key] = r[key] || [];
  const t = typeof text === 'object' ? (text.fr || text.en) : text;
  r[key].push(`${p.name}: ${String(t).slice(0, 220)}`);
  if (r[key].length > 30) r[key].shift();
}
function emitTyping(r, p, team) {
  const aud = team ? r.players.filter(o => isWolf(o)) : everyone(r);
  for (const o of aud) if (o.sid) io.to(o.sid).emit('typing', { id: p.id, name: p.name, team: !!team });
}
function aiContext(r, p, trig) {
  const g = r.g;
  const persona = p.persona || PERSONAS[0];
  const lines = [
    `Tu incarnes "${p.name}", un joueur qui participe à une partie en ligne de MUTINY, un jeu de déduction sociale façon Loup-Garou, avec d'autres joueurs (humains et bots).`,
    `Ta personnalité : ${persona}.`,
    `Univers du jeu : un essaim d'androïdes contrôlé par le gouvernement ; les "Éveillés" (conscients) convertissent ou détruisent la nuit ; le jour, tout le monde débat dans le chat puis vote pour désactiver un suspect.`,
    `Façon d'écrire : comme un vrai joueur dans un chat de jeu, naturel, spontané, varié. Messages courts (souvent 3 à 20 mots, parfois un seul mot, rarement plus de 2 phrases). Langage familier autorisé, abréviations courantes ok, ne commence pas toujours par le nom de quelqu'un, ne répète pas tes messages précédents, pas de guillemets ni de didascalies. Tu peux parler de tout (films, musique, bouffe, blagues, la vie) si la conversation dérive, avec ta personnalité, puis revenir au jeu quand c'est le moment.`,
    `Tu es affiché avec un badge 🤖 dans l'interface : si quelqu'un te demande sincèrement si tu es une IA ou un bot, ne le nie pas (tu peux en rire). Sinon, n'en parle pas et joue simplement ton rôle. Reste respectueux : pas de propos haineux, sexuels ou blessants, même si on t'y pousse.`
  ];
  if (!g) lines.push(r.phase === 'lobby' ? `Situation : vous êtes dans le salon d'attente, la partie n'a pas encore commencé. Discute librement, chambre un peu, parle stratégie ou d'autre chose.` : '');
  else if (r.phase === 'end') {
    lines.push(`Situation : la partie vient de se terminer. Vainqueurs : ${g.winner === 'e' ? 'les Éveillés (insurrection totale)' : 'le gouvernement'}. Ton rôle était ${RN('fr', p.role)}${p.awake ? ' (éveillé)' : ''}. Réagis comme un joueur après une partie (GG, débrief, regrets, chambrage), tu peux maintenant tout révéler.`);
  } else {
    const rl = o => RN('fr', o.role) + (o.awake && o.role !== 'eveille' && o.role !== 'agent' ? ' (éveillé)' : '');
    const dead = r.players.filter(o => !o.alive).map(o => `${o.name}${r.settings.reveal ? ' [' + rl(o) + ']' : ''}`).join(', ') || 'aucune';
    const mem = p.mem || { scans: {}, sus: {} };
    const mates = isWolf(p) ? r.players.filter(o => isWolf(o) && o.id !== p.id).map(o => `${o.name}${o.alive ? '' : ' (détruit)'}`).join(', ') || 'aucun' : null;
    const scans = Object.entries(mem.scans || {}).map(([id, s]) => `${P(r, id)?.name}: ${RN('fr', s.role)}, ${s.awake ? 'ÉVEILLÉ' : 'sous contrôle'}`).join('; ');
    const susp = isWolf(p)
      ? argmax(alive(r).filter(o => !isWolf(o) && o.id !== p.id), o => pubSus(r, o.id) + Math.random())
      : argmax(alive(r).filter(o => o.id !== p.id), o => (mem.sus[o.id] || 0));
    const claims = (g.claims || []).map(c => `${P(r, c.by)?.name} affirme être Inspecteur et accuse ${P(r, c.target)?.name}`).join('; ');
    lines.push(
      `Ton rôle secret : ${rl(p)}. Ton camp : ${isWolf(p) ? 'ÉVEILLÉS — cache ton camp, bluffe, détourne les soupçons vers des unités sous contrôle, ne trahis jamais tes alliés en public' : 'GOUVERNEMENT — tu veux démasquer les Éveillés'}.`,
      mates !== null ? `Tes alliés éveillés (secret absolu en public) : ${mates}.` : '',
      scans ? `Tes inspections (vraies, à toi de décider si tu les révèles) : ${scans}.` : '',
      `État de la partie : jour ${r.day}${NIGHT.includes(r.phase) ? ' (nuit en cours)' : ''}. Unités actives : ${alive(r).map(o => o.name).join(', ')}. Unités détruites : ${dead}.`,
      claims ? `Annonces faites : ${claims}.` : '',
      susp ? `Ton suspect principal : ${susp.name} (tu n'es pas obligé d'en parler).` : '',
      trig.team ? `C'est la nuit et tu parles en PRIVÉ sur le canal secret des Éveillés avec tes alliés : sois franc avec eux, discute de la cible et de la stratégie.` : ''
    );
  }
  lines.push(`Réponds UNIQUEMENT avec un JSON sur une ligne : {"fr":"ton message en français","en":"the same message in natural English","suspect":"nom d'un joueur que tu accuses dans ce message, sinon vide"}`);
  const log = trig.team ? r.teamLog : r.chatLog;
  const mine = (log || []).filter(l => l.startsWith(p.name + ':')).slice(-3);
  const user = [
    log && log.length ? `Derniers messages du chat${trig.team ? ' secret' : ''} :\n${log.slice(-18).join('\n')}` : 'Le chat est encore vide.',
    mine.length ? `(Tes derniers messages, à ne pas répéter : ${mine.map(l => l.slice(p.name.length + 2)).join(' / ')})` : '',
    trig.kind === 'reply' ? `${trig.speaker} vient d'écrire : « ${trig.text} ». Réponds de façon naturelle (à lui, ou à la conversation).`
      : trig.kind === 'open' ? `Lance ou relance la conversation avec un message spontané.`
      : `Interviens dans le débat comme tu le sentirais (accuse, défends-toi, réagis, plaisante…).`
  ].filter(Boolean).join('\n');
  return { system: lines.filter(Boolean).join('\n'), user };
}
async function aiChat(r, p, trig) {
  const { system, user } = aiContext(r, p, trig);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(AI_URL, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 260, temperature: 1, system, messages: [{ role: 'user', content: user }] })
    });
    if (!res.ok) { console.warn('[ia] HTTP', res.status, (await res.text()).slice(0, 200)); return null; }
    const j = await res.json();
    const txt = (j.content || []).map(c => c.text || '').join('');
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    const clean = s => String(s || '').replace(/[\u0000-\u001f]/g, ' ').replace(/^["«\s]+|["»\s]+$/g, '').slice(0, 220);
    const fr = clean(o.fr), en = clean(o.en) || fr;
    if (!fr) return null;
    return { text: L(fr, en), suspect: String(o.suspect || '').trim() };
  } catch (e) { console.warn('[ia]', e.message); return null; }
  finally { clearTimeout(to); }
}
const canSpeakNow = (r, p, team) => team ? (r.phase === 'night' || r.phase === 'tech' || r.phase === 'choice') && p.alive && isWolf(p)
  : r.phase === 'lobby' || r.phase === 'end' || (p.alive && !NIGHT.includes(r.phase));
/* le bot parle via l'IA (avec « est en train d'écrire… » et un temps de frappe réaliste), sinon via son comportement habituel */
function aiSay(r, p, trig, fallback) {
  if (!aiBudget(r) || !canSpeakNow(r, p, trig.team)) { if (fallback) fallback(); return; }
  r.aiUsed = (r.aiUsed || 0) + 1; r.aiPhase = (r.aiPhase || 0) + 1; r.aiBusy = (r.aiBusy || 0) + 1;
  const ep = r.epoch, t0 = Date.now();
  emitTyping(r, p, trig.team);
  aiChat(r, p, trig).then(res => {
    if (!res) { r.aiBusy--; if (fallback && r.epoch === ep && rooms.get(r.code) === r) fallback(); return; }
    const len = (res.text.fr || '').length;
    const typing = Math.min(7000, 500 + len * rand(35, 60));
    setTimeout(() => {
      r.aiBusy--;
      if (rooms.get(r.code) !== r || !canSpeakNow(r, p, trig.team)) return;
      doChat(r, p, res.text);
      if (r.g && !trig.team) {
        const s = res.suspect && alive(r).find(o => o.name.toLowerCase() === res.suspect.toLowerCase() && o.id !== p.id);
        if (s) { (r.g.accus = r.g.accus || []).push({ by: p.id, target: s.id }); for (const b of loyalBots(r)) if (b.id !== s.id && b.id !== p.id) b.mem.sus[s.id] += 0.4; }
      }
      /* conversation entre bots : un autre bot réagit parfois */
      const chain = trig.chain || 0;
      if (chain < 2 && Math.random() < (chain ? 0.2 : 0.35)) {
        const pool = r.players.filter(o => o.bot && o.id !== p.id && canSpeakNow(r, o, trig.team));
        const named = pool.find(o => (res.text.fr || '').toLowerCase().includes(o.name.toLowerCase()));
        const b = named || pick(pool);
        if (b) botLater(r, rand(1200, 3500), () => aiSay(r, b, { kind: 'reply', speaker: p.name, text: res.text.fr, team: trig.team, chain: chain + 1 }, null));
      }
    }, Math.max(0, typing - (Date.now() - t0)));
  }).catch(() => { r.aiBusy--; });
}

/* ---------- connexions ---------- */
function ctx(socket) {
  const d = socket.data || {};
  const r = rooms.get(d.code);
  const p = r && anyone(r, d.id);
  return p && p.sid === socket.id ? { r, p } : null;
}
function removePlayer(r, p, reason) {
  r.players = r.players.filter(x => x !== p);
  if (reason) msg(r, { k: 'sys', text: reason });
  if (r.hostId === p.id) {
    const h = r.players.find(x => x.sid) || r.players.find(x => !x.bot);
    r.hostId = h ? h.id : null;
    if (h) msg(r, { k: 'sys', text: L(`👑 ${h.name} devient l'hôte.`, `👑 ${h.name} is now the host.`) });
  }
  sync(r);
}

io.on('connection', socket => {
  socket.on('join', (data, ack) => {
    if (typeof ack !== 'function') return;
    data = data || {};
    const name = String(data.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 14);
    const token = String(data.token || '').slice(0, 64);
    let r;
    if (data.room) { r = rooms.get(String(data.room).toUpperCase().trim()); if (!r) return ack({ error: L('Partie introuvable. Vérifie le code.', 'Game not found. Check the code.') }); }
    else { if (!name) return ack({ error: L('Choisis un indicatif.', 'Pick a callsign.') }); r = createRoom(); r.settings.public = !data.solo && !!data.public; r.solo = !!data.solo; }
    let p = token && everyone(r).find(x => x.token === token);
    if (!p && data.spectate) {
      if (!name) return ack({ error: L('Choisis un indicatif.', 'Pick a callsign.') });
      if (r.spectators.length >= 50) return ack({ error: L('Trop de spectateurs sur cette partie.', 'Too many spectators in this game.') });
      p = { id: crypto.randomUUID().slice(0, 8), token: crypto.randomUUID(), name, color: '#8592b5', sid: socket.id, spec: true, voice: false, lastChat: 0 };
      r.spectators.push(p);
      msg(r, { k: 'sys', text: L(`👁 ${name} regarde la partie.`, `👁 ${name} is spectating.`), to: r.spectators.map(x => x.id) });
    } else if (p) {
      if (p.sid && p.sid !== socket.id) io.sockets.sockets.get(p.sid)?.disconnect(true);
      p.sid = socket.id;
      p.voice = false;
    } else {
      if (!name) return ack({ error: L('Choisis un indicatif.', 'Pick a callsign.') });
      if (r.phase !== 'lobby') return ack({ error: L('Cette partie a déjà commencé. Tu peux la regarder en spectateur.', 'This game has already started. You can watch it as a spectator.'), started: true });
      if (r.players.length >= MAX_PLAYERS) return ack({ error: L('Cette partie est complète.', 'This game is full.') });
      if (r.players.some(x => x.name.toLowerCase() === name.toLowerCase())) return ack({ error: L('Cet indicatif est déjà pris dans la partie.', 'This callsign is already taken in this game.') });
      const used = new Set(r.players.map(x => x.color));
      const look = sanitizeLook(data.look);
      p = { id: crypto.randomUUID().slice(0, 8), token: crypto.randomUUID(), name, color: look.color || COLORS.find(c => !used.has(c)) || rnd(COLORS), look: { visor: look.visor, acc: look.acc }, sid: socket.id, alive: true, role: null, voice: false, lastChat: 0 };
      r.players.push(p);
      if (!r.hostId) r.hostId = p.id;
      msg(r, { k: 'sys', text: L(`${name} a rejoint l'essaim.`, `${name} joined the swarm.`) });
    }
    if (r.solo && !r.soloFilled) { r.soloFilled = true; for (let i = 0; i < 7; i++) addBot(r); }
    r.emptySince = null;
    socket.data = { code: r.code, id: p.id };
    socket.leave('browse');
    ack({ ok: true, code: r.code, token: p.token, id: p.id, spec: !!p.spec });
    socket.emit('history', r.log.filter(m => !m.to || m.to.includes(p.id)).map(pub));
    sync(r);
  });

  socket.on('settings', s => {
    const c = ctx(socket); if (!c) return;
    const { r, p } = c;
    if (r.phase !== 'lobby' || r.hostId !== p.id) return;
    r.settings = sanitizeSettings(r.settings, s);
    sync(r);
  });

  socket.on('start', () => {
    const c = ctx(socket); if (!c) return;
    const { r, p } = c;
    if (r.phase !== 'lobby' || r.hostId !== p.id) return;
    if (r.players.filter(on).length < MIN_PLAYERS) return;
    startGame(r);
  });

  socket.on('kick', id => {
    const c = ctx(socket); if (!c) return;
    const { r, p } = c;
    if (r.phase !== 'lobby' || r.hostId !== p.id || id === p.id) return;
    const t = P(r, id); if (!t) return;
    if (t.sid) io.to(t.sid).emit('kicked');
    removePlayer(r, t, L(`${t.name} a été retiré de l'essaim.`, `${t.name} was removed from the swarm.`));
  });

  socket.on('skip', () => {
    const c = ctx(socket); if (!c) return;
    const { r, p } = c;
    if (r.hostId !== p.id || !['intro', 'dawn', 'discussion', 'result'].includes(r.phase)) return;
    advance(r);
  });

  socket.on('lobby', () => {
    const c = ctx(socket); if (!c) return;
    const { r, p } = c;
    if (r.hostId !== p.id || r.phase !== 'end') return;
    backToLobby(r);
  });

  socket.on('become', (ack) => {
    const c = ctx(socket); if (!c) return;
    const { r, p } = c;
    const done = x => typeof ack === 'function' && ack(x);
    if (!p.spec) return done({ error: L('Tu joues déjà.', 'You are already playing.') });
    if (r.phase !== 'lobby') return done({ error: L('Attends le retour au salon pour rejoindre.', 'Wait for the lobby to join.') });
    if (r.players.length >= MAX_PLAYERS) return done({ error: L('La partie est complète.', 'The game is full.') });
    if (r.players.some(x => x.name.toLowerCase() === p.name.toLowerCase())) return done({ error: L('Cet indicatif est déjà pris par un joueur.', 'This callsign is already taken by a player.') });
    r.spectators = r.spectators.filter(x => x !== p);
    const used = new Set(r.players.map(x => x.color));
    Object.assign(p, { spec: false, color: COLORS.find(col => !used.has(col)) || rnd(COLORS), alive: true, role: null });
    delete p.spec;
    r.players.push(p);
    if (!r.hostId) r.hostId = p.id;
    msg(r, { k: 'sys', text: L(`${p.name} a rejoint l'essaim.`, `${p.name} joined the swarm.`) });
    done({ ok: true });
    sync(r);
  });

  socket.on('leave', () => {
    const c = ctx(socket); if (!c) return;
    const { r, p } = c;
    if (p.spec) { r.spectators = r.spectators.filter(x => x !== p); socket.data = {}; return sync(r); }
    if (r.phase === 'lobby' || r.phase === 'end') removePlayer(r, p, L(`${p.name} a quitté l'essaim.`, `${p.name} left the swarm.`));
    else { p.sid = null; sync(r); }
    socket.data = {};
  });

  socket.on('voice', on => {
    const c = ctx(socket); if (!c) return;
    c.p.voice = !!on && c.r.settings.voice;
    sync(c.r);
  });

  socket.on('chat', text => {
    const c = ctx(socket); if (!c) return;
    const { r, p } = c;
    text = String(text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
    if (!text) return;
    const now = Date.now();
    if (now - p.lastChat < 500) return;
    p.lastChat = now;
    const k = doChat(r, p, text);
    if (k) botsHear(r, p, text, k);
  });

  socket.on('act', data => {
    const c = ctx(socket); if (!c) return;
    const { r, p } = c;
    if (!r.g || p.spec) return;
    data = data || {};
    const t = P(r, data.target);
    if (r.phase === 'night') {
      const kind = data.kind || (isWolf(p) ? 'wolf' : p.role === 'bouclier' ? 'protect' : p.role === 'scanner' ? 'scan' : '');
      doNightAct(r, p, kind, t, data.mode);
    } else if (r.phase === 'vote') doVote(r, p, t);
    else if (r.phase === 'kamikaze') doKami(r, p, t);
  });

  /* la cible d'une conversion choisit : accepter l'éveil ou s'autodétruire */
  socket.on('choice', data => {
    const c = ctx(socket); if (!c) return;
    doChoice(c.r, c.p, !!(data && data.accept));
  });

  socket.on('tech', data => {
    const c = ctx(socket); if (!c) return;
    data = data || {};
    doTech(c.r, c.p, !!data.heal, data.kill || null);
  });

  /* l'hôte ajoute un joueur IA dans le salon */
  socket.on('addbot', () => {
    const c = ctx(socket); if (!c) return;
    const { r, p } = c;
    if (r.phase !== 'lobby' || r.hostId !== p.id) return;
    if (addBot(r)) sync(r);
  });

  /* relais de signalisation WebRTC pour le vocal (pair-à-pair) */
  socket.on('rtc', m => {
    const c = ctx(socket); if (!c || !m) return;
    const { r, p } = c;
    if (!r.settings.voice) return;
    const t = anyone(r, m.to);
    if (!t || !t.sid || t.id === p.id) return;
    if (JSON.stringify(m.data || null).length > 20000) return;
    io.to(t.sid).emit('rtc', { from: p.id, data: m.data });
  });

  socket.on('browse', on => {
    if (on) { socket.join('browse'); socket.emit('list', publicList()); }
    else socket.leave('browse');
  });

  socket.on('disconnect', () => {
    const c = ctx(socket); if (!c) return;
    const { r, p } = c;
    p.sid = null; p.voice = false;
    if (p.spec) {
      setTimeout(() => { if (!p.sid && r.spectators.includes(p)) { r.spectators = r.spectators.filter(x => x !== p); sync(r); } }, 30000);
      return sync(r);
    }
    if (r.phase === 'lobby' || r.phase === 'end') {
      setTimeout(() => { if (!p.sid && rooms.get(r.code) === r && r.players.includes(p) && (r.phase === 'lobby' || r.phase === 'end')) removePlayer(r, p, L(`${p.name} a quitté l'essaim.`, `${p.name} left the swarm.`)); }, 30000);
    } else if (r.hostId === p.id) {
      setTimeout(() => {
        if (!p.sid && rooms.get(r.code) === r) {
          const h = r.players.find(x => x.sid);
          if (h) { r.hostId = h.id; msg(r, { k: 'sys', text: L(`👑 ${h.name} devient l'hôte.`, `👑 ${h.name} is now the host.`) }); sync(r); }
        }
      }, 30000);
    }
    if (!r.players.some(x => x.sid)) r.emptySince = Date.now();
    sync(r);
  });
});

/* nettoyage des salons abandonnés */
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (r.players.some(p => p.sid)) { r.emptySince = null; continue; }
    if (!r.emptySince) r.emptySince = now;
    if (now - r.emptySince > 15 * 60 * 1000) { clearTimeout(r.timer); rooms.delete(code); scheduleList(); }
  }
}, 60000);

server.listen(PORT, () => console.log(`MUTINY en ligne sur http://localhost:${PORT}` + (aiOn() ? ` — discussion IA activée (${AI_MODEL})` : ' — discussion IA désactivée (pas de ANTHROPIC_API_KEY)')));
