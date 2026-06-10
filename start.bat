@echo off
cd /d "C:\Users\Rafi\notion-todoist-sync"
echo. > logs\app.log
node src/index.js >> logs\app.log 2>&1