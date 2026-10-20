ARG CADDY_BASE_IMAGE=caddy:2.11.4

FROM node:24-bookworm-slim AS assets
WORKDIR /build
COPY edge-web/package.json edge-web/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY edge-web/index.html edge-web/app.js edge-web/account-ui.js edge-web/app.css ./
COPY web-shared/layout.css /build/layout.css
COPY web-shared/gate-pairing.js web-shared/gate-pairing.css /build/
COPY web-shared/assets /build/shared-assets
RUN mkdir -p /out/assets/fonts \
  && cp shared-assets/bootstrap.min.css /out/assets/ \
  && cp shared-assets/adminlte.min.css /out/assets/ \
  && cp shared-assets/bootstrap-icons.min.css /out/assets/ \
  && cp shared-assets/fonts/* /out/assets/fonts/ \
  && cp layout.css gate-pairing.js gate-pairing.css /out/assets/ \
  && cp index.html /out/ \
  && cp app.js account-ui.js app.css /out/assets/

ARG CADDY_BASE_IMAGE
FROM ${CADDY_BASE_IMAGE} AS caddy-runtime

FROM caddy-runtime
COPY edge-web/Caddyfile /etc/caddy/Caddyfile
COPY --from=assets /out /srv/web
RUN addgroup -S -g 10001 cam && adduser -S -D -H -u 10001 -G cam cam \
  && chown -R cam:cam /srv/web /data /config
USER cam

