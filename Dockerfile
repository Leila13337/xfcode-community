FROM node:24-slim

WORKDIR /app
COPY . .

ENV HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 4173
CMD ["node", "server.mjs"]
