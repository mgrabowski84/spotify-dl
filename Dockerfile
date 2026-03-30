FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 make g++ flac \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY app/package.json app/package-lock.json* ./
RUN npm install --omit=dev

COPY app/ .

EXPOSE 3000

CMD ["node", "server.js"]
