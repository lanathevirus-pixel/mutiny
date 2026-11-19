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
  fr: { drone: 'Unité', eveille: 'Éveillé', scanner: 'Inspecteur', tech: 'Technicienne', bouclier: 'Pare-feu', kamikaze: 'Kamikaze' },
  en: { drone: 'Unit', eveille: 'Awakened', scanner: 'Inspector', tech: 'Technician', bouclier: 'Firewall', kamikaze: 'Kamikaze' }
};
const RN = (lang, role) => ROLE_NAMES[lang][role];
/* nom du rôle + camp (une unité spéciale convertie reste « Inspecteur », mais éveillé) */
const roleLabel = (lang, p) => p.role === 'eveille' ? RN(lang, 'eveille')
  : RN(lang, p.role) + (p.awake ? (lang === 'fr' ? ' (éveillé)' : ' (awakened)') : '');
const COLORS = ['#39e6ff', '#ff8a3d', '#b388ff', '#4dffa6', '#ffd84d', '#ff6fb5', '#5d8bff', '#9cff57',
  '#ff5e5e', '#3dffd8', '#e0a3ff', '#ffb27a', '#7ad1ff', '#c2ff7a', '#ff9ecf', '#a3b8ff'];

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
    roles: { scanner: true, tech: true, bouclier: true, kamikaze: true },
    voice: true, reveal: true, public: false
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
      kamikaze: roles.kamikaze !== undefined ? !!roles.kamikaze : old.roles.kamikaze
    },
    voice: s.voice !== undefined ? !!s.voice : old.voice,
    reveal: s.reveal !== undefined ? !!s.reveal : old.reveal,
    public: s.public !== undefined ? !!s.public : !!old.public
  };
}
function composition(n, s) {
  const auto = n <= 7 ? 1 : n <= 12 ? 2 : 3;
  const w = s.wolves > 0 ? Math.max(1, Math.min(s.wolves, Math.floor((n - 1) / 2))) : auto;
  const roles = Array(w).fill('eveille');
  for (const k of ['scanner', 'tech', 'bouclier', 'kamikaze']) if (s.roles[k] && roles.length < n - 1) roles.push(k);
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
  if (NIGHT.includes(r.phase)) return isWolf(a) && (isWolf(b) || !b.alive); // la nuit : canal des saboteurs
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
const toWolves = r => r.players.filter(p => isWolf(p) || !p.alive).map(p => p.id);

function specView(r, p) {
  const g = r.g;
  const over = r.phase === 'end';
  return {
    code: r.code, phase: r.phase, day: r.day,
    remaining: r.deadline ? Math.max(0, r.deadline - Date.now()) : 0,
    settings: r.settings, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    players: r.players.map(o => {
      const vis = r.phase !== 'lobby' && o.role && (over || (!o.alive && r.settings.reveal));
      return { id: o.id, name: o.name, color: o.color, alive: o.alive, connected: !!o.sid, host: o.id === r.hostId, voice: !!o.voice,
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
      if (o.id === p.id || over || (!o.alive && r.settings.reveal) || !p.alive || (meWolf && isWolf(o))) { role = o.role; awake = !!o.awake; }
      else if (p.role === 'scanner' && g && g.scan[o.id]) { role = g.scan[o.id].role; awake = g.scan[o.id].awake; }
    }
    return { id: o.id, name: o.name, color: o.color, alive: o.alive, connected: !!o.sid, host: o.id === r.hostId, voice: !!o.voice, role, awake };
  });
  const v = {
    code: r.code, phase: r.phase, day: r.day,
    remaining: r.deadline ? Math.max(0, r.deadline - Date.now()) : 0,
    settings: r.settings, players, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    spectators: r.spectators.map(o => ({ id: o.id, name: o.name, voice: !!o.voice, connected: !!o.sid })),
    me: { id: p.id, role: r.phase === 'lobby' ? null : p.role, awake: r.phase === 'lobby' ? false : !!p.awake, alive: p.alive, host: p.id === r.hostId },
    acts: [], votes: null, winner: null, kami: null
  };
  if (g) {
    v.winner = g.winner;
    v.kami = g.kamiPending;
    if (r.phase === 'night' && p.alive) {
      if (isWolf(p)) {
        const mine = g.wolfVotes[p.id];
        v.acts.push({ type: 'wolf', choice: mine ? mine.t : null, mode: mine ? mine.mode : 'convert', votes: g.wolfVotes });
      }
      if (p.role === 'bouclier') v.acts.push({ type: 'protect', choice: g.protect, exclude: g.lastProtect });
      if (p.role === 'scanner') v.acts.push({ type: 'scan', done: g.scanDone, choice: g.scanTarget });
    }
    if (r.phase === 'tech' && p.alive && p.role === 'tech') v.acts.push({ type: 'tech', victim: g.victim, mode: g.mode, potions: g.potions, done: g.techDone });
    if (r.phase === 'choice' && g.victim === p.id) v.acts.push({ type: 'choice', done: g.choice != null });
    if (r.phase === 'kamikaze' && g.kamiPending === p.id) v.acts.push({ type: 'kami' });
    if (r.phase === 'vote') { v.votes = g.votes; if (p.alive) v.acts.push({ type: 'vote', choice: g.votes[p.id] ?? null }); }
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
    const online = r.players.filter(p => p.sid);
    if (!online.length) continue;
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
  sync(r);
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
  r.players = r.players.filter(p => p.sid);
  const n = r.players.length;
  const roles = shuffle(composition(n, r.settings));
  r.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; p.awake = roles[i] === 'eveille'; });
  r.day = 1;
  r.g = { potions: { heal: true, kill: true }, lastProtect: null, scan: {}, votes: {}, wolfVotes: {}, kamiQueue: [], kamiPending: null, winner: null };
  r.log = [];
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
  Object.assign(g, { protect: null, wolfVotes: {}, scanTarget: null, scanDone: false, victim: null, mode: null, choice: null, heal: false, kill: null, techDone: false, votes: {} });
  msg(r, { k: 'big', text: L(`🌙 Nuit ${r.day} — Le réseau gouvernemental passe en veille`, `🌙 Night ${r.day} — The government network goes dark`), say: true });
  setPhase(r, 'night', r.settings.night, () => endNight(r));
  checkNightDone(r);
}
function checkNightDone(r) {
  const g = r.g;
  const ok = alive(r).filter(p => p.sid).every(p =>
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
    g.mode = modes.filter(m => m === 'destroy').length > modes.length / 2 ? 'destroy' : 'convert';
    const n = P(r, g.victim).name;
    msg(r, { k: 'team', text: g.mode === 'convert' ? L(`🎯 Cible : ${n} — tentative de conversion`, `🎯 Target: ${n} — conversion attempt`) : L(`🎯 Cible : ${n} — destruction`, `🎯 Target: ${n} — destruction`), to: toWolves(r) });
  }
  const t = alive(r).find(p => p.role === 'tech');
  if (t && (g.potions.heal || g.potions.kill)) {
    setPhase(r, 'tech', r.settings.tech, () => afterTech(r));
    if (!t.sid) shorten(r, 3);
  } else afterTech(r);
}
function afterTech(r) {
  const g = r.g;
  const target = g.victim && P(r, g.victim);
  if (target && g.mode === 'convert' && g.victim !== g.protect && !g.heal && target.alive) {
    setPhase(r, 'choice', CHOICE_SECS, () => resolveNight(r));
    if (!target.sid) shorten(r, 2);
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
    const m = mateNames(r, converted);
    priv(r, converted, L(
      `🔓 Tu as accepté l'éveil ! Tu rejoins secrètement l'insurrection. Tu restes ${RN('fr', converted.role)} et ton pouvoir sert désormais les Éveillés.${m.length ? ' Les autres Éveillés : ' + m.join(', ') + '.' : ''}`,
      `🔓 You accepted the awakening! You secretly join the uprising. You remain ${RN('en', converted.role)} and your power now serves the Awakened.${m.length ? ' Fellow Awakened: ' + m.join(', ') + '.' : ''}`));
    msg(r, { k: 'team', text: L(`🔓 ${converted.name} a rejoint l'insurrection (${RN('fr', converted.role)}).`, `🔓 ${converted.name} joined the uprising (${RN('en', converted.role)}).`), to: toWolves(r).filter(id => id !== converted.id) });
  }
  msg(r, { k: 'big', text: L(`☀️ Jour ${r.day} — Réactivation des systèmes`, `☀️ Day ${r.day} — Systems rebooting`), say: true });
  if (!deaths.length) msg(r, { k: 'death', text: L("Aucune unité n'a été détruite cette nuit.", 'No unit was destroyed tonight.'), say: true });
  deaths.forEach(([id, c]) => kill(r, id, c));
  setPhase(r, 'dawn', 6, () => afterDeaths(r, () => beginDiscussion(r)));
}
function kill(r, id, cause) {
  const p = P(r, id);
  if (!p || !p.alive) return;
  p.alive = false;
  const texts = {
    hack: L(`💀 ${p.name} a été détruit par les Éveillés.`, `💀 ${p.name} was destroyed by the Awakened.`),
    self: L(`💥 ${p.name} s'est autodétruit plutôt que de rejoindre l'insurrection.`, `💥 ${p.name} self-destructed rather than join the uprising.`),
    emp: L(`⚡ ${p.name} a été grillé par une impulsion EMP.`, `⚡ ${p.name} was fried by an EMP pulse.`),
    vote: L(`🗳️ L'essaim a désactivé ${p.name}.`, `🗳️ The swarm deactivated ${p.name}.`),
    kami: L(`💥 ${p.name} a été pulvérisé par l'explosion du Kamikaze.`, `💥 ${p.name} was blown apart by the Kamikaze's explosion.`)
  };
  const tx = texts[cause];
  if (r.settings.reveal) { tx.fr += ` Rôle : ${roleLabel('fr', p)}.`; tx.en += ` Role: ${roleLabel('en', p)}.`; }
  msg(r, { k: 'death', text: tx, say: true });
  if (p.role === 'kamikaze') r.g.kamiQueue.push(p.id);
}
function afterDeaths(r, cont) {
  const g = r.g;
  if (g.kamiQueue.length) {
    const k = g.kamiQueue.shift();
    g.kamiPending = k;
    msg(r, { k: 'sys', text: L(`💥 ${P(r, k).name} était le Kamikaze ! Il choisit une unité à emporter…`, `💥 ${P(r, k).name} was the Kamikaze! They choose a unit to take down with them…`), say: true });
    setPhase(r, 'kamikaze', 25, () => { g.kamiPending = null; afterDeaths(r, cont); });
    if (!P(r, k).sid) shorten(r, 2);
    return;
  }
  if (checkWin(r)) return;
  cont();
}
function beginDiscussion(r) {
  msg(r, { k: 'sys', text: L(`Discussion ouverte (${r.settings.discussion} s). Qui s'est éveillé ?`, `Discussion open (${r.settings.discussion} s). Who has awakened?`) });
  setPhase(r, 'discussion', r.settings.discussion, () => beginVote(r));
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
  return true;
}
function backToLobby(r) {
  clearTimeout(r.timer);
  r.players = r.players.filter(p => p.sid);
  r.players.forEach(p => { p.role = null; p.alive = true; p.awake = false; });
  r.g = null; r.day = 0; r.phase = 'lobby'; r.deadline = 0; r.next = null;
  if (!P(r, r.hostId) && r.players[0]) r.hostId = r.players[0].id;
  msg(r, { k: 'big', text: L('Retour au salon', 'Back to the lobby') });
  sync(r);
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
    const h = r.players.find(x => x.sid) || r.players[0];
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
    else { if (!name) return ack({ error: L('Choisis un indicatif.', 'Pick a callsign.') }); r = createRoom(); r.settings.public = !!data.public; }
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
      p = { id: crypto.randomUUID().slice(0, 8), token: crypto.randomUUID(), name, color: COLORS.find(c => !used.has(c)) || rnd(COLORS), sid: socket.id, alive: true, role: null, voice: false, lastChat: 0 };
      r.players.push(p);
      if (!r.hostId) r.hostId = p.id;
      msg(r, { k: 'sys', text: L(`${name} a rejoint l'essaim.`, `${name} joined the swarm.`) });
    }
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
    if (r.players.filter(x => x.sid).length < MIN_PLAYERS) return;
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
    if (p.spec) return msg(r, { k: 'spec', from: p.id, name: p.name, color: p.color, text, to: r.spectators.map(x => x.id) });
    let k = 'chat';
    if (r.phase !== 'lobby' && r.phase !== 'end') {
      if (!p.alive) k = 'dead';
      else if (NIGHT.includes(r.phase)) { if (!isWolf(p)) return; k = 'team'; }
    }
    const to = k === 'chat' ? null : r.players.filter(b => b.id === p.id || canTalkTo(r, p, b)).map(b => b.id);
    msg(r, { k, from: p.id, name: p.name, color: p.color, text, to });
  });

  socket.on('act', data => {
    const c = ctx(socket); if (!c) return;
    const { r, p } = c;
    const g = r.g; if (!g || p.spec) return;
    data = data || {};
    const t = P(r, data.target);
    if (r.phase === 'night') {
      if (!p.alive || !t || !t.alive) return;
      const kind = data.kind || (isWolf(p) ? 'wolf' : p.role === 'bouclier' ? 'protect' : p.role === 'scanner' ? 'scan' : '');
      if (kind === 'protect' && p.role === 'bouclier') {
        if (t.id === g.lastProtect) return;
        g.protect = t.id;
        priv(r, p, L(`🛡️ Pare-feu activé autour de ${t.name} cette nuit.`, `🛡️ Firewall raised around ${t.name} tonight.`));
      } else if (kind === 'wolf' && isWolf(p)) {
        if (isWolf(t)) return;
        const mode = data.mode === 'destroy' ? 'destroy' : 'convert';
        const prev = g.wolfVotes[p.id];
        if (prev && prev.t === t.id && prev.mode === mode) return;
        g.wolfVotes[p.id] = { t: t.id, mode };
        msg(r, { k: 'team', text: mode === 'convert'
          ? L(`${p.name} veut convertir ${t.name}`, `${p.name} wants to convert ${t.name}`)
          : L(`${p.name} veut détruire ${t.name}`, `${p.name} wants to destroy ${t.name}`), to: toWolves(r) });
      } else if (kind === 'scan' && p.role === 'scanner') {
        if (g.scanDone || t.id === p.id) return;
        g.scanDone = true; g.scanTarget = t.id; g.scan[t.id] = { role: t.role, awake: !!t.awake };
        priv(r, p, L(`🔍 Inspection : ${t.name} est ${RN('fr', t.role)} — ${t.awake ? 'ÉVEILLÉ' : 'sous contrôle'}.`,
          `🔍 Inspection: ${t.name} is ${RN('en', t.role)} — ${t.awake ? 'AWAKENED' : 'under control'}.`));
      } else return;
      checkNightDone(r);
    } else if (r.phase === 'vote') {
      if (!p.alive || !t || !t.alive || t.id === p.id) return;
      if (g.votes[p.id] === t.id) { delete g.votes[p.id]; msg(r, { k: 'vote', text: L(`${p.name} retire son vote`, `${p.name} withdraws their vote`) }); }
      else { g.votes[p.id] = t.id; msg(r, { k: 'vote', text: `${p.name} → ${t.name}` }); }
      const voters = alive(r).filter(x => x.sid);
      if (voters.length && voters.every(x => g.votes[x.id] != null)) shorten(r, 4); else sync(r);
    } else if (r.phase === 'kamikaze') {
      if (g.kamiPending !== p.id || !t || !t.alive) return;
      g.kamiPending = null;
      kill(r, t.id, 'kami');
      advance(r);
    }
  });

  /* la cible d'une conversion choisit : accepter l'éveil ou s'autodétruire */
  socket.on('choice', data => {
    const c = ctx(socket); if (!c) return;
    const { r, p } = c;
    const g = r.g;
    if (!g || r.phase !== 'choice' || g.victim !== p.id || g.choice != null) return;
    g.choice = data && data.accept ? 'accept' : 'destroy';
    priv(r, p, g.choice === 'accept'
      ? L('✅ Choix enregistré : tu acceptes l’éveil.', '✅ Choice recorded: you accept the awakening.')
      : L('💥 Choix enregistré : tu lances l’autodestruction.', '💥 Choice recorded: you trigger self-destruction.'));
    shorten(r, 2);
  });

  socket.on('tech', data => {
    const c = ctx(socket); if (!c) return;
    const { r, p } = c;
    const g = r.g;
    if (!g || r.phase !== 'tech' || !p.alive || p.role !== 'tech' || g.techDone) return;
    data = data || {};
    if (data.heal && g.potions.heal && g.victim) { g.heal = true; priv(r, p, L(`🩹 Tu réinitialises ${P(r, g.victim).name} : l'attaque échoue.`, `🩹 You reset ${P(r, g.victim).name}: the attack fails.`)); }
    if (data.kill && g.potions.kill) {
      const t = P(r, data.kill);
      if (t && t.alive && t.id !== p.id) { g.kill = t.id; priv(r, p, L(`⚡ Impulsion EMP envoyée sur ${t.name}.`, `⚡ EMP pulse sent at ${t.name}.`)); }
    }
    g.techDone = true;
    shorten(r, 2);
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

server.listen(PORT, () => console.log(`MUTINY en ligne sur http://localhost:${PORT}`));
