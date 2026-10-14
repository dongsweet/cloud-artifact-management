ARG CADDY_BASE_IMAGE=caddy:2.11.4
FROM node:24-bookworm-slim AS assets
WORKDIR /build
COPY core-web/package.json core-web/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY core-web/index.html core-web/core.js core-web/core.css ./
RUN mkdir -p /out/assets && cp node_modules/bootstrap/dist/css/bootstrap.min.css /out/assets/ && cp node_modules/bootstrap-icons/font/bootstrap-icons.min.css /out/assets/ && cp node_modules/bootstrap-icons/font/fonts/* /out/assets/ && cp node_modules/admin-lte/dist/css/adminlte.min.css /out/assets/ && cp index.html /out/ && cp core.js core.css /out/assets/
FROM ${CADDY_BASE_IMAGE}
COPY core-web/Caddyfile /etc/caddy/Caddyfile
COPY --from=assets /out /srv/web
RUN addgroup -S -g 10001 cam && adduser -S -D -H -u 10001 -G cam cam && chown -R cam:cam /srv/web /data /config
USER cam
