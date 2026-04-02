# Root cause: position opens then closes immediately

## What was happening

Positions opened from **#fixedlot** (single-account) were sometimes closed almost immediately by the hedge logic that is meant to keep **paired** positions in sync (place-on-both from Settings).

## Why it happened

1. **Hedge sync** (backend, every 15s) and **hedge watcher** (Python) both use the **pairs list** (`position_pairs.json`). That list only contains pairs created by “place on both” (both legs succeeded). Single-account positions from FixedLot are **not** added to that list.

2. **Stale pair + ticket reuse**  
   If an old pair was still in the file (e.g. both legs were closed but the pair was not removed, or the broker later **reused** the same ticket number for a new position), then:
   - Hedge sync sees: “ticket A on account X is in the list, ticket B on account Y is missing”.
   - It then closes the “orphan” leg — **ticket A on account X**.
   - If that ticket A is actually your **new** FixedLot position (same number reused), it gets closed by mistake.

3. **Comment not reliable**  
   We already skip closing when the position **comment** contains `"fixedlot"`. Some brokers or MT5 builds can change or drop the comment, so the hedge logic could not always recognize single-account positions and closed them anyway.

## What we changed (fix)

1. **Single-account ticket registration**  
   When you open a position via **single-account** API (`POST /api/positions` with `account_id`, i.e. FixedLot), the backend now:
   - Parses the response for `order_ticket` (or `position`),
   - Appends `(ticket, account_id)` to a stored list,
   - Saves that list to `data/single_account_tickets.json`.

2. **Hedge logic never closes registered tickets**  
   - In **hedge_sync_task**: before closing any “orphan” leg, we check if `(ticket, account_id)` is in the single-account list; if yes, we **skip** closing and remove the pair from the list so it is not retried.
   - In **hedge_close_orphan**: same check first; if the ticket is registered as single-account, we do **not** close it and return “skipped”.

3. **Comment check kept**  
   The existing “fixedlot” comment check is still there as a second layer in hedge_sync.

4. **Pruning**  
   When a position is closed (by you, SL/TP, or anything else), its ticket eventually disappears from the open positions. Each hedge_sync cycle prunes the single-account list: any `(ticket, account_id)` whose ticket is no longer open on that account is removed, so the list does not grow forever (capped at 2000 entries).

## Result

- FixedLot (single-account) positions are **registered** when opened.
- They are **never** closed by hedge_sync or hedge_close_orphan, even if:
  - The broker changes the comment, or
  - An old pair in `position_pairs.json` refers to the same ticket number (reuse).
- After you **restart the backend**, new FixedLot positions will be protected. Existing open positions are not in the list until you open new ones; if you still see an old position close, it was likely due to the above causes and the new logic will prevent it for future opens.

## If it still happens

1. Check **backend logs** (`logs/mt5_panel.log`): look for `hedge_sync: skipping close ... (registered single-account/fixedlot)` or `hedge_close_orphan: skipped close ... (registered single-account/fixedlot)` to confirm the skip is applied.
2. Check for `create_position: registered single-account ticket X on Y` after opening from FixedLot — if that line is missing, the bridge response might not include `order_ticket`.
3. Ensure you are opening from **#fixedlot** (so the request includes `account_id` and the backend uses the single-account path). Positions opened from the main worker (Settings “place on both”) are still subject to rollback when one leg fails.
