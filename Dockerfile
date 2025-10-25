FROM node:18-slim AS build

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build

FROM node:18-slim

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --omit=dev

COPY --from=build /usr/src/app/dist ./dist

EXPOSE 3000

CMD [ "node", "dist/server.js"]