# Contributing to WA Courier

Thanks for your interest in contributing!

## Scope first

WA Courier is intentionally small: **one WhatsApp session, one Node process, zero external
services**. Multi-session support, databases, UI frameworks, and plugin systems are explicitly out
of scope. If your idea adds operational complexity, please open an issue to discuss it before
writing code.

## Development setup

```bash
git clone https://github.com/thales-machado/wa-courier.git
cd wa-courier
npm install
npm start        # http://localhost:3000
npm test         # node --test, no framework
npm run lint     # Biome (lint + format check)
```

There is no build step — `src/public/*` is served as-is (vanilla HTML/CSS/JS).

## Pull requests

1. Fork and create a feature branch.
2. Keep changes focused; one concern per PR.
3. Run `npm run lint` and `npm test` before pushing — CI enforces both.
4. Use [Conventional Commits](https://www.conventionalcommits.org) for commit messages
   (`feat:`, `fix:`, `docs:`, `ci:`...).
5. Update the README if you change behavior, endpoints, or environment variables.

## Reporting bugs

Open an issue with the gateway version (image tag), relevant logs (redact JIDs/phone numbers), and
steps to reproduce. For security issues, see [SECURITY.md](SECURITY.md) — do **not** open a public
issue.
