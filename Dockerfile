FROM node:18-alpine AS build

# Build stage: install deps and compile TypeScript
WORKDIR /usr/src/app
COPY package.json package-lock.json* tsconfig.json ./
# Use npm install so build works even if package-lock.json is not present
RUN npm install
COPY . .
RUN npm run build

FROM node:18-alpine
WORKDIR /usr/src/app

# Install only production deps
COPY package.json package-lock.json* ./
# Use npm install --production when no lockfile is present
RUN npm install --production --no-audit --no-fund

# Copy compiled output
COPY --from=build /usr/src/app/dist ./dist

# Use a non-root user for security
RUN addgroup -S app && adduser -S app -G app
USER app

# Default command
CMD ["node", "dist/index.js"]
