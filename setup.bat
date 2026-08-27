@echo off
echo ============================================
echo   Enhanced Terminal MCP - One-Click Setup
echo ============================================
echo.

cd /d "%~dp0"

echo [1/5] Checking Node.js...
node -v
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo.
echo [2/5] Checking pnpm...
call corepack pnpm --version
if %errorlevel% neq 0 (
    echo ERROR: pnpm 11.21.0 is not available!
    echo Please install Node.js 20+ with Corepack, or install pnpm 11.21.0 manually.
    pause
    exit /b 1
)

echo.
echo [3/5] Installing dependencies with the pinned pnpm version...
call corepack pnpm install --frozen-lockfile
if %errorlevel% neq 0 (
    echo ERROR: pnpm install failed!
    pause
    exit /b 1
)

echo.
echo [4/5] Building TypeScript...
call corepack pnpm run build
if %errorlevel% neq 0 (
    echo ERROR: TypeScript build failed!
    pause
    exit /b 1
)

echo.
echo [5/5] Ensuring bundled pwsh 7 (Windows default shell)...
if "%~1"=="--no-pwsh" (
    echo Skipped by --no-pwsh. Runtime will fall back to Windows PowerShell 5.1.
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-pwsh.ps1
    if errorlevel 1 (
        echo.
        echo ERROR: bundled pwsh install failed!
        echo The MCP server will still run, falling back to Windows PowerShell 5.1.
        echo Fix network access and re-run setup.bat, or use --no-pwsh to skip.
        pause
        exit /b 1
    )
)

echo.
echo ============================================
echo   SETUP COMPLETE!
echo ============================================
echo.
echo Output: %~dp0build\index.js
echo.
echo To test: node build\index.js
echo.
pause
