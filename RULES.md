# Rules

These are the rules the code implements today, based on the original Halfbrick prototype. Numbers in
*italics* are the defaults and can be changed per game in **Rule tweaks** (see `shared/src/config.ts`).

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
| Shoot | 1 AP | A tank within your range loses 1 heart. |
| Upgrade range | *3 AP* | Your range increases by 1. |
| Give AP | 1 AP | Transfer 1 AP to a living tank within range. |
| Give a heart | 1 heart | Give one of your hearts to a tank within range. You must keep at least one. |

**Range** is measured in squares including diagonals: range 2 covers the 5×5 area around you.

## Death, the jury and revival

- A tank at 0 hearts is destroyed. *Its remaining AP goes to the tank that destroyed it.* The wreck stays
  on the board (it still blocks the square).
- Destroyed players form the **jury**. Each tick, each juror may vote for one living tank. A tank that
  receives *3 or more* votes gets a bonus AP at the next tick. Votes are secret and reset every tick.
- *Giving a heart to a destroyed tank revives it* with 1 heart and 0 AP.

## Optional rules

- *Heart pickups:* a number of hearts can appear on empty squares each tick (*0 by default*). Drive onto
  one to gain a heart.

## Winning

The last tank standing wins. Alliances, betrayals and diplomacy are entirely up to the players.
