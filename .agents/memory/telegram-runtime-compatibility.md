---
name: Telegram and Supabase runtime compatibility
description: Compatibility constraints for this bot's Node.js Telegram and Supabase dependencies.
---

The installed `node-telegram-bot-api` 2.x line uses a `Bot` middleware API rather than the older `TelegramBot(token, { polling: true })` event-emitter interface. The old 0.66.x package was blocked by Replit's package firewall due to a critical vulnerability in its transitive dependencies; do not bypass the firewall to restore the legacy client.

**Why:** The imported bot code targets the older Telegram API, but its declared dependency resolves to 2.x. Supabase's current Realtime client also requires an explicit WebSocket transport under Node.js 20, even when the app does not use Realtime features.

**How to apply:** Keep the project on the modern Telegram API and the Replit-approved dependencies. For Supabase on Node.js 20, install `ws` and pass it as the Realtime transport. Confirm the app starts and loads accounts before live testing.
