---
name: token-economy
description: How to work cheaply on DeepSeek: peak vs off-peak pricing, the peak-guard budget, prefix-cache-friendly habits, when to delegate to subagents to keep the main context small.
---

# Token economy

## Pricing facts (DeepSeek API)
- Peak hours: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday, excluding Chinese public holidays. Off-peak is half price on every model.
- Cache-hit input is ~20–30× cheaper than cache-miss input; output is ~3× the price of input. So: keep the prefix stable (do not reorder or rewrite earlier context), and keep outputs terse.
- The system prompt carries a live line "Usage budget guard: … PEAK/off-peak … rolling usage X/Y". When it says you are near the budget, act on it; over budget the next request is declined until the window drains. `/peak` shows the status to the user.

## Habits that save tokens
- Read file ranges, not whole files; search with ripgrep before reading.
- Batch independent tool calls into one step.
- Do not re-read a file you just wrote; do not print large command outputs — pipe through `head`/`tail`/`grep`.
- Delegate long, output-heavy investigations to `subagent` (or `subagent_fork` when it needs the current context): the parent receives only the final answer, so the main context stays small and the summary survives compaction. Watch them in the sidebar; use `send_message` to steer, `list_agents` to see who is alive.
- Prefer one comprehensive answer over many short turns when the user is waiting; prefer short status lines when a long tool job is running.
- Heavy or non-urgent batches: propose to run them off-peak (after 10:00 UTC on weekdays, or on the weekend) via `schedule_create`.
