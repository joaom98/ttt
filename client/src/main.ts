// Browser client. No framework: state comes in over the event stream, the whole screen is
// re-rendered from it, and clicks are handled with one delegated listener on #app.
// The shared rules (canApply, distance…) decide what's highlighted and which buttons are enabled,
// so the UI can never disagree with the server about what's legal.

import { DEFAULT_PRESET, PRESETS } from "../../shared/src/config.ts";
import { canApply, distance, juryTally, livingTanks, tankAt } from "../../shared/src/rules.ts";
import type { GameConfig, GameState, OrderAction, PlayerAction, Tank } from "../../shared/src/types.ts";
import { BOT_PERSONALITIES, type BotPersonality, type ChatMessage, type StateMessage } from "../../shared/src/view.ts";
import { api, clearSession, lastName, loadSession, rememberName, saveSession, subscribe, type Session } from "./api.ts";
import { animateChange } from "./fx.ts";

const BOT_LABELS: Record<BotPersonality, string> = {
  hunter: "Hunter — chases and shoots the weakest tank",
  turtle: "Turtle — saves up, upgrades range, picks off easy kills",
  wildcard: "Wildcard — random moves, shots and gifts",
};

/** The lineup for the one-click practice game on the home screen. */
const PRACTICE_BOTS: BotPersonality[] = ["hunter", "turtle", "wildcard"];

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
    .map(([key, p]) => `<option value="${key}" ${key === DEFAULT_PRESET ? "selected" : ""}>${esc(p.label)}</option>`)
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
            <label class="small wide">Timing
              <select name="mode">
                <option value="">The pace's default</option>
                <option value="rounds">Rounds — plan in secret, resolve in random order</option>
                <option value="realtime">Real time — act whenever you have AP</option>
              </select></label>
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
        <div class="row">
          <button type="submit" class="primary">Create game</button>
          <button type="button" data-act="practice" title="Start a ${esc(PRESETS[DEFAULT_PRESET]!.label.split(" —")[0]!)} game right away against ${PRACTICE_BOTS.length} bots">Practice vs bots</button>
        </div>
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
  const config: Record<string, number | boolean | string> = {};
  const mode = String(data.get("mode") ?? "");
  if (mode) config.mode = mode;
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
      const prev = ui.msg?.state;
      ui.msg = m;
      ui.clockOffset = m.serverNow - Date.now();
      // Our saved session no longer matches a player (e.g. we left) — forget it.
      if (ui.session && m.you === null) {
        clearSession(ui.session.gameId);
        ui.session = null;
      }
      renderGame();
      animateChange(prev, m.state, m.cause, app);
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
  const restore = preserveInputs();
  app.innerHTML = s.phase === "lobby" ? lobbyView(s) : boardView(s);
  restore();
  placePopover();
  updateCountdown();
}

/**
 * The screen is rebuilt on every update (ticks, bot moves, chat), so remember what the player is
 * typing, where their cursor is and how far the chat is scrolled, and put it all back afterwards.
 */
