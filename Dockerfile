FROM node:18 as builder
WORKDIR /app
COPY package.json package-lock.json /app/
COPY proto /app/proto
COPY src/services/admin/react-admin/package.json src/services/admin/react-admin/package.json
RUN export PATH="/app/node_modules/.bin:${PATH}"
RUN npm install
RUN npm run proto
COPY . .
RUN cd src/services/admin/react-admin && npm install --legacy-peer-deps
RUN cd /app && npm run build

FROM node:18
WORKDIR /app
COPY package.json /app/
COPY proto /app/proto
COPY migrations /app/migrations
COPY scripts /app/scripts
RUN npm install
COPY --from=builder /app/dist /app/dist
CMD ["npm", "start"]
