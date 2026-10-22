@echo off
chcp 65001 >nul
rem Windows：双击启动「多发」。真正的启动步骤在 scripts\start.js（Mac 的 启动多发.command 也调用它）
cd /d "%~dp0"
title 多发

where node >/dev/null 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。请先安装 Node.js 22 或更新版本：https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)

node scripts\start.js
if errorlevel 1 pause
