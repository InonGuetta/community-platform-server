# community-platform-server

## Running

```bash
npm run migrate        # apply db/migrations — required after pulling schema changes
npm run seed           # create the first admin (needs SEED_ADMIN_PASSWORD)
npm start              # API server
npm run workers        # transcription + LLM workers (separate processes)
```

Copy `.env.example` to `.env` first. The server validates its environment at
boot and refuses to start with a single message listing everything that is
missing, so a bad `.env` fails immediately instead of at the first request.

## Summarising documents

Audio and video go through Whisper; documents (`media_type='text'` — PDF, DOCX,
TXT) skip transcription and go straight to the LLM worker, which extracts the
text itself and then follows the identical summary path.

Before summarising a real book, check what extraction actually produced:

```bash
npm run extract:preview -- "C:/path/to/book.pdf"
```

No database, no Redis, no OpenAI, no cost. It prints the word/chunk counts, an
estimate of how many LLM calls a real run would make, and the text itself. This
exists because Hebrew in a PDF can come out with the letters reversed or a
commentary column woven through the main text — and none of that is visible from
a summary that reads plausibly. **Read the output before paying for a run.**

A scanned PDF (images, no text layer) is detected and rejected with an
explanation rather than summarised into confident nonsense. OCR is not supported.
Legacy `.doc` is refused too — re-save as `.docx`.

Unlike transcription, a document is never queued automatically: the reconcile
sweep deliberately ignores text media, so summarising a book always takes an
explicit press of "הפק סיכום".

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

## Media storage

Without S3 credentials, uploads are written to `uploads/` on the server's own
disk. That works, but it means the media — the one thing here that cannot be
regenerated, unlike a transcript — lives on a single machine with no backup.

Storage is recorded per row, as a `local/` or `uploads/` prefix on `s3_key`, so
**configuring S3 only affects new uploads**. Anything already stored locally
stays there until it is moved:

```bash
npm run migrate:uploads-to-s3 -- --dry            # preview
npm run migrate:uploads-to-s3                     # copy, keep local copies
npm run migrate:uploads-to-s3 -- --delete-local   # copy, then remove them
```

Safe to re-run; each file is committed separately, so an interrupted run
resumes.

### What to create in AWS

1. A bucket. **Keep it private** — the app streams objects through its own
   authenticated routes, so nothing needs public access.
2. An IAM user whose policy covers the bucket's objects. Multipart permissions
   are needed because large uploads stream in parts:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"
    ],
    "Resource": "arn:aws:s3:::YOUR_BUCKET/*"
  }]
}
```

3. Fill in `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY`. The server logs which mode it is in at startup.

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