function preserveInputs(): () => void {
  const fields = [...app.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[id]:not([readonly]), select[id]")]
    .map((el) => ({ id: el.id, value: el.value }));
  const active = document.activeElement;
  const focusId = active instanceof HTMLElement && app.contains(active) ? active.id : "";
  const caret = active instanceof HTMLInputElement && active.type === "text" ? [active.selectionStart, active.selectionEnd] : null;
  const log = document.getElementById("chat-log");
  const stuckToBottom = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  const scrollTop = log?.scrollTop ?? 0;
  return () => {
    for (const f of fields) {
      const el = document.getElementById(f.id) as HTMLInputElement | HTMLSelectElement | null;
      if (!el) continue;
      // A select keeps its default if the remembered option is gone (e.g. that player left).
      if (el instanceof HTMLSelectElement && ![...el.options].some((o) => o.value === f.value)) continue;
      el.value = f.value;
    }
    const newLog = document.getElementById("chat-log");
    if (newLog) newLog.scrollTop = stuckToBottom ? newLog.scrollHeight : scrollTop;
    const el = focusId ? document.getElementById(focusId) : null;
    if (!el) return;
    el.focus();
    if (caret && el instanceof HTMLInputElement) el.setSelectionRange(caret[0]!, caret[1]!);
  };
}

function me(s: GameState): Tank | undefined {
  return ui.session ? s.tanks[ui.session.playerId] : undefined;
}

function lobbyView(s: GameState): string {
  const mine = me(s);
  const isHost = mine?.id === s.hostId;
  const link = `${location.origin}/?game=${s.id}`;
  const c = s.config;
  const bots = ui.msg?.bots ?? {};
  const players = s.order
    .map((id) => s.tanks[id]!)
    .map((t) => `<li><span class="swatch" style="--c:${t.color}"></span>${esc(t.name)}${t.id === s.hostId ? ` <span class="badge">host</span>` : ""}${t.id === mine?.id ? ` <span class="badge you">you</span>` : ""}
      ${bots[t.id] ? ` <span class="badge bot" title="${esc(BOT_LABELS[bots[t.id]!])}">🤖 ${bots[t.id]}</span>` : ""}
      ${bots[t.id] && isHost ? `<button class="link small" data-act="remove-bot" data-id="${t.id}" aria-label="Remove ${esc(t.name)}">Remove</button>` : ""}</li>`)
    .join("");
  const botOptions = BOT_PERSONALITIES.map((p) => `<option value="${p}">${esc(BOT_LABELS[p])}</option>`).join("");
  return `
    <nav class="top"><a href="/" data-link>← Home</a><span class="muted">Game <b>${s.id}</b></span></nav>
    <div class="lobby">
    <div class="card">
      <h2>Lobby</h2>
      <p>Share this link with friends:</p>
      <div class="row"><input readonly value="${esc(link)}" id="share-link" /><button data-act="copy">Copy</button></div>
      <h3>Players (${s.order.length})</h3>
      <ul class="players">${players}</ul>
      ${isHost
        ? `<div class="row add-bot"><select id="bot-kind" aria-label="Kind of bot">${botOptions}</select><button data-act="add-bot">Add bot</button></div>`
        : ""}
      <p class="muted small">
        <b>${c.mode === "rounds" ? "Planned rounds" : "Real time"}</b> · ${c.startingHearts} hearts · range ${c.startingRange} · ${c.startingAP} starting AP ·
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
            <input name="name" id="join-name" placeholder="Your name" maxlength="20" required value="${esc(lastName())}" />
            <button type="submit" class="primary">Join</button>
          </form>`}
    </div>
    ${chatPanel(s, mine)}
    </div>`;
}

function boardView(s: GameState): string {
  const mine = me(s);
  const target = ui.targetId ? s.tanks[ui.targetId] : undefined;
  if (ui.targetId && !target) ui.targetId = null;
  const { width, height } = s.config;
  const plan = planFor(s, mine);

  const cols = Array.from({ length: width }, (_, x) => `<div class="label">${colName(x)}</div>`).join("");
  let cells = `<div class="label"></div>${cols}`;
  for (let y = 0; y < height; y++) {
    cells += `<div class="label">${y + 1}</div>`;
    for (let x = 0; x < width; x++) cells += cellHtml(s, mine, plan, x, y);
  }

  const banner =
    s.phase === "finished"
      ? `<div class="banner win">🏆 ${s.winnerId ? `${esc(s.tanks[s.winnerId]!.name)} wins!` : "Nobody survived."}</div>`
      : !mine
        ? `<div class="banner">You're spectating.</div>`
        : !mine.alive
          ? `<div class="banner dead">Your tank was destroyed. Click a living tank to cast your jury vote — ${s.config.juryVotesNeeded}+ votes on one tank earns it a bonus AP at the next tick.</div>`
          : "";

  const hint = !(mine?.alive && s.phase === "playing")
    ? ""
    : s.config.mode === "rounds"
      ? "Each round, pick one order: click a green square (or Q W E / A D / Z X C) to move, or a tank to shoot or give. " +
        "When the timer runs out, everyone's orders play out one player at a time, in a random order."
      : "Click your tank to upgrade, another tank to shoot or trade. Move by clicking a green square or with Q W E / A D / Z X C.";

  return `
    <nav class="top"><a href="/" data-link>← Home</a><span class="muted">Game <b>${s.id}</b> · tick ${s.tick}</span></nav>
    ${banner}
    <div class="game">
      <section class="play">
        ${hud(s, mine, plan)}
        <div class="board-wrap"><div class="board" style="--w:${width}; --h:${height}">${cells}</div></div>
        ${roster(s, mine)}
        <p class="muted small hint">${hint}</p>
      </section>
      <aside class="side">
        ${chatPanel(s, mine)}
        ${logPanel(s)}
      </aside>
    </div>
    ${target ? `<div id="popover" class="popover" role="dialog" aria-label="${esc(target.name)}" style="--c:${target.color}">${popover(s, mine, plan, target)}</div>` : ""}`;
}

