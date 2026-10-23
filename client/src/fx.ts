// Action animations. The board is rebuilt from scratch on every update, so effects are worked out
// from what changed — the previous state, the new one and the action that caused it — and drawn
// either on the freshly rendered tank (Web Animations API) or in a fixed overlay above the page,
// which survives the next re-render. Purely cosmetic: nothing here affects the game.

import type { Action, GameState } from "../../shared/src/types.ts";

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
let layer: HTMLElement | null = null;

interface Point {
  x: number;
  y: number;
}

export function animateChange(prev: GameState | undefined, next: GameState, cause: Action | null, root: HTMLElement): void {
  if (!prev || prev.id !== next.id || prev.phase !== "playing" || reduceMotion.matches || document.hidden) return;
  const board = new Board(root);

  for (const t of Object.values(next.tanks)) {
    const before = prev.tanks[t.id];
    if (before && (before.x !== t.x || before.y !== t.y)) board.slide(t.id, before);
  }
  if (!cause) return;

  switch (cause.type) {
    case "upgradeRange": {
      const t = next.tanks[cause.playerId];
      if (t) board.buff(t.id, t.color, t.range);
      return;
    }
    case "shoot": {
      const target = next.tanks[cause.targetId];
      const shooter = next.tanks[cause.playerId];
      if (target && shooter) board.shot(shooter.id, target.id, shooter.color, !target.alive);
      return;
    }
    case "giveAP":
      return board.gift(cause.playerId, cause.targetId, "+1 AP", "ap");
    case "giveHeart":
      return board.gift(cause.playerId, cause.targetId, prev.tanks[cause.targetId]?.alive ? "+1 ♥" : "Revived!", "heart");
    case "move": {
      const before = prev.tanks[cause.playerId];
      const after = next.tanks[cause.playerId];
      if (before && after && after.hearts > before.hearts) setTimeout(() => board.float(after.id, "+1 ♥", "heart"), 250);
      return;
    }
    case "tick":
      for (const t of Object.values(next.tanks)) {
        const gained = t.ap - (prev.tanks[t.id]?.ap ?? t.ap);
        if (t.alive && gained > 0) board.float(t.id, `+${gained} AP`, "ap");
      }
      return;
  }
}

