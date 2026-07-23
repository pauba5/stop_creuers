FROM ghcr.io/puppeteer/puppeteer:latest

USER root

RUN apt-get update && apt-get install -y \
    ghostscript \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

CMD ["npm", "start"]
