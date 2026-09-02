# 部署指南

## 方案一：云服务器部署（推荐）

适用于阿里云、腾讯云、AWS EC2 等 VPS。

### 1. 服务器准备

```bash
# SSH 连接到服务器
ssh root@your-server-ip

# 安装 Node.js 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 PM2（进程管理）
npm install -g pm2

# 安装 Nginx（反向代理）
sudo apt-get install -y nginx
```

### 2. 上传代码

```bash
# 方法 A: 使用 Git
cd /var/www
git clone <your-repo-url> texas-holdem
cd texas-holdem
npm install

# 方法 B: 使用 SCP
# 在本地执行：
scp -r ./德州扑克 root@your-server-ip:/var/www/texas-holdem
# 然后在服务器：
cd /var/www/texas-holdem
npm install
```

### 3. 配置 Nginx

创建 `/etc/nginx/sites-available/texas-holdem`:

```nginx
server {
    listen 80;
    server_name your-domain.com;  # 替换为你的域名

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        
        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # 超时设置
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
    }
}
```

启用配置：

```bash
sudo ln -s /etc/nginx/sites-available/texas-holdem /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 4. 启动应用

```bash
cd /var/www/texas-holdem
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # 开机自启
```

### 5. 配置 HTTPS（可选但推荐）

```bash
# 安装 Certbot
sudo apt-get install -y certbot python3-certbot-nginx

# 获取证书
sudo certbot --nginx -d your-domain.com

# Certbot 会自动修改 Nginx 配置添加 HTTPS
```

### 6. 防火墙设置

```bash
# 允许 HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

---

## 方案二：Railway 部署（最简单）

Railway 提供免费额度，自动处理 HTTPS。

### 1. 准备工作

访问 [railway.app](https://railway.app)，注册账号。

### 2. 部署步骤

方式 A - 使用 Railway CLI：

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

方式 B - 通过 GitHub：

1. 将代码推送到 GitHub
2. 在 Railway 仪表板点击 "New Project"
3. 选择 "Deploy from GitHub repo"
4. 选择你的仓库
5. Railway 会自动检测并部署

### 3. 添加持久化存储

在 Railway 项目设置中：
1. 点击 "Volumes"
2. 添加 volume：挂载路径 `/app/data`
3. 重新部署

---

## 方案三：Render 部署

Render 也提供免费额度和自动 HTTPS。

### 1. 创建 Web Service

访问 [render.com](https://render.com)，注册后：

1. 点击 "New +" → "Web Service"
2. 连接你的 GitHub 仓库
3. 配置：
   - **Name**: texas-holdem
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free

### 2. 添加磁盘存储

在 Service 设置中：
1. 滚动到 "Disks"
2. 添加 disk：
   - **Name**: data
   - **Mount Path**: `/app/data`
   - **Size**: 1GB

---

## 方案四：Docker 部署

适用于任何支持 Docker 的平台。

### 1. 构建镜像

```bash
docker build -t texas-holdem .
```

### 2. 运行容器

```bash
docker run -d \
  --name texas-holdem \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  texas-holdem
```

### 3. 使用 Docker Compose（推荐）

创建 `docker-compose.yml` 后运行：

```bash
docker-compose up -d
```

---

## 常见问题

### WebSocket 连接失败

**问题**: 浏览器显示 WebSocket 连接错误。

**解决**:
- 确保 Nginx 配置了 `Upgrade` 和 `Connection` 头
- 检查防火墙是否允许 WebSocket 端口
- 如果使用 HTTPS，确保 WebSocket 也使用 WSS

### 数据丢失

**问题**: 重启后房间数据消失。

**解决**:
- 检查 `data/` 目录是否有写权限
- 使用 Docker volume 或 Railway/Render 的持久化存储
- 确认 SQLite 文件路径正确

### 性能问题

**问题**: 多人游戏时卡顿。

**优化建议**:
- 升级服务器配置（至少 1GB RAM）
- 使用 PM2 cluster 模式（需要改造 Socket.IO 使用 Redis adapter）
- 添加 CDN 加速静态资源

### 域名访问

**问题**: 只能通过 IP 访问。

**解决**:
1. 购买域名（阿里云、腾讯云、GoDaddy 等）
2. 添加 A 记录指向服务器 IP
3. 等待 DNS 生效（几分钟到 24 小时）
4. 配置 Nginx server_name 为你的域名
5. 使用 Certbot 配置 HTTPS

---

## 监控和维护

### PM2 常用命令

```bash
pm2 list              # 查看进程状态
pm2 logs texas-holdem # 查看日志
pm2 restart texas-holdem  # 重启
pm2 stop texas-holdem     # 停止
pm2 monit             # 实时监控
```

### 日志查看

```bash
# PM2 日志
pm2 logs texas-holdem --lines 100

# Nginx 日志
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# 应用日志
tail -f logs/out.log
tail -f logs/err.log
```

### 数据备份

```bash
# 定时备份数据库
crontab -e

# 添加：每天凌晨 2 点备份
0 2 * * * cp /var/www/texas-holdem/data/poker.sqlite /backups/poker-$(date +\%Y\%m\%d).sqlite
```

---

## 推荐配置

**个人项目/小规模**:
- Railway 或 Render 免费版
- 自动 HTTPS，无需维护服务器

**商业项目/大规模**:
- 阿里云/腾讯云 2核4G 服务器
- Nginx + PM2 + HTTPS
- 定期数据备份

**开发测试**:
- 本地 Docker
- 使用 ngrok 临时公网访问：`ngrok http 3000`
