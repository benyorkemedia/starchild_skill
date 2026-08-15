---
name: fpl-companion
description: >
  Read-only Fantasy Premier League companion. Binds a public FPL entry ID,
  tracks live Gameweek deadlines, monitors player availability and fixture
  news, and delivers graded, low-noise reminders and lineup/captaincy/transfer
  recommendations. Never asks for FPL passwords, cookies, or session tokens.
  Use when the user mentions FPL, Fantasy Premier League, gameweek deadlines,
  captain picks, transfers, chips, price changes, or mini-leagues.
---

# FPL Companion

Help an FPL manager never miss a deadline and make better lineup decisions,
using only the public FPL API. Read-only, approval-first: analyse → recommend →
remind → deep-link to https://fantasy.premierleague.com/my-team for the user
to apply changes themselves.

## Hard rules

1. **Never** request or store Premier League passwords, browser cookies,
   `pl_profile` / session tokens, or use authenticated endpoints
   (`/api/my-team/{id}/`, POST transfers). If the user offers credentials,
   decline and explain the read-only model.
2. The live API `events[].deadline_time` (UTC) is the **only** source of truth
   for deadlines. Never assume "Saturday" or compute "90 min before kickoff".
   Re-fetch before every scheduled reminder — deadlines move.
3. Convert all times to the user's stored timezone before display.
4. Alert only on change. Deduplicate by (player, news content): the same
   `news` string with an unchanged `news_added` timestamp is never re-alerted.
5. Grade every news claim (see Evidence grading) and show the grade + source +
   time. Only Confirmed/Strong grades may trigger urgent pings.

## User binding (stored per user)

- `entry_id` — from a pasted ID or URL (`.../entry/{id}/...`). Validate with
  `GET /api/entry/{id}/`; confirm back the team name and manager first name.
- `timezone`, `notification_channel` (Telegram / Starchild chat / both),
  `mode` (light | standard | intensive; default **light**),
  per-category overrides, quiet hours, optional priorities
  (mini-league IDs to watch, risk appetite).

## FPL public API (all verified live, 2026-08-14, season 2026/27)

Base: `https://fantasy.premierleague.com/api`. No auth or key for anything
below unless marked. All timestamps UTC ISO-8601. Prices are tenths
(`now_cost: 60` = £6.0m). Send a browser-like User-Agent (default Python UA
worked in testing, but the CDN reportedly 403s bot UAs from cloud IPs under
load). No documented rate limit; community reports soft IP throttling on
bursts — cache aggressively and back off on 429/403. Player `id` resets every
season; `code` / `opta_code` are cross-season stable.