/** Rounds mode while you plan: your one order for the round, and what to draw for it. */
interface Plan {
  planning: boolean;
  order: OrderAction | undefined;
  /** "x,y" of the square your planned move goes to. */
  moveTo: string | null;
  /** tank id -> icon for the order aimed at it (💥 ⚡ ♥ ⬆). */
  marks: Map<string, string>;
}

const ORDER_ICONS = { move: "➜", shoot: "💥", giveAP: "⚡", giveHeart: "♥", upgradeRange: "⬆" } as const;

function planFor(s: GameState, mine: Tank | undefined): Plan {
  const planning = s.config.mode === "rounds" && s.phase === "playing" && !s.resolving && !!mine?.alive;
  const order = planning && mine ? s.orders[mine.id] : undefined;
  const plan: Plan = { planning, order, moveTo: null, marks: new Map() };
  if (!order || !mine) return plan;
  if (order.type === "move") plan.moveTo = `${mine.x + order.dx},${mine.y + order.dy}`;
  else plan.marks.set(order.type === "upgradeRange" ? mine.id : order.targetId, ORDER_ICONS[order.type]);
  return plan;
}

function describeOrder(s: GameState, o: OrderAction): string {
  const name = (id: string) => esc(s.tanks[id]?.name ?? "?");
  switch (o.type) {
    case "move": return `${ORDER_ICONS.move} Move to ${colName(s.tanks[o.playerId]!.x + o.dx)}${s.tanks[o.playerId]!.y + o.dy + 1}`;
    case "shoot": return `${ORDER_ICONS.shoot} Shoot ${name(o.targetId)}`;
    case "giveAP": return `${ORDER_ICONS.giveAP} Give 1 AP to ${name(o.targetId)}`;
    case "giveHeart": return `${ORDER_ICONS.giveHeart} Give a heart to ${name(o.targetId)}`;
    case "upgradeRange": return `${ORDER_ICONS.upgradeRange} Upgrade range`;
  }
}

/** In rounds mode a tank action becomes an order for the plan; otherwise it happens right away. */
function intent(s: GameState, order: OrderAction): PlayerAction {
  return s.config.mode === "rounds" ? { type: "order", playerId: order.playerId, order } : order;
}

