ARG CADDY_BASE_IMAGE=caddy:2.11.4
FROM ${CADDY_BASE_IMAGE}

COPY agent-web/Caddyfile /etc/caddy/Caddyfile

RUN addgroup -S -g 10001 cam && adduser -S -D -H -u 10001 -G cam cam \
  && mkdir -p /data /config \
  && chown -R cam:cam /data /config

USER cam
