# T Router — Agent Skills

Drop-in skills for any AI agent (Claude, Cursor, ChatGPT, custom SDK). Use these skills to connect your AI tooling directly to T Router.

> Tip: start with the **t-router** entry skill — it covers setup and links to all capability skills.

## Skills

| Capability | Scope |
|---|---|
| **[Entry / Setup](9router/SKILL.md)** (start here) | Setup and endpoints on `http://localhost:20126` |
| **[Chat / code-gen](9router-chat/SKILL.md)** | Standard `/v1/chat/completions` and `/v1/messages` |
| **[Image generation](9router-image/SKILL.md)** | Image models (FLUX, Midjourney, DALL-E) |
| **[Video generation](9router-video/SKILL.md)** | xAI Grok Imagine and video pipelines |
| **[Text-to-speech](9router-tts/SKILL.md)** | STT & TTS endpoints |
| **[Speech-to-text](9router-stt/SKILL.md)** | Local & cloud transcription |
| **[Embeddings](9router-embeddings/SKILL.md)** | Vector `/v1/embeddings` |
| **[Web search](9router-web-search/SKILL.md)** | Live web search connectors |
| **[Web fetch](9router-web-fetch/SKILL.md)** | Web content extractor (URL → markdown) |

## Configure your shell once

```bash
export TROUTER_URL="http://localhost:20126"       # local default (port 20126)
export TROUTER_KEY="sk_trouter"                   # from Dashboard → Keys
```

Verify: `curl $TROUTER_URL/api/health` → `{"ok":true}`.