/** Your own stats and the clock (and, in rounds mode, your plan), in one bar above the board. */
function hud(s: GameState, mine: Tank | undefined, plan: Plan): string {
  const stats = mine
    ? `<button class="hud-me" data-tank="${mine.id}" style="--c:${mine.color}" title="Open your tank's actions">
        <span class="swatch"></span>${esc(mine.name)}</button>
      <span class="stat" title="Hearts">♥ <b>${mine.hearts}</b></span>
      <span class="stat" title="Action points">⚡ <b>${mine.ap}</b> AP</span>
      <span class="stat" title="Range">◎ <b>${mine.range}</b> range</span>`
    : `<span class="muted">Spectating</span>`;
  const host = s.config.debug && mine?.id === s.hostId;
  let clock = "";
  if (s.phase === "playing" && s.resolving) {
    const current = s.resolving.done?.playerId;
    const order = s.resolving.turnOrder
      .map((id) => `<span class="${id === current ? "current" : ""}">${esc(s.tanks[id]?.name ?? "?")}</span>`)
      .join(" → ");
    clock = `<span class="clock resolving"><span class="muted small">Playing out</span> ${order}</span>`;
  } else if (s.phase === "playing") {
    const rounds = s.config.mode === "rounds";
    clock = `<span class="clock"><span class="muted small">${rounds ? "Round ends in" : "Next AP in"}</span> <b id="countdown">–</b>
      ${host ? `<button class="small" data-act="force-tick">${rounds ? "End round" : "Force tick"}</button>` : ""}</span>`;
  }
  const planBar = plan.planning && mine
    ? `<div class="plan-bar ${plan.order ? "has-order" : ""}">
        <span class="small muted">This round:</span>
        ${plan.order
          ? `<b class="small">${describeOrder(s, plan.order)}</b><button class="small" data-act="cancel">Cancel</button>`
          : `<span class="small muted">no order yet — click a green square or a tank</span>`}
      </div>`
    : "";
  return `<div class="hud">${stats}${clock}${planBar}</div>`;
}

/** Every tank at a glance; click one to open its menu. */
function roster(s: GameState, mine: Tank | undefined): string {
  const tally = juryTally(s);
  const bots = ui.msg?.bots ?? {};
  const turn = (id: string) => (s.phase === "playing" && s.resolving ? s.resolving.turnOrder.indexOf(id) : -1);
  const chips = s.order
    .map((id) => s.tanks[id]!)
    .sort((a, b) => Number(b.alive) - Number(a.alive))
    .map((t) => {
      const status = turn(t.id) >= 0 ? `<span class="badge" title="Turn order this round">#${turn(t.id) + 1}</span>` : "";
      return `
      <button class="tank-chip ${t.alive ? "" : "dead"} ${t.id === ui.targetId ? "targeted" : ""}" data-tank="${t.id}" style="--c:${t.color}"
        title="${esc(tankTitle(t))}">
        <span class="swatch"></span>${esc(t.name)}${t.id === mine?.id ? " (you)" : ""}${bots[t.id] ? " 🤖" : ""}
        <span class="muted">${t.alive ? `♥${t.hearts} ⚡${t.ap} ◎${t.range}` : "destroyed"}</span>${tally[t.id] ? " 🗳️" : ""}${status}
      </button>`;
    })
    .join("");
  return `<div class="roster" aria-label="${livingTanks(s).length} tanks alive">${chips}</div>`;
}

