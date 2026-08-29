@echo off
setlocal
echo ============================================
echo   Enhanced Terminal MCP - One-Click Setup
echo ============================================
echo.

cd /d "%~dp0"

set "NON_INTERACTIVE=0"
set "NO_PWSH=0"
if /I "%~1"=="--non-interactive" set "NON_INTERACTIVE=1"
if /I "%~2"=="--non-interactive" set "NON_INTERACTIVE=1"
if /I "%~1"=="--no-pwsh" set "NO_PWSH=1"
if /I "%~2"=="--no-pwsh" set "NO_PWSH=1"

echo [1/5] Checking Node.js...
node -v
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    call :maybe_pause
    exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR (
    echo ERROR: Could not determine the Node.js major version.
    call :maybe_pause
    exit /b 1
)
if %NODE_MAJOR% LSS 22 (
    echo ERROR: Node.js 22.13 or newer is required by the pinned pnpm 11.21 toolchain.
    call :maybe_pause
    exit /b 1
)

echo.
echo [2/5] Checking pnpm...
set "PNPM_VERSION="
for /f "delims=" %%v in ('corepack pnpm --version') do set "PNPM_VERSION=%%v"
if not defined PNPM_VERSION (
    echo ERROR: pnpm 11.21.0 is not available!
    echo Please install Node.js 22.13+ with Corepack, or install pnpm 11.21.0 manually.
    call :maybe_pause
    exit /b 1
)
if not "%PNPM_VERSION%"=="11.21.0" (
    echo ERROR: Expected pnpm 11.21.0 but found %PNPM_VERSION%.
    echo Enable the packageManager-pinned Corepack version and retry.
    call :maybe_pause
    exit /b 1
)
echo pnpm %PNPM_VERSION%

echo.
echo [3/5] Installing dependencies with the pinned pnpm version...
call corepack pnpm install --frozen-lockfile
if %errorlevel% neq 0 (
    echo ERROR: pnpm install failed!
    call :maybe_pause
    exit /b 1
)

echo.
echo [4/5] Building TypeScript...
call corepack pnpm run build
if %errorlevel% neq 0 (
    echo ERROR: TypeScript build failed!
    call :maybe_pause
    exit /b 1
)

echo.
echo [5/5] Ensuring bundled pwsh 7 (Windows default shell)...
if "%NO_PWSH%"=="1" (
    echo Skipped by --no-pwsh. Runtime will fall back to Windows PowerShell 5.1.
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-pwsh.ps1
    if errorlevel 1 (
        echo.
        echo ERROR: bundled pwsh install failed!
        echo The MCP server will still run, falling back to Windows PowerShell 5.1.
        echo Fix network access and re-run setup.bat, or use --no-pwsh to skip.
        call :maybe_pause
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
call :maybe_pause
exit /b 0

:maybe_pause
if "%NON_INTERACTIVE%"=="0" pause
exit /b 0
