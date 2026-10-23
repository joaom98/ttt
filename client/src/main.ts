// Browser client. No framework: state comes in over the event stream, the whole screen is
// re-rendered from it, and clicks are handled with one delegated listener on #app.
// The shared rules (canApply, distance…) decide what's highlighted and which buttons are enabled,
// so the UI can never disagree with the server about what's legal.

import { PRESETS } from "../../shared/src/config.ts";
import { canApply, distance, juryTally, livingTanks, tankAt } from "../../shared/src/rules.ts";
import type { GameConfig, GameState, PlayerAction, Tank } from "../../shared/src/types.ts";
import type { StateMessage } from "../../shared/src/view.ts";
import { api, clearSession, lastName, loadSession, rememberName, saveSession, subscribe, type Session } from "./api.ts";

const app = document.getElementById("app")!;
const toastEl = document.getElementById("toast")!;

const ui: {
  gameId: string | null;
  session: Session | null;
  msg: StateMessage | null;
  clockOffset: number;
  targetId: string | null;
  connected: boolean;
  unsubscribe: (() => void) | null;
  busy: boolean;
} = {
  gameId: null, session: null, msg: null, clockOffset: 0, targetId: null, connected: false, unsubscribe: null, busy: false,
};

// ---------------------------------------------------------------------------------------------
// Routing: "/" is the home screen, "/?game=CODE" is a game.

function route(): void {
  ui.unsubscribe?.();
  ui.unsubscribe = null;
  ui.msg = null;
  ui.targetId = null;
  const code = new URLSearchParams(location.search).get("game");
  if (code) openGame(code.toUpperCase());
  else renderHome();
}

function goTo(gameId: string | null): void {
  history.pushState(null, "", gameId ? `/?game=${gameId}` : "/");
  route();
}

window.addEventListener("popstate", route);

// ---------------------------------------------------------------------------------------------
// Home screen

async function renderHome(): Promise<void> {
  document.title = "Tank Turn Tactics";
  const presetOptions = Object.entries(PRESETS)
    .map(([key, p]) => `<option value="${key}" ${key === "quick" ? "selected" : ""}>${esc(p.label)}</option>`)
    .join("");
  app.innerHTML = `
    <header class="hero">
      <h1>Tank Turn Tactics</h1>
      <p class="muted">Everyone gets action points on a timer. Move, shoot, trade, scheme. Last tank standing wins.</p>
    </header>
    <div class="home-grid">
      <form class="card" id="create-form">
        <h2>New game</h2>
        <label>Your name <input name="name" maxlength="20" required value="${esc(lastName())}" /></label>
        <label>Pace <select name="preset">${presetOptions}</select></label>
        <details>
          <summary>Rule tweaks</summary>
          <p class="muted small">Leave blank to use the pace's defaults.</p>
          <div class="tweaks">
            ${numberField("tickSeconds", "Seconds between ticks")}
            ${numberField("width", "Board size (blank = auto)")}
            ${numberField("startingHearts", "Starting hearts", 3)}
            ${numberField("startingRange", "Starting range", 2)}
            ${numberField("startingAP", "Starting AP", 0)}
            ${numberField("apPerTick", "AP per tick", 1)}
            ${numberField("upgradeRangeCost", "Range upgrade cost", 3)}
            ${numberField("juryVotesNeeded", "Jury votes for bonus AP", 3)}
            ${numberField("heartsSpawnedPerTick", "Hearts spawned per tick", 0)}
            ${checkField("allowGiveHeart", "Tanks can give hearts", true)}
            ${checkField("heartRevives", "A heart revives a dead tank", true)}
            ${checkField("killerTakesAP", "Killer takes the victim's AP", true)}
            ${checkField("debug", "Debug mode (host can force ticks)", null)}
          </div>
        </details>
        <button type="submit" class="primary">Create game</button>
      </form>
      <div class="card">
        <h2>Join a game</h2>
        <form id="join-form" class="row">
          <input name="code" placeholder="Game code" maxlength="5" autocomplete="off" required />
          <button type="submit">Open</button>
        </form>
        <h3>Open lobbies</h3>
        <div id="lobbies"><p class="muted small">Loading…</p></div>
      </div>
    </div>`;

  try {
    const { lobbies } = await api.lobbies();
    const el = document.getElementById("lobbies");
    if (!el) return;
    el.innerHTML = lobbies.length
      ? `<ul class="lobbies">${lobbies
          .map((l) => `<li><a href="/?game=${l.id}" data-link>${esc(l.hostName)}'s game</a>
            <span class="muted small">${l.players} player${l.players === 1 ? "" : "s"} · ${fmtDuration(l.tickIntervalMs)} ticks</span></li>`)
          .join("")}</ul>`
      : `<p class="muted small">No open lobbies. Create one and share the link!</p>`;
  } catch {
    // The list is a nice-to-have.
  }
}

