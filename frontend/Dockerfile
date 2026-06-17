# Aquarela.io — Frontend (Vue.js + Vite)
# Multi-stage: install & build → serve static files with Nginx

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: serve ────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Copy Vite build output to Nginx's default serve directory
COPY --from=builder /app/dist /usr/share/nginx/html

# Custom Nginx config to support Vue Router's history mode
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
