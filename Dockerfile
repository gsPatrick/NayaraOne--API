# Nayara One — API (Node.js + Express + Sequelize)

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nodeapi

COPY --from=deps /app/node_modules ./node_modules
COPY . .

USER nodeapi
EXPOSE 3000

# Migrations não rodam automaticamente no boot (evita corrida entre réplicas) —
# rode `npm run migrate` como um passo separado de deploy antes de subir o container,
# ou via `docker exec` num container já de pé.
CMD ["node", "app.js"]
