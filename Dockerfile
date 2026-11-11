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

# Pasta de arquivos enviados: precisa pertencer ao usuário sem privilégio que roda a API; num
# volume novo montado em /app/uploads, o Docker herda este dono.
RUN mkdir -p /app/uploads && chown -R nodeapi:nodejs /app/uploads

# Cofre de segredos (M9-D202; verificação K=7 do e-mail de campanha). Com SECRET_STORE_DRIVER=file-mounted, as chaves (descadastro
# do e-mail, links rastreados, credenciais das integrações) ficam cifradas em SECRET_STORE_DIR. O cofre recusa pasta dentro de /app,
# por isso o caminho padrão é /var/lib/nayara/cofre: criado aqui, dono uid 1001 (nodeapi), permissão 700. Monte um VOLUME PERSISTENTE
# exatamente neste caminho (volume novo herda este dono; bind mount precisa de chown 1001:1001 no host): sem volume, as chaves somem
# a cada deploy e os links de descadastro já enviados deixam de valer. Em homologação e produção o boot grava e lê um canário aqui e
# NÃO sobe se não conseguir (INTEGRATION_SECRET_STORE_UNUSABLE). Passo a passo em docs/DEPLOY_MARCO_9.md.
RUN mkdir -p /var/lib/nayara/cofre && chown -R nodeapi:nodejs /var/lib/nayara/cofre && chmod 700 /var/lib/nayara/cofre

# Leitor de documentos (Tesseract + poppler), instalado na imagem. Só é usado quando OCR_PROVIDER=local;
# sem essa variável nada muda. Para uma imagem sem eles: docker build --build-arg INSTALL_DOCUMENT_ENGINES=false.
ARG INSTALL_DOCUMENT_ENGINES=true
RUN if [ "$INSTALL_DOCUMENT_ENGINES" = "true" ]; then apk add --no-cache tesseract-ocr tesseract-ocr-data-por poppler-utils; fi

USER nodeapi
EXPOSE 3000

# Migrations não rodam automaticamente no boot (evita corrida entre réplicas) —
# rode `npm run migrate` como um passo separado de deploy antes de subir o container,
# ou via `docker exec` num container já de pé.
CMD ["node", "app.js"]
