FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package.json package-lock.json* ./
RUN npm install --production --no-audit --no-fund

# Bundle app source
COPY . .

# Use a non-root user for security
RUN addgroup -S app && adduser -S app -G app
USER app

# Default command
CMD ["node", "index.js"]
