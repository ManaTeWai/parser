FROM node:24-slim

WORKDIR /parsers

# jq нужен для валидации JSON
RUN apt-get update && apt-get install -y jq curl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["bash", "/parsers/run_parsers.sh"]