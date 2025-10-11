# Use Node.js 18 Alpine as base image
FROM node:18-alpine

# Install system dependencies for Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    && rm -rf /var/cache/apk/*

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    NODE_ENV=production

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies (use npm install if package-lock.json is missing)
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Copy app source
COPY . .

# Create uploads and session directories
RUN mkdir -p uploads session

# Expose port
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
