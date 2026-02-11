FROM node:20-slim

WORKDIR /app

# Copy server package files first (for Docker layer caching)
COPY server/package*.json ./server/

# Install server dependencies
RUN cd server && npm ci --production

# Copy the entire game
COPY . .

# Railway sets PORT env var automatically
EXPOSE 3000

# Start the server
CMD ["node", "server/index.js"]
