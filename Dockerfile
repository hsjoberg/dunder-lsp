FROM node:16 as builder
WORKDIR /app
COPY package.json package-lock.json /app/
COPY proto /app/proto
COPY src/services/admin/react-admin/package.json src/services/admin/react-admin/package.json
RUN export PATH="/app/node_modules/.bin:${PATH}"
RUN npm install
RUN npm run proto
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
