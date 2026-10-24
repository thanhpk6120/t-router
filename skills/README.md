# T Router — Agent Skills

Drop-in skills for any AI agent (Claude, Cursor, ChatGPT, custom SDK). Use these skills to connect your AI tooling directly to T Router.

> Tip: start with the **t-router** entry skill — it covers setup and links to all capability skills.

## Skills

| Capability | Scope |
|---|---|
| **Entry / Setup** (start here) | Setup and endpoints on `http://localhost:20126` |
| Chat / code-gen | Standard `/v1/chat/completions` and `/v1/messages` |
| Image generation | Image models (FLUX, Midjourney, DALL-E) |
| Video generation | xAI Grok Imagine and video pipelines |
| Text-to-speech | STT & TTS endpoints |
| Speech-to-text | Local & cloud transcription |
| Embeddings | Vector `/v1/embeddings` |
| Web search | Live web search connectors |
| Web fetch (URL → markdown) | Web content extractor |

## Configure your shell once

```bash
export TROUTER_URL="http://localhost:20126"       # local default (port 20126)
export TROUTER_KEY="sk_trouter"                   # from Dashboard → Keys
```

Verify: `curl $TROUTER_URL/api/health` → `{"ok":true}`.
