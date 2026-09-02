# Nayara One — API (Node.js + Express + Sequelize)

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# O Easypanel baixa o repositório como arquivo (não faz "git clone"), então não existe pasta
# .git no contexto de build — não dá pra rodar "git rev-parse HEAD" aqui. Em compensação, ele
# já injeta o commit publicado sozinho via --build-arg GIT_SHA (confirmado no log de build).
# Grava isso num arquivo VERSION, que GET /health lê pra responder qual commit está no ar —
# permite confirmar o deploy sem ninguém precisar anotar/comunicar a versão manualmente.
ARG GIT_SHA=unknown
RUN echo "$GIT_SHA" > /app/VERSION

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
