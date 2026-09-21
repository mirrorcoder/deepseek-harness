---
name: image-generation
description: How to produce pictures with the generate_image tool (native image model via the Codex gateway): prompt craft, sizes, where files land, batching and cost.
---

# Image generation

Use the `generate_image` tool whenever the user wants a picture: illustration, banner, background, icon, mockup, avatar, product shot, meme base.

## How it works
- The tool calls a host gateway that drives the native image model through a ChatGPT/Codex subscription session. No API key is involved; one image takes 40–90 s. The gateway processes one job at a time, so do not fire several calls in parallel — ask for `count: 2..4` in one call when variants are wanted.
- Output: square PNG (~1024–1254 px). Files are written to `generated-images/` under the workspace root and are also shown inline in the chat.

## Prompt craft
- Write in English. Structure: subject → style/medium → composition/camera → lighting → palette/mood → negative constraints.
- Never ask for text, letters, digits, logos or watermarks inside the image; rendered text is unreliable. If the user needs text on the picture, generate the background and tell them text should be overlaid in an editor or HTML.
- For consistency across a series, reuse the same style sentence verbatim and only change the subject.
- Formats other than square (1080×1080, 1280×720, 1080×1920): generate square, then explain that cropping/extension is needed, or produce the composition with the key subject centred so a crop works.

## After generating
- Report the file path(s) and one line on what was drawn. Offer one concrete iteration (different palette / angle / style), not a menu.
- If the tool returns "returned text only", the image model declined the request — rephrase to be more concrete and less sensitive, then retry once.
