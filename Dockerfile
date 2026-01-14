FROM node:18-alpine AS build

# Build stage: install deps and compile TypeScript
WORKDIR /usr/src/app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:18-alpine
WORKDIR /usr/src/app

# Install only production deps
COPY package.json package-lock.json* ./
RUN npm ci --production --no-audit --no-fund

# Copy compiled output
COPY --from=build /usr/src/app/dist ./dist

# Use a non-root user for security
RUN addgroup -S app && adduser -S app -G app
USER app

# Default command
CMD ["node", "dist/index.js"]
