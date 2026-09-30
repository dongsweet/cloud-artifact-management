@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%hillstone-vpn.ps1"

if not "%~1"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
  exit /b %ERRORLEVEL%
)

:menu
cls
echo.
echo =========================================
echo   CAM Hillstone VPN Menu
echo =========================================
echo   [1] start       Start remote container and open noVNC
echo   [2] stop        Stop remote container and local tunnel
echo   [3] restart     Recreate remote container and route
echo   [4] status      Show container, route and tunnel status
echo   [5] target-test Test the configured research file URL
echo   [0] exit
echo.
echo   noVNC: http://127.0.0.1:16081
echo.
set "selection="
set /p "selection=Choose 1-5 or 0 to exit: "
if "%selection%"=="1" set "action=start"
if "%selection%"=="2" set "action=stop"
if "%selection%"=="3" set "action=restart"
if "%selection%"=="4" set "action=status"
if "%selection%"=="5" set "action=target-test"
if /i "%selection%"=="start" set "action=start"
if /i "%selection%"=="stop" set "action=stop"
if /i "%selection%"=="restart" set "action=restart"
if /i "%selection%"=="status" set "action=status"
if /i "%selection%"=="test" set "action=target-test"
if "%selection%"=="0" goto end
if not defined action (
  echo Invalid selection: %selection%
  pause
  goto menu
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %action%
set "action="
pause
goto menu

:end
endlocal
exit /b 0
