FROM node:22-slim

# ffmpeg is required by generateVideo.js, generatetimeStamps.js, uploadVideo.js
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Persistent-friendly dirs (mount a Render disk at /app/data and /app/output if you want history to survive deploys)
RUN mkdir -p data output

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "dashboard/server.js"]