/** The menu that opens over a clicked tank: what you can do to (or with) it right now. */
function popover(s: GameState, mine: Tank | undefined, plan: Plan, t: Tank): string {
  const isMe = t.id === mine?.id;
  const dist = mine && !isMe ? distance(mine, t) : null;
  const bot = ui.msg?.bots[t.id];
  const rounds = s.config.mode === "rounds";
  let actions = "";
  if (mine && s.phase === "playing") {
    if (rounds && s.resolving && mine.alive) {
      actions = `<p class="muted small">This round is playing out — you can plan again in a moment.</p>`;
    } else if (isMe && mine.alive) {
      const upgrade = intent(s, { type: "upgradeRange", playerId: mine.id });
      actions = `<div class="actions"><button class="primary" data-act="upgrade" ${canApply(s, upgrade) ? "" : "disabled"}>⬆ ${rounds ? "Plan: upgrade" : "Upgrade"} range (${s.config.upgradeRangeCost} AP)</button></div>`;
    } else if (isMe && s.juryVotes[mine.id]) {
      actions = `<p class="small">Your jury vote: <b>${esc(s.tanks[s.juryVotes[mine.id]!]?.name ?? "?")}</b></p>`;
    } else if (!isMe && mine.alive) {
      const shoot = intent(s, { type: "shoot", playerId: mine.id, targetId: t.id });
      const ap = intent(s, { type: "giveAP", playerId: mine.id, targetId: t.id });
      const heart = intent(s, { type: "giveHeart", playerId: mine.id, targetId: t.id });
      actions = `
        <div class="actions">
          ${t.alive ? `<button class="danger" data-act="shoot" ${canApply(s, shoot) ? "" : "disabled"}>💥 ${rounds ? "Plan a shot" : "Shoot"} (1 AP)</button>` : ""}
          ${t.alive ? `<button data-act="giveAP" ${canApply(s, ap) ? "" : "disabled"}>⚡ Give 1 AP</button>` : ""}
          ${s.config.allowGiveHeart ? `<button data-act="giveHeart" ${canApply(s, heart) ? "" : "disabled"}>♥ ${t.alive ? "Give a heart" : "Revive with a heart"}</button>` : ""}
        </div>
        ${dist !== null && dist > mine.range ? `<p class="muted small">Out of range: ${dist} away, your range is ${mine.range}.</p>` : ""}
        ${plan.planning ? `<p class="muted small">This becomes your order for the round${plan.order ? ", replacing the current one" : ""}. It happens when the round ends — if ${esc(t.name)} is still in range by your turn.</p>` : ""}`;
    } else if (!isMe && t.alive) {
      const voted = s.juryVotes[mine.id] === t.id;
      actions = `<div class="actions"><button data-act="vote" ${voted ? "disabled" : ""}>${voted ? "Voted ✓" : "🗳️ Jury vote for this tank"}</button></div>`;
    }
  }
  return `
    <div class="pop-head"><span class="swatch"></span><b>${esc(t.name)}</b>${isMe ? ` <span class="muted small">(you)</span>` : ""}
      ${bot ? `<span class="badge">🤖 ${bot}</span>` : ""}${t.alive ? "" : `<span class="badge">destroyed</span>`}
      <button class="link small" data-act="untarget" aria-label="Close">✕</button></div>
    <div class="pop-stats">♥ ${t.hearts} · ⚡ ${t.ap} AP · ◎ range ${t.range}${dist !== null ? ` · ${dist} away` : ""}
      ${plan.order && plan.marks.get(t.id) ? `<br />Your order: ${describeOrder(s, plan.order)}` : ""}</div>
    ${actions}
    ${mine && !isMe && !bot ? `<button class="small dm" data-act="dm">✉️ Message privately</button>` : ""}`;
}

/** Pin the tank menu just above its tank (or below, near the top of the screen), inside the viewport. */
function placePopover(): void {
  const pop = document.getElementById("popover");
  const cell = ui.targetId ? app.querySelector<HTMLElement>(`.cell[data-tank="${ui.targetId}"]`) : null;
  if (!pop || !cell) return;
  const r = cell.getBoundingClientRect();
  const { width, height } = pop.getBoundingClientRect();
  const margin = 8;
  const above = r.top - height - margin;
  pop.style.top = `${above >= margin ? above : r.bottom + margin}px`;
  pop.style.left = `${Math.min(Math.max(margin, r.left + r.width / 2 - width / 2), innerWidth - width - margin)}px`;
}
addEventListener("resize", placePopover);
addEventListener("scroll", placePopover, true);

