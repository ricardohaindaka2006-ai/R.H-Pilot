FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY engine ./engine
COPY public ./public
COPY mt5-agent/agent.py ./mt5-agent/agent.py
ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 10000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-10000}/api/health" || exit 1
CMD ["node", "--max-old-space-size=320", "server.js"]
