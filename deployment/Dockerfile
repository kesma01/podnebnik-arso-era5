FROM node:24-slim AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y git && corepack enable

COPY package.json .yarnrc.yml ./
RUN yarn install

COPY . .

# Build static site
# VITE_DATASETTE_URL="" → same-origin (nginx proxies /datasette/ on the server)
# VITE_VREMENAR_URL=""  → same-origin (nginx proxies /vremenar/ on the server)
RUN VITE_DATASETTE_URL="" VITE_VREMENAR_URL="" yarn build

# ── Serve ──────────────────────────────────────────────────────────────────────

FROM nginx:1.27-alpine

COPY --from=builder /build/dist/ /usr/share/nginx/html/
COPY deployment/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
