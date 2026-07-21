# Must match the "playwright" version in package.json exactly (currently 1.61.1) - the browser
# binaries baked into this image are version-locked to it, so a mismatch causes
# "browserType.launch: Executable doesn't exist" at runtime. Bump both together.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