function cellHtml(s: GameState, mine: Tank | undefined, plan: Plan, x: number, y: number): string {
  const t = tankAt(s, { x, y });
  const cls = ["cell"];
  let data = `data-x="${x}" data-y="${y}"`;
  const canAct = mine?.alive && s.phase === "playing" && !(s.config.mode === "rounds" && s.resolving);
  if (mine && canAct) {
    const d = distance(mine, { x, y });
    if (d <= mine.range) cls.push("in-range");
    if (d === 1 && !t && canApply(s, intent(s, move(mine, x, y)))) cls.push("can-move");
  }
  if (s.pickups.some((p) => p.x === x && p.y === y)) cls.push("pickup");
  const planned = plan.moveTo === `${x},${y}`;
  if (planned) cls.push("planned");
  if (t) {
    cls.push("has-tank");
    if (t.id === ui.targetId) cls.push("targeted");
    data += ` data-tank="${t.id}"`;
  }
  let inner = t
    ? `<div class="tank ${t.alive ? "" : "wreck"} ${t.id === mine?.id ? "mine" : ""}" style="--c:${t.color}" title="${esc(tankTitle(t))}">
        <span class="initials">${esc(initials(t.name))}</span>
        <span class="hp">${t.alive ? "♥".repeat(Math.min(t.hearts, 5)) + (t.hearts > 5 ? "+" : "") : "✖"}</span>
      </div>`
    : "";
  // Where your planned move takes you: a see-through "ghost" of your tank.
  if (planned && mine && !t) {
    inner = `<div class="tank ghost" style="--c:${mine.color}" title="Your planned move"><span class="initials">${esc(initials(mine.name))}</span></div>`;
  }
  const mark = t ? plan.marks.get(t.id) : undefined;
  if (mark) inner += `<span class="order-mark" title="Your order for this round">${mark}</span>`;
  return `<div class="${cls.join(" ")}" ${data}>${inner}</div>`;
}

function logPanel(s: GameState): string {
  const items = s.log
    .slice(-40)
    .reverse()
    .map((e) => `<li><span class="muted small">${fmtTime(e.at)}</span> ${esc(e.text)}</li>`)
    .join("");
  return `<div class="card"><h3>Events</h3><ul class="log">${items}</ul></div>`;
}

function chatPanel(s: GameState, mine: Tank | undefined): string {
  const chat = ui.msg?.chat ?? [];
  const bots = ui.msg?.bots ?? {};
  const name = (id: string) => esc(s.tanks[id]?.name ?? "someone");
  const items = chat.map((m: ChatMessage) => {
    const color = s.tanks[m.from]?.color ?? "var(--muted)";
    const who = m.to === null
      ? `<b>${name(m.from)}</b>`
      : `<b>${name(m.from)}</b> → <b>${name(m.to)}</b> <span class="muted">(private)</span>`;
    return `<li class="${m.to === null ? "" : "private"}"><span class="swatch" style="--c:${color}"></span>
      <span class="muted small">${fmtTime(m.at)}</span> ${who}: ${esc(m.text)}</li>`;
  }).join("");
  const others = s.order
    .filter((id) => id !== mine?.id && !bots[id])
    .map((id) => `<option value="${id}">🔒 ${name(id)}</option>`)
    .join("");
  const form = mine
    ? `<form id="chat-form" class="row chat-form">
        <select name="to" id="chat-to" aria-label="Send to"><option value="">Everyone</option>${others}</select>
        <input name="text" id="chat-input" maxlength="300" autocomplete="off" placeholder="Say something…" />
        <button type="submit">Send</button>
      </form>`
    : `<p class="muted small">Join the game to chat.</p>`;
  return `
    <div class="card chat">
      <h3>Chat</h3>
      <ul class="chat-log" id="chat-log">${items || `<li class="muted small">No messages yet. Make some deals!</li>`}</ul>
      ${form}
    </div>`;
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
  if (button) return void onButton(button.dataset.act!, button);
  const cell = el.closest<HTMLElement>(".cell");
  if (cell) return onCell(Number(cell.dataset.x), Number(cell.dataset.y), cell.dataset.tank);
  // Tank chips under the board and your name in the bar open the same menu as the tank itself.
  const chip = el.closest<HTMLElement>("button[data-tank]");
  if (chip) {
    ui.targetId = ui.targetId === chip.dataset.tank ? null : (chip.dataset.tank ?? null);
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
    } else if (form.id === "chat-form" && ui.session) {
      const text = String(data.get("text") ?? "").trim();
      if (!text) return;
      await api.say(ui.session, text, String(data.get("to") ?? "") || null);
      // The screen may have been rebuilt while sending, so look the input up again.
      const input = document.getElementById("chat-input") as HTMLInputElement | null;
      if (input) input.value = "";
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
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
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
  void send(intent(s, { type: "move", playerId: mine.id, dx: dir[0], dy: dir[1] }));
});

