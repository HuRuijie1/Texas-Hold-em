# 📖 文档导航

欢迎！这里是德州扑克项目的文档中心。

## 🎯 快速导航

### 我想快速部署
→ **[部署方案速查表.md](./部署方案速查表.md)** - 一图看懂所有方案  
→ **[快速部署.md](./快速部署.md)** - 详细操作步骤

### 我是第一次部署
→ **[部署检查清单.md](./部署检查清单.md)** - 跟着清单一步步来  
→ **[部署指南总览.md](./部署指南总览.md)** - 全面了解所有选项

### 我需要完整技术文档
→ **[DEPLOYMENT.md](./DEPLOYMENT.md)** - Nginx、HTTPS、监控等高级配置  
→ **[CLAUDE.md](./CLAUDE.md)** - 项目架构和开发指南

### 我想了解项目本身
→ **[README.md](./README.md)** - 项目说明和使用方法

---

## 📚 文档列表

| 文档 | 用途 | 适合人群 |
|-----|------|---------|
| **部署方案速查表.md** | 可视化对比所有部署方案 | 所有人 |
| **快速部署.md** | 各方案的详细操作步骤 | 新手 |
| **部署检查清单.md** | 部署前的完整检查项 | 新手 |
| **部署指南总览.md** | 方案对比和选择建议 | 所有人 |
| **DEPLOYMENT.md** | 完整技术部署文档 | 有经验的开发者 |
| **CLAUDE.md** | 项目架构和开发指南 | 开发者 |
| **README.md** | 项目说明和使用方法 | 所有人 |

---

## 🚀 推荐阅读顺序

### 新手路线
1. **部署方案速查表.md** - 了解有哪些选项
2. **快速部署.md** - 选择一个方案，跟着做
3. **部署检查清单.md** - 部署前检查一遍
4. **README.md** - 了解如何使用

### 开发者路线
1. **CLAUDE.md** - 了解项目架构
2. **部署指南总览.md** - 选择适合的部署方案
3. **DEPLOYMENT.md** - 深入了解技术细节
4. **README.md** - 项目使用说明

---

## 💡 常见场景快速跳转

- **我想最快让朋友玩上** → [快速部署.md - ngrok 部分](./快速部署.md#方法-1-ngrok推荐)
- **我想长期运营** → [部署指南总览.md - Railway 部分](./部署指南总览.md#2️⃣-railway推荐适合长期使用)
- **我有云服务器** → [DEPLOYMENT.md - 云服务器部分](./DEPLOYMENT.md#方案一云服务器部署推荐)
- **我想用 Docker** → [DEPLOYMENT.md - Docker 部分](./DEPLOYMENT.md#方案四docker-部署)
- **配置域名和 HTTPS** → [DEPLOYMENT.md - HTTPS 配置](./DEPLOYMENT.md#5-配置-https可选但推荐)
- **遇到问题** → [快速部署.md - 常见问题](./快速部署.md#常见问题)

---

## 🛠️ 配置文件说明

| 文件 | 用途 |
|-----|------|
| `Dockerfile` | Docker 镜像构建配置 |
| `docker-compose.yml` | Docker Compose 部署配置 |
| `ecosystem.config.cjs` | PM2 进程管理配置 |
| `.env.example` | 环境变量示例 |
| `test-deployment.bat` | Windows 部署测试脚本 |
| `test-deployment.sh` | Linux/Mac 部署测试脚本 |

---

## 🎯 3 步快速开始

### 临时玩（1 分钟）
```bash
npm start
ngrok http 3000
# 分享 ngrok 提供的 URL
```

### 长期用（10 分钟）
1. 推送到 GitHub
2. railway.app 部署
3. 添加 Volume 挂载 `/app/data`

### 完全掌控（30 分钟）
查看 [DEPLOYMENT.md](./DEPLOYMENT.md)

---

## ❓ 需要帮助？

1. 先查看 **[快速部署.md - 常见问题](./快速部署.md#常见问题)**
2. 再查看 **[DEPLOYMENT.md - 常见问题](./DEPLOYMENT.md#常见问题)**
3. 检查 **[部署检查清单.md](./部署检查清单.md)** 是否有遗漏

---

祝你部署顺利！🎉
