ARG CADDY_BASE_IMAGE=caddy:2.11.4

FROM node:24-bookworm-slim AS assets
WORKDIR /build
COPY apps ./apps
COPY libs ./libs
COPY web-shared ./web-shared
COPY agent-web ./agent-web
RUN node agent-web/build.mjs /out

FROM ${CADDY_BASE_IMAGE}

COPY agent-web/Caddyfile /etc/caddy/Caddyfile
COPY web-shared/caddy-entrypoint.sh /usr/local/bin/cam-caddy-entrypoint
COPY --from=assets /out /srv/web

RUN addgroup -S -g 10001 cam && adduser -S -D -H -u 10001 -G cam cam \
  && setcap -r /usr/bin/caddy \
  && chmod 0755 /usr/local/bin/cam-caddy-entrypoint \
  && mkdir -p /data /config \
  && chown -R cam:cam /srv/web /data /config

USER cam
ENTRYPOINT ["/usr/local/bin/cam-caddy-entrypoint"]
