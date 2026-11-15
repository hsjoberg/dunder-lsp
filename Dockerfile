FROM node:24-bookworm AS builder
WORKDIR /app
ENV PATH="/app/node_modules/.bin:${PATH}"
COPY package.json package-lock.json /app/
COPY proto /app/proto
RUN npm ci
RUN npm run proto
COPY . .
RUN cd src/services/admin/react-admin && npm install --legacy-peer-deps
RUN npm run build
# Keep only runtime dependencies (built for this platform) for the final image.
RUN npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json /app/
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/dist /app/dist
COPY proto /app/proto
COPY migrations /app/migrations
COPY scripts /app/scripts
# The sqlite database (./database.db) is written to /app.
RUN chown node:node /app
USER node
CMD ["node", "--max-http-header-size=32768", "dist/server.js"]
