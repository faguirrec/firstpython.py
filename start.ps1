<#
.SYNOPSIS
  Levanta Cuentas del Hogar en Windows con un solo comando.

.DESCRIPTION
  Detiene el servidor anterior, compila el frontend y el backend, y arranca la
  app en http://localhost:4000. Se detiene apenas algo falla, diciendo qué paso
  fue, para no dejar la app a medio andar.

.EXAMPLE
  .\start.ps1
  Actualiza, compila y arranca conservando los datos.

.EXAMPLE
  .\start.ps1 -Fresh
  Además borra la base de datos y parte de cero. Ojo: borra los movimientos.

.EXAMPLE
  .\start.ps1 -SkipBuild
  Arranca sin recompilar, cuando no cambió nada.
#>
param(
  [switch]$Fresh,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$step = 0

function Write-Step($text) {
  $script:step += 1
  Write-Host ""
  Write-Host "[$script:step] $text" -ForegroundColor Cyan
}

function Fail($text) {
  Write-Host ""
  Write-Host "FALLO en el paso $script:step - $text" -ForegroundColor Red
  Write-Host "Copia todo lo que salio arriba para poder diagnosticarlo." -ForegroundColor Yellow
  exit 1
}

# npm.cmd evita el bloqueo de scripts de PowerShell (npm.ps1).
$npm = 'npm'
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($npmCmd) { $npm = $npmCmd.Source }

function Invoke-Npm($workDir, $arguments, $what) {
  Push-Location $workDir
  try {
    & $npm @arguments
    if ($LASTEXITCODE -ne 0) { Fail $what }
  } finally {
    Pop-Location
  }
}

Write-Host "Cuentas del Hogar" -ForegroundColor Green

Write-Step "Comprobando Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js no esta instalado o no esta en el PATH. Instalalo desde https://nodejs.org y abre PowerShell de nuevo."
}
$nodeVersion = & node -v
$major = [int]($nodeVersion -replace '^v(\d+)\..*$', '$1')
if ($major -lt 20) { Fail "Node $nodeVersion es muy antiguo. Se necesita 20 o superior." }
Write-Host "    Node $nodeVersion"

Write-Step "Cerrando servidores anteriores de esta app"
# Sólo los node que corren desde esta carpeta: no toca los de VS Code ni otros proyectos.
$mine = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) })
if ($mine.Count -gt 0) {
  foreach ($p in $mine) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Write-Host "    $($mine.Count) proceso(s) detenido(s)"
} else {
  Write-Host "    No habia ninguno corriendo"
}

if (-not $SkipBuild) {
  Write-Step "Instalando dependencias del frontend"
  Invoke-Npm "$root\web" @('install', '--no-audit', '--no-fund') "no se pudieron instalar las dependencias de web/"

  Write-Step "Compilando el frontend"
  Invoke-Npm "$root\web" @('run', 'build') "no compilo el frontend"

  Write-Step "Instalando dependencias del backend"
  Invoke-Npm "$root\server" @('install', '--no-audit', '--no-fund') "no se pudieron instalar las dependencias de server/"

  Write-Step "Compilando el backend"
  Invoke-Npm "$root\server" @('run', 'build') "no compilo el backend"
}

Write-Step "Preparando la configuracion"
$envFile = "$root\server\.env"
if (-not (Test-Path $envFile)) {
  Copy-Item "$root\server\.env.example" $envFile
  Write-Host "    server\.env creado a partir del ejemplo"
} else {
  Write-Host "    server\.env ya existia, se respeta"
}

if ($Fresh) {
  Write-Step "Borrando la base de datos (-Fresh)"
  Remove-Item -Recurse -Force "$root\server\data" -ErrorAction SilentlyContinue
  Write-Host "    Listo, se parte de cero"
}

Write-Step "Revisando el firewall"
try {
  if (Get-NetFirewallRule -DisplayName 'Cuentas del Hogar' -ErrorAction SilentlyContinue) {
    Write-Host "    Regla encontrada: el telefono puede conectarse"
  } else {
    Write-Host "    Falta la regla para el puerto 4000." -ForegroundColor Yellow
    Write-Host "    Si el iPhone no carga la pagina, abre PowerShell COMO ADMINISTRADOR y corre:" -ForegroundColor Yellow
    Write-Host "    New-NetFirewallRule -DisplayName 'Cuentas del Hogar' -Direction Inbound -LocalPort 4000 -Protocol TCP -Action Allow" -ForegroundColor Yellow
  }
} catch {
  Write-Host "    No se pudo revisar el firewall, no es grave"
}

Write-Step "Buscando la direccion de red"
$ip = $null
try {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'Loopback|vEthernet|WSL|VirtualBox|VMware' } |
    Select-Object -First 1).IPAddress
} catch {
  # Sin este dato la app igual funciona en el propio computador.
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor Green
Write-Host " En este computador:  http://localhost:4000"
if ($ip) {
  Write-Host " Desde el iPhone:     http://${ip}:4000"
  Write-Host ""
  Write-Host " Para invitar a la otra persona con el QR, abre la"
  Write-Host " app por la direccion de red, no por localhost."
}
Write-Host ""
Write-Host " Detener: Ctrl+C" -ForegroundColor DarkGray
Write-Host "======================================================" -ForegroundColor Green
Write-Host ""

Push-Location "$root\server"
try {
  & $npm start
} finally {
  Pop-Location
}
