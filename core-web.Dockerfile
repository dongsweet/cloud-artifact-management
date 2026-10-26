ARG CADDY_BASE_IMAGE=caddy:2.11.4
FROM node:24-bookworm-slim AS assets
WORKDIR /build
COPY core-web/package.json core-web/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY core-web/index.html core-web/core.js core-web/core.css ./
COPY web-shared/layout.css /build/layout.css
COPY web-shared/transfer-file-table.css /build/transfer-file-table.css
COPY web-shared/transfer-file-table.js /build/transfer-file-table.js
COPY web-shared/gate-pairing.js web-shared/gate-pairing.css web-shared/table-pagination.js web-shared/artifact-catalog.js /build/
COPY web-shared/role-permissions.js web-shared/audit-events.js web-shared/role-display.js web-shared/role-display.css /build/
COPY web-shared/aaa-config.js /build/
COPY libs/cam-auth/src/roles.js /build/cam-auth-roles.js
COPY web-shared/assets /build/shared-assets
RUN mkdir -p /out/assets/fonts && cp shared-assets/bootstrap.min.css /out/assets/ && cp shared-assets/bootstrap-icons.min.css /out/assets/ && cp shared-assets/fonts/* /out/assets/fonts/ && cp shared-assets/adminlte.min.css /out/assets/ && cp layout.css transfer-file-table.css gate-pairing.js gate-pairing.css table-pagination.js artifact-catalog.js role-permissions.js audit-events.js role-display.js role-display.css aaa-config.js cam-auth-roles.js /out/assets/ && cp index.html /out/ && cp core.js core.css transfer-file-table.js /out/assets/
FROM ${CADDY_BASE_IMAGE}
COPY core-web/Caddyfile /etc/caddy/Caddyfile
COPY --from=assets /out /srv/web
RUN addgroup -S -g 10001 cam && adduser -S -D -H -u 10001 -G cam cam && chown -R cam:cam /srv/web /data /config
USER cam
