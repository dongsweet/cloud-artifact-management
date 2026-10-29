ARG CADDY_BASE_IMAGE=caddy:2.11.4

FROM node:24-bookworm-slim AS assets
WORKDIR /build
COPY edge-web/package.json edge-web/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY edge-web/index.html edge-web/app.js edge-web/account-ui.js edge-web/app.css ./
COPY web-shared/layout.css /build/layout.css
COPY web-shared/gate-pairing.js web-shared/gate-pairing.css web-shared/table-pagination.js /build/
COPY web-shared/role-permissions.js web-shared/audit-events.js web-shared/role-display.js web-shared/role-display.css /build/
COPY web-shared/download-grant-ui.js /build/download-grant-ui.js
COPY web-shared/task-state.js /build/task-state.js
COPY libs/cam-auth/src/roles.js /build/cam-auth-roles.js
COPY web-shared/assets /build/shared-assets
RUN mkdir -p /out/assets/fonts \
  && cp shared-assets/bootstrap.min.css /out/assets/ \
  && cp shared-assets/adminlte.min.css /out/assets/ \
  && cp shared-assets/bootstrap-icons.min.css /out/assets/ \
  && cp node_modules/bootstrap/dist/js/bootstrap.bundle.min.js node_modules/admin-lte/dist/js/adminlte.min.js /out/assets/ \
  && cp shared-assets/fonts/* /out/assets/fonts/ \
  && cp layout.css gate-pairing.js gate-pairing.css table-pagination.js role-permissions.js audit-events.js role-display.js role-display.css cam-auth-roles.js download-grant-ui.js task-state.js /out/assets/ \
  && cp index.html /out/ \
  && cp app.js account-ui.js app.css /out/assets/

ARG CADDY_BASE_IMAGE
FROM ${CADDY_BASE_IMAGE} AS caddy-runtime

FROM caddy-runtime
COPY edge-web/Caddyfile /etc/caddy/Caddyfile
COPY web-shared/caddy-entrypoint.sh /usr/local/bin/cam-caddy-entrypoint
COPY --from=assets /out /srv/web
RUN addgroup -S -g 10001 cam && adduser -S -D -H -u 10001 -G cam cam \
  && setcap -r /usr/bin/caddy \
  && chmod 0755 /usr/local/bin/cam-caddy-entrypoint \
  && chown -R cam:cam /srv/web /data /config
USER cam
ENTRYPOINT ["/usr/local/bin/cam-caddy-entrypoint"]

