# Claude GitLab Agent Docker Image
# Multi-stage build for optimized production image

# Stage 1: Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy source and build TypeScript
COPY . .
RUN npm run build

# Stage 2: Production image
FROM node:20-alpine

WORKDIR /app

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Create workspace directory for cloned repositories
RUN mkdir -p /data/workspaces

# Expose application port
EXPOSE 3000

# Run as non-root user for security
USER node

# Start the application
CMD ["node", "dist/index.js"]
