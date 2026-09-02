FROM node:22-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci --only=production

# 复制源码
COPY src ./src
COPY public ./public

# 创建数据目录
RUN mkdir -p data logs

EXPOSE 3000

CMD ["node", "src/server.js"]
