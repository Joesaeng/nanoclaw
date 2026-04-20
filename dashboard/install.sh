#!/bin/bash
set -e

NANOCLAW_DIR="$HOME/nanoclaw"
DASHBOARD_DIR="$NANOCLAW_DIR/dashboard"
SERVICE_DIR="$HOME/.config/systemd/user"

echo "📦 NanoClaw 대시보드 설치 시작..."

# 1. 대시보드 폴더 생성
mkdir -p "$DASHBOARD_DIR"

# 2. 파일 복사 (이 스크립트와 같은 위치의 파일들)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$SCRIPT_DIR/server.js" "$DASHBOARD_DIR/"
cp "$SCRIPT_DIR/index.html" "$DASHBOARD_DIR/"
echo "✅ 파일 복사 완료: $DASHBOARD_DIR"

# 3. systemd user 서비스 등록
mkdir -p "$SERVICE_DIR"
cp "$SCRIPT_DIR/nanoclaw-dashboard.service" "$SERVICE_DIR/"
systemctl --user daemon-reload
systemctl --user enable nanoclaw-dashboard
systemctl --user start nanoclaw-dashboard
echo "✅ systemd 서비스 등록 및 시작 완료"

# 4. 상태 확인
sleep 2
systemctl --user status nanoclaw-dashboard --no-pager

echo ""
echo "🌐 대시보드 주소: http://127.0.0.1:3000"
echo "🔑 기본 토큰: nanoclaw-dashboard-2026"
echo "   (변경하려면 $SERVICE_DIR/nanoclaw-dashboard.service 의 DASHBOARD_TOKEN 수정 후"
echo "    systemctl --user daemon-reload && systemctl --user restart nanoclaw-dashboard)"
