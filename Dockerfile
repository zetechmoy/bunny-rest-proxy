FROM node:16.13.1@sha256:085b1865ac9604641514610a340c6490b4c641b7370b00a75686f5bff8971688 AS builder

WORKDIR /app
RUN mkdir /app/src

COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src

RUN npm install
RUN npm run build

FROM node:16.13.1@sha256:085b1865ac9604641514610a340c6490b4c641b7370b00a75686f5bff8971688

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./

RUN mkdir -p /app/node_modules && chown -R node:node /app

USER node
RUN npm install --production

COPY --from=builder /app/build /app/build

EXPOSE 3672
CMD [ "node", "build/index.js" ]