function onCell(x: number, y: number, tankId: string | undefined): void {
  const s = ui.msg?.state;
  if (!s || s.phase === "lobby") return;
  const mine = me(s);
  if (tankId) {
    ui.targetId = ui.targetId === tankId ? null : tankId;
    renderGame();
    return;
  }
  if (mine?.alive && distance(mine, { x, y }) === 1) {
    void send(intent(s, move(mine, x, y)));
    return;
  }
  if (ui.targetId) {
    ui.targetId = null;
    renderGame();
  }
}

async function onButton(act: string, button: HTMLButtonElement): Promise<void> {
  const s = ui.msg?.state;
  const mine = s && me(s);
  const target = ui.targetId ?? "";
  switch (act) {
    case "home": return goTo(null);
    case "practice": return startPractice(button.form);
    case "add-bot": {
      const kind = (document.getElementById("bot-kind") as HTMLSelectElement | null)?.value as BotPersonality | undefined;
      if (ui.session && kind) await guard(() => api.addBot(ui.session!, kind));
      return;
    }
    case "remove-bot":
      if (ui.session && button.dataset.id) await guard(() => api.removeBot(ui.session!, button.dataset.id!));
      return;
    case "dm": {
      const to = document.getElementById("chat-to") as HTMLSelectElement | null;
      const input = document.getElementById("chat-input") as HTMLInputElement | null;
      if (to && target) to.value = target;
      input?.focus();
      return;
    }
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
  if (!mine || !s) return;
  const id = mine.id;
  const actions: Record<string, PlayerAction> = {
    start: { type: "start", playerId: id, now: 0 },
    leave: { type: "leave", playerId: id },
    upgrade: intent(s, { type: "upgradeRange", playerId: id }),
    shoot: intent(s, { type: "shoot", playerId: id, targetId: target }),
    giveAP: intent(s, { type: "giveAP", playerId: id, targetId: target }),
    giveHeart: intent(s, { type: "giveHeart", playerId: id, targetId: target }),
    vote: { type: "juryVote", playerId: id, targetId: target },
    cancel: { type: "cancelOrder", playerId: id },
  };
  const action = actions[act];
  if (!action) return;
  // Planning a shot isn't final, so only ask before a real-time killing blow.
  if (act === "shoot" && s.config.mode !== "rounds" && !confirmShoot(s, target)) return;
  const sent = await send(action);
  if (sent && act === "leave" && ui.session) {
    clearSession(ui.session.gameId);
    ui.session = null;
    goTo(null);
  }
}

/** One click from the home screen to a running Quick game against bots. */
async function startPractice(form: HTMLFormElement | null): Promise<void> {
  if (!form?.reportValidity()) return;
  const name = String(new FormData(form).get("name")).trim();
  rememberName(name);
  await guard(async () => {
    const r = await api.create(name, DEFAULT_PRESET, {}, PRACTICE_BOTS);
    const session = { gameId: r.gameId, playerId: r.playerId, token: r.token };
    saveSession(session);
    await api.act(session, { type: "start", playerId: r.playerId, now: 0 });
    goTo(r.gameId);
  });
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

function move(from: Tank, x: number, y: number): OrderAction {
  return { type: "move", playerId: from.id, dx: x - from.x, dy: y - from.y };
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

function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
