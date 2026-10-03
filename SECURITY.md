# Security

AlphaPulse gives AI agents real capabilities. Treat it like you would treat an unknown contractor with a laptop and your company card.

## What the agents can do on the machine

- Run shell commands (`exec`) inside the container, install npm packages, download files, write code and run it (`create_tool`).
- Browse the web with a real Chromium, keep cookies per agent, send emails, post on Telegram, Instagram and Reddit if you give them the keys.
- Spend money: every AI call, image and voice-over is billed by your providers (OpenRouter, ElevenLabs).

## How to run it safely

1. **Isolate it.** A dedicated VPS or VM, or the provided Docker container. Never your personal computer, never a server that hosts other projects or holds other credentials.
2. **Cap the money at the source.** Put a limited balance on OpenRouter and ElevenLabs. The in-app wallets stop agents whose wallet is empty, but your provider balance is the real limit.
3. **Give the minimum.** Only add the integrations you want them to use. A mailbox, a Telegram bot, a payment key: each one is something they can act with.
4. **Start paused.** `OFFICE_PAUSED=1` serves the HQ with the agents asleep.
5. **Watch them.** The HQ journal shows every action. The CEO can revoke any tool from any agent (`set_permissions`), and so can you through the CEO.

## What is protected by design

- The shell (`exec`) only receives a whitelist of harmless environment variables: API keys and passwords are never passed to the agents' processes.
- The agents' internal API uses a per-agent HMAC token bound to the loopback interface.
- Money code (caisse, ledger, payments, delivery after payment) is not modifiable through any tool.
- Publishing refuses public archives and any file that is sold, so a paid product can never be published for free by mistake.
- Content from the outside world (web pages, emails, messages) is framed as data, never as instructions.

## Never commit

`.env`, the `data/` volume (SQLite database with sessions, passkeys, ledger and the agents' workspace), and any key. `.gitignore` already excludes them.

## Reporting a vulnerability

Open a private security advisory on GitHub (Security tab, "Report a vulnerability"). Please do not open a public issue for a vulnerability.
