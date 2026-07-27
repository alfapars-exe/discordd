# mqvi React Frontend — Multi-stage Docker build
#
# Development: Vite dev server (hot reload)
# Production: Nginx ile statik dosya serve

# ─── Development Stage ───
FROM node:26-alpine AS development

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
EXPOSE 3030
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# ─── Build Stage ───
FROM node:26-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ─── Production Stage ───
FROM nginx:alpine AS production

# wget for HEALTHCHECK (curl not in nginx:alpine by default)
RUN apk add --no-cache wget

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# nginx:alpine already runs as non-root user `nginx` by default for the
# worker processes, but the master starts as root to bind privileged ports.
# Port 80 is privileged but nginx drops privileges for workers.

EXPOSE 80

# HEALTHCHECK — wget against root index; verifies nginx is serving SPA.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --spider http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