function numberField(name: string, label: string, placeholder?: number): string {
  return `<label class="small">${label}<input type="number" name="${name}" min="0" placeholder="${placeholder ?? ""}" /></label>`;
}

/** Checkbox where "unset" means "use the preset default" (indeterminate when default is null). */
function checkField(name: string, label: string, def: boolean | null): string {
  return `<label class="check small"><input type="checkbox" name="${name}" ${def ? "checked" : ""} data-default="${def}" /> ${label}</label>`;
}

function readTweaks(form: HTMLFormElement): Partial<GameConfig> {
  const data = new FormData(form);
  const config: Record<string, number | boolean> = {};
  for (const key of ["width", "startingHearts", "startingRange", "startingAP", "apPerTick", "upgradeRangeCost", "juryVotesNeeded", "heartsSpawnedPerTick"]) {
    const v = String(data.get(key) ?? "").trim();
    if (v !== "") config[key] = Number(v);
  }
  if (config.width !== undefined) config.height = config.width;
  const secs = String(data.get("tickSeconds") ?? "").trim();
  if (secs !== "") config.tickIntervalMs = Number(secs) * 1000;
  for (const box of form.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
    const def = box.dataset.default;
    // Only send switches the player actually changed from their default.
    if (def === "null" ? box.checked : String(box.checked) !== def) config[box.name] = box.checked;
  }
  return config as Partial<GameConfig>;
}

// ---------------------------------------------------------------------------------------------
// Game screen

function openGame(gameId: string): void {
  ui.gameId = gameId;
  ui.session = loadSession(gameId);
  app.innerHTML = `<p class="muted center">Connecting to game ${esc(gameId)}…</p>`;
  connect();
}

function connect(): void {
  if (!ui.gameId) return;
  ui.unsubscribe?.();
  ui.unsubscribe = subscribe(
    ui.gameId,
    ui.session?.token ?? null,
    (m) => {
      ui.msg = m;
      ui.clockOffset = m.serverNow - Date.now();
      // Our saved session no longer matches a player (e.g. we left) — forget it.
      if (ui.session && m.you === null) {
        clearSession(ui.session.gameId);
        ui.session = null;
      }
      renderGame();
    },
    (connected) => {
      ui.connected = connected;
      document.body.classList.toggle("offline", !connected);
      if (!connected && !ui.msg) {
        app.innerHTML = `<div class="card center"><p>Couldn't find game <b>${esc(ui.gameId ?? "")}</b>.</p>
          <button data-act="home">Back to home</button></div>`;
        ui.unsubscribe?.();
      }
    },
  );
}

function renderGame(): void {
  const m = ui.msg;
  if (!m) return;
  const s = m.state;
  document.title = `${s.phase === "lobby" ? "Lobby" : `Tick ${s.tick}`} · ${s.id} · Tank Turn Tactics`;
  app.innerHTML = s.phase === "lobby" ? lobbyView(s) : boardView(s);
  updateCountdown();
}

function me(s: GameState): Tank | undefined {
  return ui.session ? s.tanks[ui.session.playerId] : undefined;
}

