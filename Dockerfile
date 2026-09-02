# Nayara One — API (Node.js + Express + Sequelize)

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Estágio isolado só para capturar o commit de verdade que o build está usando — permite que
# GET /health responda com a versão realmente publicada, para confirmar deploy sem depender do
# operador lembrar de atualizar nada manualmente. O .git em si NUNCA é copiado para o estágio
# final (runner): só o arquivo texto gerado aqui (VERSION) atravessa.
FROM node:20-alpine AS version
WORKDIR /app
RUN apk add --no-cache git
COPY .git ./.git
RUN git rev-parse HEAD > /VERSION || echo "unknown" > /VERSION

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nodeapi

COPY --from=deps /app/node_modules ./node_modules
COPY --from=version /VERSION ./VERSION
COPY . .
# .git só existe no contexto de build para o estágio "version" conseguir o commit real —
# nunca deve ir para a imagem final (tamanho e histórico do repo não pertencem à imagem rodando).
RUN rm -rf .git

USER nodeapi
EXPOSE 3000

# Migrations não rodam automaticamente no boot (evita corrida entre réplicas) —
# rode `npm run migrate` como um passo separado de deploy antes de subir o container,
# ou via `docker exec` num container já de pé.
CMD ["node", "app.js"]
