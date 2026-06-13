FROM node:20-slim

# Install ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (cache layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

EXPOSE 3000

CMD ["node", "src/index.js"]