function lobbyView(s: GameState): string {
  const mine = me(s);
  const isHost = mine?.id === s.hostId;
  const link = `${location.origin}/?game=${s.id}`;
  const c = s.config;
  const players = s.order
    .map((id) => s.tanks[id]!)
    .map((t) => `<li><span class="swatch" style="--c:${t.color}"></span>${esc(t.name)}${t.id === s.hostId ? ` <span class="badge">host</span>` : ""}${t.id === mine?.id ? ` <span class="badge you">you</span>` : ""}</li>`)
    .join("");
  return `
    <nav class="top"><a href="/" data-link>← Home</a><span class="muted">Game <b>${s.id}</b></span></nav>
    <div class="lobby card">
      <h2>Lobby</h2>
      <p>Share this link with friends:</p>
      <div class="row"><input readonly value="${esc(link)}" id="share-link" /><button data-act="copy">Copy</button></div>
      <h3>Players (${s.order.length})</h3>
      <ul class="players">${players}</ul>
      <p class="muted small">
        ${c.startingHearts} hearts · range ${c.startingRange} · ${c.startingAP} starting AP ·
        ${c.apPerTick} AP every ${fmtDuration(c.tickIntervalMs)} · range upgrade ${c.upgradeRangeCost} AP ·
        jury needs ${c.juryVotesNeeded} votes${c.heartsSpawnedPerTick ? ` · ${c.heartsSpawnedPerTick} heart(s) spawn per tick` : ""}
        ${c.debug ? " · <b>debug on</b>" : ""}
      </p>
      ${mine
        ? `<div class="row">
            ${isHost ? `<button class="primary" data-act="start" ${s.order.length < 2 ? "disabled" : ""}>Start game</button>` : `<span class="muted">Waiting for the host to start…</span>`}
            <button data-act="leave">Leave</button>
          </div>`
        : `<form id="lobby-join" class="row">
            <input name="name" placeholder="Your name" maxlength="20" required value="${esc(lastName())}" />
            <button type="submit" class="primary">Join</button>
          </form>`}
    </div>`;
}

function boardView(s: GameState): string {
  const mine = me(s);
  const target = ui.targetId ? s.tanks[ui.targetId] : undefined;
  if (ui.targetId && !target) ui.targetId = null;
  const { width, height } = s.config;

  const cols = Array.from({ length: width }, (_, x) => `<div class="label">${colName(x)}</div>`).join("");
  let cells = `<div class="label"></div>${cols}`;
  for (let y = 0; y < height; y++) {
    cells += `<div class="label">${y + 1}</div>`;
    for (let x = 0; x < width; x++) cells += cellHtml(s, mine, x, y);
  }

  const banner =
    s.phase === "finished"
      ? `<div class="banner win">🏆 ${s.winnerId ? `${esc(s.tanks[s.winnerId]!.name)} wins!` : "Nobody survived."}</div>`
      : !mine
        ? `<div class="banner">You're spectating.</div>`
        : !mine.alive
          ? `<div class="banner dead">Your tank was destroyed. Click a living tank to cast your jury vote — ${s.config.juryVotesNeeded}+ votes on one tank earns it a bonus AP at the next tick.</div>`
          : "";

  return `
    <nav class="top"><a href="/" data-link>← Home</a><span class="muted">Game <b>${s.id}</b> · tick ${s.tick}</span></nav>
    ${banner}
    <div class="game">
      <section class="board-wrap">
        <div class="board" style="--w:${width}; --h:${height}">${cells}</div>
        <p class="muted small hint">${mine?.alive ? "Click a green square to move (or use Q W E / A D / Z X C). Click a tank to target it." : ""}</p>
      </section>
      <aside class="side">
        ${s.phase === "playing" ? `<div class="card tick"><span class="muted small">Next AP in</span><span id="countdown">–</span>
          ${s.config.debug && mine?.id === s.hostId ? `<button class="small" data-act="force-tick">Force tick</button>` : ""}</div>` : ""}
        ${mine ? myPanel(s, mine) : ""}
        ${target ? targetPanel(s, mine, target) : ""}
        ${playersPanel(s, mine)}
        ${logPanel(s)}
      </aside>
    </div>`;
}

