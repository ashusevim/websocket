# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files and install all dependencies (including dev)
COPY package*.json ./
RUN npm ci

# Copy TypeScript config, source code and tests
# `test/` must be present: tsconfig.json has rootDir ".", so the compiler
# type-checks the whole project and fails if the test files are absent.
COPY tsconfig.json ./
COPY src ./src
COPY test ./test

# Build TypeScript
RUN npx tsc

# Production stage
FROM node:22-alpine

WORKDIR /app

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# The schema is applied at boot (see src/db.ts). It must be in the final image,
# or a fresh managed database leaves the server with no tables and every write
# fails with a 500.
COPY schema.sql ./schema.sql

# Documentation only: the server reads PORT from the environment and defaults
# to 8080. Render sets PORT=10000 and routes traffic to whatever this listens
# on, so this value is not load-bearing.
EXPOSE 8080

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

# Start the server
# Output is dist/src/index.js because tsconfig rootDir is the project root
# (so that test/ is compiled alongside src/).
CMD ["node", "dist/src/index.js"]