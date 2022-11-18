FROM node:16 as builder
WORKDIR /app
RUN npm install -g protobufjs-cli
COPY package.json package-lock.json /app/
COPY proto /app/proto
COPY src/services/admin/react-admin/package.json src/services/admin/react-admin/package.json
RUN npm run proto
RUN npm install
COPY . .
RUN npm run build

FROM node:16
WORKDIR /app
COPY package.json /app/
COPY proto /app/proto
COPY migrations /app/migrations
COPY scripts /app/scripts
RUN npm install
COPY --from=builder /app/dist /app/dist
CMD ["npm", "start"] 
