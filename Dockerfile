# AI Agent Governance Dashboard — self-contained image.
# No external npm dependencies: the app uses only Node built-ins
# (http, node:sqlite, node:crypto), so the build is tiny and fast.
FROM node:22-alpine

WORKDIR /app

# Install (there are no runtime deps; this just honours the lockfile).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV PORT=4175 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/governance.db

EXPOSE 4175

# The SQLite database lives here — mount a volume to persist it.
VOLUME ["/app/data"]

CMD ["npm", "start"]
