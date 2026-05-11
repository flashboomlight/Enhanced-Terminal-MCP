@echo off
echo ============================================
echo   Enhanced Terminal MCP - One-Click Setup
echo ============================================
echo.

cd /d "%~dp0"

echo [1/3] Checking Node.js...
node -v
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo.
echo [2/3] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed!
    pause
    exit /b 1
)

echo.
echo [3/3] Building TypeScript...
call npx tsc
if %errorlevel% neq 0 (
    echo ERROR: TypeScript build failed!
    pause
    exit /b 1
)

echo.
echo ============================================
echo   BUILD SUCCESS!
echo ============================================
echo.
echo Output: %~dp0build\index.js
echo.
echo To test: node build\index.js
echo.
pause
