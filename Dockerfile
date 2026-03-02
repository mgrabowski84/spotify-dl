FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libicu-dev libssl-dev ca-certificates ffmpeg \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=0

WORKDIR /app

COPY app/package.json app/package-lock.json* ./
RUN npm install --production

COPY app/ .

EXPOSE 3000

CMD ["node", "server.js"]