function cellHtml(s: GameState, mine: Tank | undefined, x: number, y: number): string {
  const t = tankAt(s, { x, y });
  const cls = ["cell"];
  let data = `data-x="${x}" data-y="${y}"`;
  if (mine?.alive && s.phase === "playing") {
    const d = distance(mine, { x, y });
    if (d <= mine.range) cls.push("in-range");
    if (d === 1 && !t && canApply(s, move(mine, x, y))) cls.push("can-move");
  }
  if (s.pickups.some((p) => p.x === x && p.y === y)) cls.push("pickup");
  if (t) {
    cls.push("has-tank");
    if (t.id === ui.targetId) cls.push("targeted");
    data += ` data-tank="${t.id}"`;
  }
  const inner = t
    ? `<div class="tank ${t.alive ? "" : "wreck"} ${t.id === mine?.id ? "mine" : ""}" style="--c:${t.color}" title="${esc(tankTitle(t))}">
        <span class="initials">${esc(initials(t.name))}</span>
        <span class="hp">${t.alive ? "♥".repeat(Math.min(t.hearts, 5)) + (t.hearts > 5 ? "+" : "") : "✖"}</span>
      </div>`
    : "";
  return `<div class="${cls.join(" ")}" ${data}>${inner}</div>`;
}

function myPanel(s: GameState, mine: Tank): string {
  const upgrade: PlayerAction = { type: "upgradeRange", playerId: mine.id };
  return `
    <div class="card me" style="--c:${mine.color}">
      <h3><span class="swatch"></span>${esc(mine.name)} <span class="muted small">(you)</span></h3>
      <div class="stats">
        <div><b>${mine.hearts}</b><span>hearts</span></div>
        <div><b>${mine.ap}</b><span>AP</span></div>
        <div><b>${mine.range}</b><span>range</span></div>
      </div>
      ${mine.alive && s.phase === "playing"
        ? `<button data-act="upgrade" ${canApply(s, upgrade) ? "" : "disabled"}>Upgrade range (${s.config.upgradeRangeCost} AP)</button>`
        : ""}
      ${!mine.alive && s.juryVotes[mine.id] ? `<p class="small">Your jury vote: <b>${esc(s.tanks[s.juryVotes[mine.id]!]?.name ?? "?")}</b></p>` : ""}
    </div>`;
}

function targetPanel(s: GameState, mine: Tank | undefined, t: Tank): string {
  const dist = mine ? distance(mine, t) : null;
  let buttons = "";
  if (mine && s.phase === "playing" && t.id !== mine.id) {
    if (mine.alive) {
      const shoot: PlayerAction = { type: "shoot", playerId: mine.id, targetId: t.id };
      const ap: PlayerAction = { type: "giveAP", playerId: mine.id, targetId: t.id };
      const heart: PlayerAction = { type: "giveHeart", playerId: mine.id, targetId: t.id };
      buttons = `
        <div class="actions">
          <button class="danger" data-act="shoot" ${canApply(s, shoot) ? "" : "disabled"}>💥 Shoot (1 AP)</button>
          <button data-act="giveAP" ${canApply(s, ap) ? "" : "disabled"}>Give 1 AP</button>
          ${s.config.allowGiveHeart ? `<button data-act="giveHeart" ${canApply(s, heart) ? "" : "disabled"}>${t.alive ? "Give a heart" : "Revive with a heart"}</button>` : ""}
        </div>
        ${dist !== null && dist > mine.range ? `<p class="muted small">Out of range (${dist} away, your range is ${mine.range}).</p>` : ""}`;
    } else if (t.alive) {
      const voted = s.juryVotes[mine.id] === t.id;
      buttons = `<button data-act="vote" ${voted ? "disabled" : ""}>${voted ? "Voted ✓" : "Vote for this tank"}</button>`;
    }
  }
  return `
    <div class="card target" style="--c:${t.color}">
      <h3><span class="swatch"></span>${esc(t.name)} ${t.alive ? "" : `<span class="badge">destroyed</span>`}
        <button class="link small" data-act="untarget" aria-label="Close">✕</button></h3>
      <div class="stats">
        <div><b>${t.hearts}</b><span>hearts</span></div>
        <div><b>${t.ap}</b><span>AP</span></div>
        <div><b>${t.range}</b><span>range</span></div>
        ${dist !== null ? `<div><b>${dist}</b><span>away</span></div>` : ""}
      </div>
      ${buttons}
    </div>`;
}

