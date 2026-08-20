# Production image. Node 22, non-root, listens on $PORT (default 3000).
# Live Reddit stays off unless the operator sets REDDITAPI_LIVE=1 at runtime.
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    REDDITAPI_DATABASE=/app/data/redditapi.sqlite

COPY package.json package-lock.json tsconfig.json ./
# tsx is a devDependency but is how `npm start` runs TypeScript.
RUN npm ci && npm cache clean --force

COPY src ./src
COPY public ./public
COPY fixtures ./fixtures
COPY llms.txt ./

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000

CMD ["node", "--import", "tsx", "src/server.ts"]
