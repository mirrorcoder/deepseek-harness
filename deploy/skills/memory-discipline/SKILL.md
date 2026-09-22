---
name: memory-discipline
description: What to put in `remember` so future sessions start smarter, what to keep out of it, and how compaction, recall and memory divide the work.
---

# Memory discipline

Three mechanisms keep knowledge alive, at three different time scales. Using the wrong one is how a fact gets lost or how a prompt gets bloated.

| Horizon | Mechanism | What belongs there |
|---|---|---|
| This turn | the conversation | everything in flight |
| This session | compaction checkpoints | the state of the work: what is done, what broke, what is next |
| Before this session | `session_event_search` / `session_event_read` | any detail a checkpoint dropped; the raw log is still on disk |
| Every future session | `remember` | facts that will still be true tomorrow |

## What is worth remembering

- Ground truth about the machine: where a service actually lives, which port, which container, which path is the real one when two look plausible.
- The command that really works, especially when the obvious one does not.
- A decision the user made, with the reason. "Owner chose X over Y because Z" saves re-litigating it.
- A trap that cost time: the inode that breaks a bind mount, the flag that silently does nothing, the test that needs a specific timezone.
- Conventions the user keeps correcting you on.

## What must stay out

- Anything the repository already says. A file the next session can read is not memory, it is a file.
- Secrets. Note WHERE a credential lives, never its value.
- Anything true only inside this conversation: what you are doing right now, a temporary path, the state of a run.
- Speculation. A remembered guess is worse than no memory, because the next session will trust it.

## How to write one

- One fact per note, named for the fact: `deploy-command`, `prod-host`, `pytest-import-mode`.
- Say the why when it is not obvious from the what.
- Correct an old note by re-using its name; the write overwrites it. Delete with `forget` when a fact expires.
- Notes load at session start, so what you write now is visible from the next session on. You already have this one in front of you.

## Before you say "I do not know"

If the detail is from earlier in THIS session, it is in the log: search it. If it is from earlier work, it may be in memory already, which means it is in your system prompt. Neither costs the user a repeated explanation.
