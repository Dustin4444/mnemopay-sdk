# Builds from project root (not from dashboard/) so we can pull in the SDK dist.
# Invoke via: fly deploy --config dashboard/fly.toml --dockerfile dashboard/Dockerfile
# from the mnemopay-sdk repo root.

FROM node:20-slim AS sdk-build
WORKDIR /sdk
COPY package.json package-lock.json* tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm ci --ignore-scripts || npm install --ignore-scripts
RUN npm run build

FROM node:20-slim AS dashboard
WORKDIR /app
# Build tools for native modules (better-sqlite3 prebuilt fallback compilation).
# Required when npm install can't find a prebuilt binary for the current
# node-abi/platform combo and falls back to source build via node-gyp.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm install --omit=dev --no-audit --no-fund

# Replace the registry-fetched @mnemopay/sdk with our freshly-built local one.
# The published 1.5.0 has ESM-only `exports` and breaks under CJS require();
# our local build outputs CJS-compatible dist/.
RUN rm -rf node_modules/@mnemopay/sdk
COPY --from=sdk-build /sdk/package.json /app/node_modules/@mnemopay/sdk/package.json
COPY --from=sdk-build /sdk/dist /app/node_modules/@mnemopay/sdk/dist

# Strip the exports field so CJS require() works.
RUN node -e "const p='/app/node_modules/@mnemopay/sdk/package.json'; const fs=require('fs'); const j=JSON.parse(fs.readFileSync(p)); delete j.exports; fs.writeFileSync(p, JSON.stringify(j,null,2));"

COPY dashboard/ ./
EXPOSE 3200
CMD ["node", "server.js"]