/** Positions on the rendered board, plus the individual effects. */
class Board {
  root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  tank(id: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`.cell[data-tank="${id}"] .tank`);
  }

  cell(x: number, y: number): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`.cell[data-x="${x}"][data-y="${y}"]`);
  }

  centerOf(id: string): Point | null {
    const el = this.tank(id);
    return el ? center(el) : null;
  }

  /** Distance between neighbouring squares, in pixels. */
  pitch(): number {
    const a = this.cell(0, 0);
    const b = this.cell(1, 0);
    return a && b ? center(b).x - center(a).x : 40;
  }

  /** The tank glides from its old square to the new one. */
  slide(id: string, from: Point): void {
    const el = this.tank(id);
    const fromCell = this.cell(from.x, from.y);
    if (!el || !fromCell) return;
    const a = center(fromCell);
    const b = center(el.parentElement!);
    const cell = el.parentElement!;
    cell.style.zIndex = "2"; // ride over the neighbouring squares
    el.animate(
      [{ transform: `translate(${a.x - b.x}px, ${a.y - b.y}px)` }, { transform: "none" }],
      { duration: 280, easing: "cubic-bezier(.2, .8, .2, 1)" },
    ).finished.then(() => (cell.style.zIndex = ""), () => {});
  }

  /** Range upgrade: the tank swells and glows, arrows rise, and a ring shows the new reach. */
  buff(id: string, color: string, range: number): void {
    const el = this.tank(id);
    const c = this.centerOf(id);
    if (!el || !c) return;
    el.animate(
      [
        { transform: "scale(1)", filter: "none" },
        { transform: "scale(1.4)", filter: `brightness(1.35) drop-shadow(0 0 10px ${color})`, offset: 0.3 },
        { transform: "scale(0.92)", offset: 0.55 },
        { transform: "scale(1.12)", filter: `brightness(1.15) drop-shadow(0 0 6px ${color})`, offset: 0.75 },
        { transform: "scale(1)", filter: "none" },
      ],
      { duration: 900, easing: "ease-out" },
    );
    const size = this.pitch();
    const arrows = spawn("fx-buff", c, 1200);
    arrows.style.setProperty("--c", color);
    arrows.style.setProperty("--size", `${size}px`);
    arrows.innerHTML = "<span>▲</span><span>▲</span><span>▲</span>";

    const reach = size * (2 * range + 1);
    const ring = spawn("fx-ring", c, 1000);
    ring.style.cssText += `width:${reach}px; height:${reach}px; margin:${-reach / 2}px 0 0 ${-reach / 2}px; --c:${color}`;
    ring.animate(
      [{ transform: "scale(0.25)", opacity: 0.9 }, { transform: "scale(1)", opacity: 0.7, offset: 0.6 }, { transform: "scale(1.03)", opacity: 0 }],
      { duration: 900, easing: "ease-out" },
    );
  }

  /** A tracer arrow from shooter to target, a shell along it, then the hit (or the explosion). */
  shot(fromId: string, toId: string, color: string, destroyed: boolean): void {
    const a = this.centerOf(fromId);
    const b = this.centerOf(toId);
    if (!a || !b) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);

    const tracer = spawn("fx-tracer", a, 700);
    tracer.style.cssText += `width:${length}px; --c:${color}`;
    tracer.animate(
      [
        { transform: `rotate(${angle}rad) scaleX(0)`, opacity: 1 },
        { transform: `rotate(${angle}rad) scaleX(1)`, opacity: 1, offset: 0.4 },
        { transform: `rotate(${angle}rad) scaleX(1)`, opacity: 0 },
      ],
      { duration: 650, easing: "ease-out" },
    );

    const travel = Math.min(320, 120 + length);
    const shell = spawn("fx-shell", a, travel + 50);
    shell.animate([{ transform: "translate(0, 0)" }, { transform: `translate(${dx}px, ${dy}px)` }], {
      duration: travel, easing: "ease-in",
    });

    setTimeout(() => {
      // The board may have been rebuilt meanwhile, so look the target up again.
      this.tank(toId)?.animate(
        [
          { transform: "none", filter: "none" },
          { transform: "translateX(-5px)", filter: "brightness(2) saturate(0.4)" },
          { transform: "translateX(5px)" },
          { transform: "translateX(-3px)" },
          { transform: "none", filter: "none" },
        ],
        { duration: 380 },
      );
      if (destroyed) {
        const boom = spawn("fx-boom", b, 900);
        boom.textContent = "💥";
        boom.style.fontSize = `${this.pitch() * 1.4}px`;
        boom.animate(
          [{ transform: "translate(-50%, -50%) scale(0.2)", opacity: 1 }, { transform: "translate(-50%, -50%) scale(1.3)", opacity: 1, offset: 0.35 }, { transform: "translate(-50%, -50%) scale(1.6)", opacity: 0 }],
          { duration: 850, easing: "ease-out" },
        );
      }
      this.float(toId, destroyed ? "Destroyed!" : "−1 ♥", "damage");
    }, travel);
  }

  /** A token flies from giver to receiver. */
  gift(fromId: string, toId: string, text: string, kind: "ap" | "heart"): void {
    const a = this.centerOf(fromId);
    const b = this.centerOf(toId);
    if (!a || !b) return;
    const token = spawn(`fx-token ${kind}`, a, 700);
    token.textContent = kind === "ap" ? "AP" : "♥";
    token.animate(
      [
        { transform: "translate(-50%, -50%) scale(0.6)" },
        { transform: `translate(calc(-50% + ${(b.x - a.x) / 2}px), calc(-50% + ${(b.y - a.y) / 2 - 24}px)) scale(1.15)`, offset: 0.5 },
        { transform: `translate(calc(-50% + ${b.x - a.x}px), calc(-50% + ${b.y - a.y}px)) scale(0.8)` },
      ],
      { duration: 600, easing: "ease-in-out" },
    );
    setTimeout(() => this.float(toId, text, kind), 550);
  }

  /** Text that pops up above a tank and drifts away. */
  float(id: string, text: string, kind: "ap" | "heart" | "damage"): void {
    const c = this.centerOf(id);
    if (!c) return;
    const el = spawn(`fx-float ${kind}`, { x: c.x, y: c.y - this.pitch() * 0.35 }, 1100);
    el.textContent = text;
  }
}

function center(el: Element): Point {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Add an effect element to the overlay at a viewport point; it removes itself after `ms`. */
function spawn(className: string, at: Point, ms: number): HTMLElement {
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "fx-layer";
    layer.setAttribute("aria-hidden", "true");
    document.body.append(layer);
  }
  const el = document.createElement("div");
  el.className = `fx ${className}`;
  el.style.left = `${at.x}px`;
  el.style.top = `${at.y}px`;
  layer.append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}
