---
name: delegation
description: When to hand work to a subagent (explore, review, subagent, subagent_fork) instead of doing it in this conversation, and how to write the instruction so the answer comes back small.
---

# Delegation

The cheapest context is the one that never enters this conversation. Everything you read stays in the window until the session ends and then costs a compaction; everything a child reads is discarded the moment it answers.

## Which one

| Tool | Use it for | What comes back |
|---|---|---|
| `explore` | "where is X", "how does Y work", "which files touch Z", sweeping a directory you do not know | A conclusion plus `file:line` evidence. It cannot edit and cannot run commands. |
| `review` | checking a change you just made, auditing a file for correctness | Findings with `file:line` and a concrete failure each, or "nothing wrong found". It can run tests. |
| `subagent` | a self-contained task with a clear deliverable: build a thing, fix a failing test, write a script | Whatever you asked for, plus what it changed. |
| `subagent_fork` | continuing THIS conversation in parallel, with the history you already have | The same, but it starts out knowing what you know. |

## When NOT to delegate

- You already know the file and the line. Just read it.
- The task needs the user's judgement. Ask the user.
- The result IS the conversation: writing the answer, weighing a decision, planning the next step. That is your work, not a child's.

## Writing the instruction

A child sees your prompt and nothing else. It does not know the user's goal, the constraints, or what you already ruled out.

- State the deliverable in the first sentence, and name its shape: "Answer with the file and line, nothing else", "Return at most five findings".
- Give the ground: which directory, which branch, which command reproduces the problem.
- Say what not to do when it matters: "do not edit anything", "do not install packages".
- One question per child. Two questions in one prompt come back as one muddled paragraph.

## After it answers

Trust the conclusion, verify the claim you are about to act on. A child that says the handler is at `apps/api/routes.py:88` has earned one `read` of that line, not a repeat of its whole search.
