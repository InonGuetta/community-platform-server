# community-platform-server

## Running

```bash
npm start              # API server
npm run workers        # transcription + LLM workers (separate processes)
```

Copy `.env.example` to `.env` first. The server validates its environment at
boot and refuses to start with a single message listing everything that is
missing, so a bad `.env` fails immediately instead of at the first request.

## Tests and linting

```bash
npm test
npm run lint
```

Plain `node --test`, no dependencies. They need no database, Redis or network:
the pool and client objects are stubbed per test, and `test/setup.js` sets
placeholder credentials so a run can never reach live infrastructure.

They cover the failures that are silent rather than loud — input that used to
reach Postgres as a 500, the guard that stops the last admin being removed,
byte-range parsing for media seeking, and the webhook's decision about when
Stripe should retry.

## Running under a supervisor

The server shuts down gracefully on `SIGTERM` / `SIGINT`: it stops accepting new
connections, drains the open ones, closes the websockets and releases the DB
pool, with a 10s forced-exit backstop. Any process manager therefore gets a
clean restart.

`EXIT_ON_UNCAUGHT` (default `false`) controls what happens after an
`uncaughtException`. The process state is undefined at that point, so the
correct response is to exit and let a supervisor start a clean process — but
that is only an improvement if something actually restarts it. **Turn it on only
once the server runs under a supervisor with a restart backoff**, otherwise a
single stray error takes the API down until someone notices.

A restart backoff matters: without one, a crash on startup (a bad migration, an
unreachable database) turns into a restart loop that hammers the DB.

```bash
# pm2
pm2 start server.js --name api --exp-backoff-restart-delay=1000 --max-restarts=10

# systemd (unit file)
Restart=always
RestartSec=5s
StartLimitBurst=10

# docker-compose
restart: unless-stopped
```

Then set `EXIT_ON_UNCAUGHT=true` in `.env`.
