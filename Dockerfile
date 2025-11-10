FROM node:20-slim

# системные либы для canvas
RUN apt-get update && apt-get install -y \
    libcairo2-dev libpango1.0-dev libjpeg62-turbo-dev libgif-dev librsvg2-dev \
    fonts-dejavu-core && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ВАЖНО: копируем реальные файлы в образ
COPY index2.js ./
COPY name.pdf ./              # <-- обязателен
COPY fonts ./fonts            # <-- обязателны ttf
COPY .dockerignore ./.dockerignore

# быстрая проверка наличия файлов прям при сборке
RUN ls -lh /app && \
    [ -s /app/name.pdf ] && head -c 5 /app/name.pdf | od -An -c

ENV PORT=8000
EXPOSE 8000
CMD ["npm", "start"]