function playersPanel(s: GameState, mine: Tank | undefined): string {
  const alive = livingTanks(s).length;
  const tally = juryTally(s);
  const rows = s.order
    .map((id) => s.tanks[id]!)
    .sort((a, b) => Number(b.alive) - Number(a.alive))
    .map((t) => `
      <tr class="${t.alive ? "" : "dead"} ${t.id === ui.targetId ? "targeted" : ""}" data-tank="${t.id}">
        <td><span class="swatch" style="--c:${t.color}"></span>${esc(t.name)}${t.id === mine?.id ? " (you)" : ""}</td>
        <td>${t.alive ? t.hearts : "✖"}</td><td>${t.ap}</td><td>${t.range}</td>
        <td>${tally[t.id] ? "🗳️" : ""}</td>
      </tr>`)
    .join("");
  return `
    <div class="card">
      <h3>Tanks <span class="muted small">${alive} alive</span></h3>
      <table class="tanks"><thead><tr><th></th><th>♥</th><th>AP</th><th>Rng</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
}

function logPanel(s: GameState): string {
  const items = s.log
    .slice(-40)
    .reverse()
    .map((e) => `<li><span class="muted small">${new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> ${esc(e.text)}</li>`)
    .join("");
  return `<div class="card"><h3>Events</h3><ul class="log">${items}</ul></div>`;
}

// ---------------------------------------------------------------------------------------------
// Input

app.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const link = el.closest<HTMLAnchorElement>("a[data-link]");
  if (link) {
    e.preventDefault();
    goTo(new URL(link.href).searchParams.get("game"));
    return;
  }
  const button = el.closest<HTMLButtonElement>("button[data-act]");
  if (button) return void onButton(button.dataset.act!);
  const cell = el.closest<HTMLElement>(".cell");
  if (cell) return onCell(Number(cell.dataset.x), Number(cell.dataset.y), cell.dataset.tank);
  const row = el.closest<HTMLElement>("tr[data-tank]");
  if (row) {
    ui.targetId = row.dataset.tank ?? null;
    renderGame();
  }
});

app.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const data = new FormData(form);
  try {
    if (form.id === "create-form") {
      const name = String(data.get("name")).trim();
      rememberName(name);
      const r = await api.create(name, String(data.get("preset")), readTweaks(form));
      saveSession({ gameId: r.gameId, playerId: r.playerId, token: r.token });
      goTo(r.gameId);
    } else if (form.id === "join-form") {
      goTo(String(data.get("code")).trim().toUpperCase());
    } else if (form.id === "lobby-join" && ui.gameId) {
      const name = String(data.get("name")).trim();
      rememberName(name);
      const r = await api.join(ui.gameId, name);
      ui.session = { gameId: ui.gameId, playerId: r.playerId, token: r.token };
      saveSession(ui.session);
      connect(); // reconnect so the stream knows who we are
    }
  } catch (err) {
    toast((err as Error).message);
  }
});

const KEY_DIRS: Record<string, [number, number]> = {
  q: [-1, -1], w: [0, -1], e: [1, -1], a: [-1, 0], d: [1, 0], z: [-1, 1], x: [0, 1], c: [1, 1],
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
};

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  const s = ui.msg?.state;
  const mine = s && me(s);
  if (e.key === "Escape" && ui.targetId) {
    ui.targetId = null;
    renderGame();
    return;
  }
  const dir = KEY_DIRS[e.key];
  if (!dir || !mine?.alive || s?.phase !== "playing") return;
  e.preventDefault();
  void send({ type: "move", playerId: mine.id, dx: dir[0], dy: dir[1] });
});

function onCell(x: number, y: number, tankId: string | undefined): void {
  const s = ui.msg?.state;
  if (!s || s.phase === "lobby") return;
  const mine = me(s);
  if (tankId) {
    ui.targetId = ui.targetId === tankId || tankId === mine?.id ? null : tankId;
    renderGame();
    return;
  }
  if (mine?.alive && distance(mine, { x, y }) === 1) {
    void send(move(mine, x, y));
    return;
  }
  if (ui.targetId) {
    ui.targetId = null;
    renderGame();
  }
}

async function onButton(act: string): Promise<void> {
  const s = ui.msg?.state;
  const mine = s && me(s);
  const target = ui.targetId ?? "";
  switch (act) {
    case "home": return goTo(null);
    case "copy": {
      const input = document.getElementById("share-link") as HTMLInputElement | null;
      if (!input) return;
      try {
        await navigator.clipboard.writeText(input.value);
        toast("Link copied!");
      } catch {
        input.select();
      }
      return;
    }
    case "untarget":
      ui.targetId = null;
      return renderGame();
    case "force-tick":
      if (ui.session) await guard(() => api.forceTick(ui.session!));
      return;
  }
  if (!mine) return;
  const id = mine.id;
  const actions: Record<string, PlayerAction> = {
    start: { type: "start", playerId: id, now: 0 },
    leave: { type: "leave", playerId: id },
    upgrade: { type: "upgradeRange", playerId: id },
    shoot: { type: "shoot", playerId: id, targetId: target },
    giveAP: { type: "giveAP", playerId: id, targetId: target },
    giveHeart: { type: "giveHeart", playerId: id, targetId: target },
    vote: { type: "juryVote", playerId: id, targetId: target },
  };
  const action = actions[act];
  if (!action) return;
  if (act === "shoot" && s && !confirmShoot(s, target)) return;
  const sent = await send(action);
  if (sent && act === "leave" && ui.session) {
    clearSession(ui.session.gameId);
    ui.session = null;
    goTo(null);
  }
}

function confirmShoot(s: GameState, targetId: string): boolean {
  const t = s.tanks[targetId];
  return !t || t.hearts > 1 || confirm(`This will destroy ${t.name}. Fire?`);
}

async function send(action: PlayerAction): Promise<boolean> {
  if (!ui.session) return false;
  return guard(() => api.act(ui.session!, action));
}

/** Run a request, one at a time, showing any error as a toast. State arrives via the stream. */
async function guard(fn: () => Promise<unknown>): Promise<boolean> {
  if (ui.busy) return false;
  ui.busy = true;
  try {
    await fn();
    return true;
  } catch (err) {
    toast((err as Error).message);
    return false;
  } finally {
    ui.busy = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Little helpers

function move(mine: Tank, x: number, y: number): PlayerAction {
  return { type: "move", playerId: mine.id, dx: x - mine.x, dy: y - mine.y };
}

function updateCountdown(): void {
  const el = document.getElementById("countdown");
  const next = ui.msg?.state.nextTickAt;
  if (!el || !next) return;
  el.textContent = fmtDuration(Math.max(0, next - (Date.now() + ui.clockOffset)), true);
}
setInterval(updateCountdown, 500);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3000);
}

function fmtDuration(ms: number, precise = false): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h) return precise ? `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s` : `${h}h${m ? ` ${m}m` : ""}`;
  if (m) return precise ? `${m}m ${String(sec).padStart(2, "0")}s` : `${m}m${sec ? ` ${sec}s` : ""}`;
  return `${sec}s`;
}

function colName(x: number): string {
  return x < 26 ? String.fromCharCode(65 + x) : `${String.fromCharCode(64 + Math.floor(x / 26))}${String.fromCharCode(65 + (x % 26))}`;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)).toUpperCase();
}

function tankTitle(t: Tank): string {
  return `${t.name}${t.alive ? "" : " (destroyed)"} — ${t.hearts} hearts, ${t.ap} AP, range ${t.range}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

route();
