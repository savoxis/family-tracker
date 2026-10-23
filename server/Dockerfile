# Build from the repo root:  docker build -f server/Dockerfile -t kitchen-board .
FROM node:22-alpine
WORKDIR /app
COPY server/server.js server/ics.js server/keep.js server/keepsync.js server/sms.js server/parentsquare.js ./
COPY web ./public
RUN mkdir -p /data && chown node:node /data
ENV PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server.js"]
