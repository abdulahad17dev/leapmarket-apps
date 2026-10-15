FROM node:22-alpine AS assets
WORKDIR /app
COPY package.json apps.json assets-lock.json ./
COPY icons/ ./icons/
COPY scripts/ ./scripts/
RUN npm run prepare:assets

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
COPY --from=assets --chown=node:node /app/public ./public
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
