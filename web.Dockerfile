FROM node:24-bookworm-slim AS assets
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY web/index.html web/app.js web/app.css ./
RUN mkdir -p /out/assets/fonts \
  && cp node_modules/bootstrap/dist/css/bootstrap.min.css /out/assets/ \
  && cp node_modules/bootstrap/dist/js/bootstrap.bundle.min.js /out/assets/ \
  && cp node_modules/admin-lte/dist/css/adminlte.min.css /out/assets/ \
  && cp node_modules/admin-lte/dist/js/adminlte.min.js /out/assets/ \
  && cp node_modules/bootstrap-icons/font/bootstrap-icons.min.css /out/assets/ \
  && cp node_modules/bootstrap-icons/font/fonts/* /out/assets/fonts/ \
  && cp index.html /out/ \
  && cp app.js app.css /out/assets/

FROM caddy:2-builder AS caddy-builder
RUN xcaddy build --with github.com/caddy-dns/alidns

FROM caddy:2.11.4
COPY --from=caddy-builder /usr/bin/caddy /usr/bin/caddy
COPY web/Caddyfile /etc/caddy/Caddyfile
COPY --from=assets /out /srv/web
RUN addgroup --system --gid 10001 cam && adduser --system --uid 10001 --ingroup cam cam \
  && chown -R cam:cam /srv/web /data /config
USER cam

