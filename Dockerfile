FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source and build
COPY . .
RUN npm run build

# Production image
FROM node:20-alpine

WORKDIR /app

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Create workspace directory
RUN mkdir -p /data/workspaces

# Expose port
EXPOSE 3000

# Run as non-root user
USER node

CMD ["node", "dist/index.js"]
