# Multi-stage build for the ACTP backend (uses committed contract ABIs; no forge needed).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY backend/package.json backend/
COPY sdk/package.json sdk/
RUN npm install --no-audit --no-fund
COPY packages/core packages/core
COPY backend backend
RUN npm run build -w packages/core && npm run build -w backend

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY backend/package.json backend/
COPY sdk/package.json sdk/
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/backend/dist backend/dist
EXPOSE 8402
CMD ["node", "backend/dist/index.js"]
