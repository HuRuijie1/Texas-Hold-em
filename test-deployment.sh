#!/bin/bash
# 快速部署测试脚本

echo "🎮 德州扑克部署测试"
echo "===================="
echo ""

# 检查服务器是否运行
echo "1️⃣ 检查服务器状态..."
if curl -s http://localhost:3000/api/rooms > /dev/null 2>&1; then
    echo "✅ 服务器运行正常"
else
    echo "❌ 服务器未运行，尝试启动..."
    npm start &
    sleep 3
fi

# 获取本机 IP
echo ""
echo "2️⃣ 检测网络地址..."
if command -v ipconfig > /dev/null 2>&1; then
    # Windows
    LOCAL_IP=$(ipconfig | grep "IPv4" | grep -v "127.0.0.1" | head -1 | awk '{print $NF}')
else
    # Linux/Mac
    LOCAL_IP=$(hostname -I | awk '{print $1}')
fi

echo "✅ 本地访问: http://localhost:3000"
echo "✅ 局域网访问: http://$LOCAL_IP:3000"

# 测试 API
echo ""
echo "3️⃣ 测试 API 端点..."
ROOMS=$(curl -s http://localhost:3000/api/rooms)
ROOM_COUNT=$(echo $ROOMS | grep -o '"code"' | wc -l)
echo "✅ 当前房间数: $ROOM_COUNT"

# 提供部署建议
echo ""
echo "📋 部署到公网的选项："
echo ""
echo "🚀 最快速（临时测试）："
echo "   ngrok http 3000"
echo "   → 下载: https://ngrok.com/download"
echo ""
echo "☁️ 推荐方案（长期使用）："
echo "   Railway: https://railway.app"
echo "   → 免费额度，自动 HTTPS"
echo ""
echo "🖥️ 完全掌控（云服务器）："
echo "   pm2 start ecosystem.config.cjs"
echo "   → 查看: DEPLOYMENT.md"
echo ""
echo "🐳 容器化部署："
echo "   docker-compose up -d"
echo ""
echo "📚 详细指南: 查看 快速部署.md 和 部署检查清单.md"
echo ""
echo "部署测试完成！✨"
