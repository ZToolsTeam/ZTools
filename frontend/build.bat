@echo off
setlocal

REM 构建脚本（占位）：如需构建，请安装 Node.js 并在 Frontend 目录执行
REM npm ci && npm run build

set FRONTEND_DIR=%~dp0
cd /d "%FRONTEND_DIR%"

echo === ZTools Frontend Build ===
echo 提示：当前按要求跳过环境部署与实际构建，仅做占位
echo 如需构建，请在本目录执行：
echo npm ci

echo npm run build

echo 构建输出将位于: dist\

echo 复制构建产物到应用目录（占位）：
REM xcopy /e /i /y dist "..\WebResources\frontend-dist\"

echo 完成
endlocal
