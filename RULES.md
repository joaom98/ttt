# Rules

These are the rules the code implements today, based on the original Halfbrick prototype. Numbers in
*italics* are the defaults; the host can change them when creating the game (**Rule tweaks**) or in the
lobby before starting (see `shared/src/config.ts`). The host can also remove players from the lobby.

## Setup

- Every player gets a tank on a square grid. The board grows with the number of players
  (*about 16 squares per tank, at least 8×8*), and tanks start spread out at random.
- Each tank starts with *3 hearts*, *range 2* and *0 action points (AP)*.

## Action points

- On every **tick**, each living tank receives *1 AP*. The classic game ticks once *every 24 hours*;
  the Evening and Quick paces tick every 10 minutes / 30 seconds for live sessions.
- AP can be saved up indefinitely. You can act at any time — it isn't turn-based.

## Actions

| Action | Cost | Effect |
| --- | --- | --- |
| Move | 1 AP | Move to an adjacent empty square (diagonals allowed). |
| Shoot | 1 AP | Fire at a **square** within your range. The tank on it when the shot lands loses 1 heart; if the square is empty (the tank moved away), the shot **misses** — the AP is spent either way. You can't shoot your own square. |
| Upgrade range | *3 AP* | Your range increases by 1. |
| Give AP | 1 AP | Transfer 1 AP to a living tank within range. |
| Give a heart | 1 heart | Give one of your hearts to a tank within range. You must keep at least one. |
| Heal | *3 AP* | Repair 1 heart, up to your starting hearts. *On by default.* |
| Defense | 1 AP | Brace for a hit (for the round in rounds mode; until the next tick in real time). Every shot at you does no damage. |
| Parry | 2 AP | Like a defense, but each shooter also pays: it loses *1 AP* to you (if it has any) and is *stunned*, losing its next turn (the next round, or until the next tick in real time). Optionally (*off by default*) it also takes a counter-hit of *1 heart*, which can destroy it — you then count as the killer. |

You can only have one guard (defense or parry) up at a time.

**Range** is measured in squares including diagonals: range 2 covers the 5×5 area around you.

## Death, the jury and revival

- A tank at 0 hearts is destroyed. *Its remaining AP goes to the tank that destroyed it.* The wreck stays
  on the board (it still blocks the square).
- Destroyed players form the **jury**. Each tick, each juror may vote for one living tank. A tank that
  receives *3 or more* votes gets a bonus AP at the next tick. Votes are secret and reset every tick.
- *Giving a heart to a destroyed tank revives it* with 1 heart and 0 AP.

## Timing: real time or rounds

Each game uses one of two timing modes (*real time* by default; the **Rounds** pace uses rounds).

- **Real time:** spend AP whenever you like; actions happen the moment you click.
- **Rounds:** the game runs in rounds (*10 seconds* of planning each) on their **own clock**, separate
  from the AP ticks (*also every 10 seconds* in the Rounds pace — set them apart to make AP scarcer or more
  plentiful). During a round you plan **one order** — a move, a shot, a gift, an upgrade, a heal or a
  guard — checked against the board as it is. Shots are aimed at squares, so planning one means
  predicting where your target will be when your turn comes. Picking another order replaces it, and you can cancel it.
  Orders are **secret** until they play out. When the round's timer runs out:
  1. **Stunned tanks sit the round out** (their order, if any, is dropped).
  2. **Defenses and parries go up**, before anyone acts, so they protect you whatever the turn order.
     (In real time a guard is visible to everyone; in rounds it's a secret guess.)
  3. The other tanks that planned something are put in a **random order**, announced in the event log.
     Tanks that planned nothing simply sit the round out.
  4. One tank at a time, in that order, carries out its order.
  5. An order that no longer works when its turn comes (a gift's target moved out of range, the square you
     were driving to was taken…) is **skipped and costs nothing**. A shot always fires — it just misses
     if nobody is on its square any more.
  6. Then guards drop, tanks that sat this round out recover, and the next round's planning starts.
     (A tank stunned *during* this round sits the next one out.)

  AP income, the jury's bonus and heart spawns happen on the AP tick, whenever it comes round.

  A tank destroyed earlier in the round doesn't get to act, so going first can decide a duel. Chat stays
  live the whole time.

## Optional rules

- *Heart pickups:* a number of hearts can appear on empty squares each tick (*0 by default*). Drive onto
  one to gain a heart.

## Winning

The last tank standing wins. Alliances, betrayals and diplomacy are entirely up to the players.

Afterwards the host can click **Play again**: everyone goes back to the lobby with the same rules and
fresh tanks (players can still join or leave) for a rematch.