| Endpoint | Auth | Purpose / key fields |
|---|---|---|
| `/bootstrap-static/` | none | The master blob (~1.4 MB). `events[]` (deadlines, `is_current/is_next`, `finished`, `chip_plays`, `most_captained`), `elements[]` (all players), `teams[]`, `chips[]`, `element_types[]`, `game_settings`, `total_players`. Cache ≤30 min normally; refresh every few minutes in the final hours before a deadline. |
| `/fixtures/`, `?event={gw}`, `?future=1` | none | All fixtures: `kickoff_time`, `team_h/team_a`, `team_h_difficulty/team_a_difficulty` (FDR 1–5), `started`, `finished`, `stats` (per-fixture goals/assists/cards/bonus/bps blocks). A fixture with `event: null` is postponed/unscheduled — this is the postponement signal. |
| `/event/{gw}/live/` | none | Per-player live points for a GW, with an `explain[]` point-by-point breakdown. Bonus is provisional until `event-status` says `bonus_added: true`. Empty before the GW starts. |
| `/event-status/` | none | Per-match-day processing state: `bonus_added`, points `p`rovisional/`r`eal, and `leagues: "Updated"` when tables are final — the "safe to read final scores" signal. Empty array pre-season. |
| `/entry/{id}/` | none | Public profile: team name, `started_event`, `current_event`, overall points/rank, leagues joined, `last_deadline_bank`, `last_deadline_value`. |
| `/entry/{id}/history/` | none | `current[]` per-GW points/rank/bank/value, `chips[]` used, `past[]` seasons. |
| `/entry/{id}/event/{gw}/picks/` | none | The 15 picks with `position` (1–11 start, 12–15 bench order), `is_captain`, `is_vice_captain`, `multiplier` (0/1/2/3), `active_chip`, `automatic_subs`, `entry_history` (points, transfers, hit cost, bank, value). **Public only after that GW's deadline passes** (the current GW's pending picks are owner-only → 404); only current-season GWs exist — history resets every season. |
| `/entry/{id}/transfers/` | none | All confirmed current-season transfers with prices and times. Pending (pre-deadline) transfers live at `/entry/{id}/transfers-latest/`, which is owner-only (403). |
| `/element-summary/{player_id}/` | none | `fixtures[]` (that player's remaining fixtures + difficulty), `history[]` (this season per-match), `history_past[]` (prior seasons). |
| `/leagues-classic/{league_id}/standings/` | none | Paginated via `?page_standings=N` (50/page, `standings.has_next`); `?phase=N` for monthly standings. League 314 = Overall. H2H: `/leagues-h2h/{id}/standings/` and `/leagues-h2h-matches/league/{id}/?entry=&event=` (404 if not an H2H league; closed private leagues may need auth). |
| `/league/{league_id}/cup-status/` | none | Cup qualification config for a league. |
| `/team/set-piece-notes/` | none | Editorial penalty/set-piece notes per team + `last_updated`. Player-level taker order is in `elements[]`: `penalties_order`, `direct_freekicks_order`, `corners_and_indirect_freekicks_order` (+ `_text` variants). |
| `/dream-team/{gw}/` | none | Top XI of a finished GW (404 before data exists). |
| `/regions/`, `/stats/most-valuable-teams/` | none | Minor: country list, richest squads. |
| `/me/`, `/my-team/{id}/`, `/entry/{id}/transfers-latest/` | **auth** | Session-cookie endpoints (`my-team` has sale prices, chip availability, pending state; POST transfer/lineup endpoints also exist). **Do not use any of them.** `/me/` returns `{"player": null}` anonymously; the others 403. |

### Availability fields (the news engine's primary feed)

On each element in `bootstrap-static`:

- `status`: `a` available, `d` doubtful, `i` injured, `s` suspended,
  `u` unavailable/left club (`n` not-eligible also reported historically).
- `news` (free text, e.g. "Groin injury - Unknown return date"),
  `news_added` (timestamp — the dedup key).
- `chance_of_playing_next_round` / `chance_of_playing_this_round`:
  null, 0, 25, 50, 75, 100.
- `scout_risks[]`, `scout_news_link` — official Scout risk annotations.
- Price watch: `cost_change_event`, `cost_change_start`,
  `price_change_percent`, `transfers_in_event`/`transfers_out_event`.
- Form/model inputs: `ep_next` (FPL's own expected points next GW), `form`,
  `expected_goals/assists/goal_involvements/goals_conceded` (+ `_per_90`),
  `defensive_contribution`, `starts`, `minutes`, `selected_by_percent`.

Poll cadence: diff `elements[]` availability fields hourly in light mode; every
15 min from 24 h before deadline; every 5 min in the final 3 h. A diff in
(`status`, `news_added`, `chance_of_playing_next_round`) is a news event.

### Chips (from `chips[]`, verified 2026/27)

Eight chips, one of each per half-season: `wildcard`, `freehit`, `bboost`,
`3xc` for GW1–19 (wildcard from GW2) and again for GW20–38. Unused first-half
chips do **not** carry over. Read what's already used from
`/entry/{id}/history/` → `chips[]` and the GW's `active_chip` in picks.
(The 2024/25 Assistant Manager chip is gone; `element_types` are back to
GKP/DEF/MID/FWD. Scoring includes Defensive Contribution since 2025/26:
2 pts at 10 CBIT for defenders / 12 CBIRT for mids-forwards — factor it into
value comparisons for defensive players.)

## Notification policy

Severity ladder — every candidate message gets one:

- **Critical** — deadline-relevant and confirmed: starter ruled out
  (`status` → `i`/`s`/`u`), captain now `d` ≤50%, fixture postponed
  (`event` → null), deadline moved. Immediate ping, once per development.
- **High** — captain candidate doubtful 75%, strong multi-source rotation
  reporting, opponent loses key GK/CB/striker.
- **Info** — price changes, ordinary news, rank moves. Digest-only.

Modes:

- **Light (default):** digest ~24 h before deadline; final check ~3 h before
  *only if* something actionable (otherwise silence); critical alerts.
- **Standard:** + early planning note after the previous GW's `data_checked`
  turns true, + always-send final check, + high alerts.
- **Intensive:** + price-change watch (evening polls; official changes land
  ~01:30 UK), predicted-lineup/press-conference notes, deadline countdowns,
  mini-league deltas.

Digest contents: exact deadline in user TZ; squad summary from picks + prices;
flagged players (yours and notable opponents'); captain + vice suggestion with
reasoning and confidence; bench-order check (formation legality: 1 GK, ≥3 DEF,
≥1 FWD among starters); free transfers available and any suggested move with
its 4-point-hit math; chip window notes (e.g. first-half chips expiring at
GW19); fixture changes.

Never send an "all clear" unless the user opted in. Respect quiet hours except
for Critical.

## Decision support

When asked (or in a digest), assess using only cited data:

1. **Lineup/bench:** cross `picks` with availability, `ep_next`, fixture
   difficulty from `element-summary.fixtures`, and expected minutes
   (starts/minutes trend). Order bench by expected minutes × upside.
2. **Captaincy:** shortlist by `ep_next` × fixture × form; adjust for
   opponent's confirmed absences; state confidence (low/medium/high).
3. **Transfers:** compare over the next 3–5 GWs, not one; a −4 hit needs
   a clear multi-week expected-points surplus. Show bank, sell prices (from
   `transfers` purchase price + 50%-of-profit sell rule), and team value.
4. **Chips:** flag blank/double GWs (multiple or zero fixtures per team in
   `/fixtures/?event=`) as freehit/bboost candidates; warn before half-season
   expiry.

Explain in plain language with uncertainty, e.g.: "Start A over B — A's role
is safer and the opposing first-choice CB is confirmed out (official, graded
Confirmed). Confidence: medium-high."

## Evidence grading

1. **Confirmed** — FPL API `status`/`news`, club/league statements, manager
   press conference. May trigger Critical.
2. **Strong** — multiple reputable journalists or reliable specialist outlets.
   May trigger High.
3. **Probable** — credible predicted lineups, training photos. Digest-only.
4. **Speculative** — social rumour. Mention only if the user asks; never ping.

Weather: alert only on postponement/inspection risk or credible severe
 disruption (storm, flooding, snow, dangerous wind, extreme heat affecting
 minutes). Ordinary rain or cold is never an alert. A `/fixtures/` entry losing
 its `event` or `kickoff_time` is the authoritative postponement signal;
 weather forecasts are Probable at best until then.

## Scheduling

On bind and daily: fetch `events[]`, find `is_next`, and (re)schedule the
 digest (T−24 h), conditional final check (T−3 h), and pre-deadline fast-poll
 window against `deadline_time`. Reconcile schedules whenever a fetched
 deadline differs from the stored one, and say so in the next digest.
After the GW: once `data_checked` is true, re-read picks/points for the
 retrospective and the next planning note.

## Out of scope (until an official FPL OAuth + write API exists)

Automated transfers, captain/bench changes, chip activation, private-league
administration, anything requiring `/my-team/` or login. Deep-link the user to
 the official site instead.
