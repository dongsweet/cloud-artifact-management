FROM node:24-bookworm-slim AS production

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY apps ./apps
COPY libs ./libs

RUN useradd --system --uid 10001 --create-home cam && mkdir -p /data && chown -R cam:cam /app /data
USER cam

ARG SERVICE=cam-edge
ENV SERVICE=${SERVICE}
EXPOSE 3101 3102 3103
CMD ["sh", "-c", "node apps/${SERVICE}/src/server.js"]
