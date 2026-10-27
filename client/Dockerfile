# mqvi React Frontend — Multi-stage Docker build
#
# Development: Vite dev server (hot reload)
# Production: Nginx ile statik dosya serve

# ─── Development Stage ───
FROM node:26-alpine AS development

WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
COPY electron/voice-overlay-contract.ts /app/electron/voice-overlay-contract.ts
COPY electron/overlay-media-contract.ts /app/electron/overlay-media-contract.ts
COPY electron/cs2-join-contract.ts /app/electron/cs2-join-contract.ts
COPY package.json /app/package.json
EXPOSE 3030
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# ─── Build Stage ───
FROM node:26-alpine AS build

WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
COPY electron/voice-overlay-contract.ts /app/electron/voice-overlay-contract.ts
COPY electron/overlay-media-contract.ts /app/electron/overlay-media-contract.ts
COPY electron/cs2-join-contract.ts /app/electron/cs2-join-contract.ts
COPY package.json /app/package.json
RUN npm run build

# ─── Nginx Runtime Stage ───
# Kept independent of the frontend build so the nginx config and entrypoint
# can be validated without compiling the app. Production inherits this exact
# runtime stage and then replaces the placeholder index with the Vite output.
FROM nginx:alpine AS nginx-runtime

# wget for HEALTHCHECK (curl not in nginx:alpine by default). The official
# image's default config is removed because envsubst creates our config in a
# dedicated writable runtime directory, included by nginx.conf.
RUN apk add --no-cache wget \
    && rm /etc/nginx/conf.d/default.conf \
    && mkdir -p /tmp/nginx-conf \
    && chown nginx:nginx /tmp/nginx-conf /var/cache/nginx \
    && sed -i -e '/^user[[:space:]]/d' -e 's#^pid[[:space:]].*/run/nginx.pid;#pid /tmp/nginx.pid;#' -e 's#/etc/nginx/conf.d/\*\.conf;#/tmp/nginx-conf/*.conf;#' /etc/nginx/nginx.conf \
    && grep -q '^pid /tmp/nginx.pid;' /etc/nginx/nginx.conf \
    && grep -Fq 'include /tmp/nginx-conf/*.conf;' /etc/nginx/nginx.conf

# Placeholder only for the nginx-runtime validation target.
COPY client/index.html /usr/share/nginx/html/index.html
COPY client/nginx.conf /etc/nginx/templates/default.conf.template
COPY --chmod=755 client/scripts/validate-livekit-csp-origin.sh /docker-entrypoint.d/15-validate-livekit-csp-origin.sh

# Only the trusted, operator-supplied CSP origin may be expanded in the
# template. Nginx variables such as $host and $scheme remain untouched.
ENV NGINX_ENVSUBST_FILTER="^LIVEKIT_CSP_WS_ORIGIN$" \
    NGINX_ENVSUBST_OUTPUT_DIR="/tmp/nginx-conf" \
    LIVEKIT_CSP_WS_ORIGIN=""

EXPOSE 80

# HEALTHCHECK — wget against the unchanged HTTP port; verifies the SPA.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --spider http://localhost:80/ || exit 1

USER nginx

# nginx runs as `nginx`; Docker's default CAP_NET_BIND_SERVICE allows this
# unprivileged process to preserve the existing container port 80 contract.
CMD ["nginx", "-g", "daemon off;"]

# ─── Production Stage ───
FROM nginx-runtime AS production
COPY --from=build /app/client/dist /usr/share/nginx/html

# nginx master and workers run as the unprivileged `nginx` user.
