# ---- build stage ----
FROM node:20-slim AS build

# system deps for node-canvas
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo \
    libgif7 librsvg2-2 fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) зависимости по package*.json — для кеша
COPY package*.json ./
RUN npm ci --omit=dev

# 2) копируем только то, что реально нужно рантайму
#    если файл называется index_fast.js — замени строку
COPY index2.js ./index2.js
COPY name.pdf ./name.pdf
COPY fonts ./fonts

# ---- runtime stage ----
FROM node:20-slim

# те же системные либы для node-canvas в рантайме
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo \
    libgif7 librsvg2-2 fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# создаём непривилегированного пользователя
RUN useradd -m -u 10001 nodeuser

# переносим собранное из build-слоя
COPY --from=build /app /app
RUN chown -R nodeuser:nodeuser /app
USER nodeuser

# Koyeb задаёт PORT => твой index2.js уже читает process.env.PORT
EXPOSE 3000
ENV PORT=3000

# "start" в package.json должен запускать index2.js (node index2.js)
CMD ["npm", "start"]
