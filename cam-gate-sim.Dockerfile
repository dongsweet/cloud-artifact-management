FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY tools/cam-gate-mapping-simulator.js ./cam-gate-mapping-simulator.js

RUN useradd --system --uid 10001 --create-home cam
USER cam

EXPOSE 3201 3202 3203 3204
CMD ["node", "/app/cam-gate-mapping-simulator.js"]
