# ---- build stage ----
FROM node:20-slim AS build

# system deps for node-canvas
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo \
    libgif7 librsvg2-2 fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# только package* сначала — быстрее кеш
COPY package*.json ./
RUN npm ci --omit=dev

# всё остальное
COPY . .

# ---- runtime stage ----
FROM node:20-slim

# такие же системные либы в рантайме
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo \
    libgif7 librsvg2-2 fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# перенесём собранные node_modules и код
COPY --from=build /app /app

# Koyeb задаёт PORT; Express должен слушать его
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
