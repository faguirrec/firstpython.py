<#
.SYNOPSIS
  Publica MyHaus en Fly.io.

.DESCRIPTION
  Hace todo lo que se puede hacer sin intervención: instala flyctl, crea la app
  y el disco, genera y guarda los secretos, despliega y deja una sola máquina
  corriendo. Se detiene indicando el paso exacto si algo falla, y se puede
  volver a correr sin romper nada: los pasos ya hechos los detecta y los salta.

  Lo único que te va a pedir a ti es iniciar sesión en Fly.io desde el navegador.

.EXAMPLE
  .\deploy.ps1
  Te propone un nombre disponible y publica.

.EXAMPLE
  .\deploy.ps1 -AppName cuentas-hogar-a7k2
  Usa ese nombre.
#>
param(
  [string]$AppName
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
  Write-Host "Copia todo lo de arriba para poder diagnosticarlo. Los pasos ya hechos" -ForegroundColor Yellow
  Write-Host "quedan hechos: puedes volver a correr .\deploy.ps1 cuando se resuelva." -ForegroundColor Yellow
  exit 1
}

# Corre flyctl sin abortar el script; devuelve si funcionó y qué imprimió.
function Try-Fly {
  param([string[]]$Arguments)
  $output = & fly @Arguments 2>&1 | Out-String
  return @{ Ok = ($LASTEXITCODE -eq 0); Output = $output.Trim() }
}

function Invoke-Fly {
  param([string[]]$Arguments, [string]$What)
  & fly @Arguments
  if ($LASTEXITCODE -ne 0) { Fail $What }
}

Write-Host "Publicar MyHaus" -ForegroundColor Green

# --------------------------------------------------------------------------
Write-Step "Instalando flyctl"
if (Get-Command fly -ErrorAction SilentlyContinue) {
  Write-Host "    Ya estaba instalado"
} else {
  try {
    Invoke-WebRequest -Uri 'https://fly.io/install.ps1' -UseBasicParsing | Select-Object -ExpandProperty Content | Invoke-Expression
  } catch {
    Fail "no se pudo instalar flyctl. Instalalo a mano desde https://fly.io/docs/flyctl/install/"
  }
  # El instalador no refresca el PATH de esta ventana; se agrega a mano.
  $flyBin = Join-Path $env:USERPROFILE '.fly\bin'
  if (Test-Path $flyBin) { $env:PATH = "$flyBin;$env:PATH" }
  if (-not (Get-Command fly -ErrorAction SilentlyContinue)) {
    Fail "flyctl se instalo pero no quedo en el PATH. Cierra y abre PowerShell, y vuelve a correr .\deploy.ps1"
  }
  Write-Host "    Instalado"
}

# --------------------------------------------------------------------------
Write-Step "Revisando tu sesion de Fly.io"
$who = Try-Fly @('auth', 'whoami')
if ($who.Ok) {
  Write-Host "    Conectado como $($who.Output)"
} else {
  Write-Host "    Se va a abrir el navegador para que inicies sesion o crees tu cuenta." -ForegroundColor Yellow
  Write-Host "    Fly.io pide una tarjeta para verificar la cuenta." -ForegroundColor Yellow
  & fly auth login
  if ($LASTEXITCODE -ne 0) { Fail "no se pudo iniciar sesion en Fly.io" }
  $who = Try-Fly @('auth', 'whoami')
  if (-not $who.Ok) { Fail "la sesion no quedo activa" }
  Write-Host "    Conectado como $($who.Output)"
}

# --------------------------------------------------------------------------
Write-Step "Definiendo el nombre de la app"
if (-not $AppName) {
  # El nombre es la direccion publica: conviene que no sea adivinable.
  $sufijo = -join ((1..4) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
  $AppName = "cuentas-hogar-$sufijo"
}
if ($AppName -notmatch '^[a-z0-9][a-z0-9-]{2,29}$') {
  Fail "el nombre '$AppName' no sirve: solo minusculas, numeros y guiones, entre 3 y 30 caracteres"
}
Write-Host "    $AppName  ->  https://$AppName.fly.dev"

Write-Step "Escribiendo el nombre en fly.toml"
$tomlPath = Join-Path $root 'fly.toml'
$toml = Get-Content $tomlPath -Raw
$toml = $toml -replace '(?m)^app\s*=\s*".*"$', "app = `"$AppName`""
Set-Content -Path $tomlPath -Value $toml -NoNewline -Encoding UTF8
Write-Host "    Listo"

# --------------------------------------------------------------------------
Write-Step "Creando la app"
$existe = Try-Fly @('status', '--app', $AppName)
if ($existe.Ok) {
  Write-Host "    Ya existia, se reutiliza"
} else {
  $creada = Try-Fly @('apps', 'create', $AppName)
  if (-not $creada.Ok) {
    if ($creada.Output -match 'taken|already') {
      Fail "el nombre '$AppName' ya lo tomo otra persona. Corre: .\deploy.ps1 -AppName otro-nombre-distinto"
    }
    Write-Host $creada.Output
    Fail "no se pudo crear la app"
  }
  Write-Host "    Creada"
}

# --------------------------------------------------------------------------
Write-Step "Creando el disco de datos"
# Sin volumen, cada despliegue borraria todos los movimientos.
$vols = Try-Fly @('volumes', 'list', '--app', $AppName)
if ($vols.Ok -and $vols.Output -match 'datos') {
  Write-Host "    Ya existia, se conserva con sus datos"
} else {
  Invoke-Fly @('volumes', 'create', 'datos', '--size', '1', '--region', 'scl', '--app', $AppName, '--yes') "no se pudo crear el volumen"
  Write-Host "    Creado (1 GB en Santiago)"
}

# --------------------------------------------------------------------------
Write-Step "Configurando los secretos"
$secretos = Try-Fly @('secrets', 'list', '--app', $AppName)
if ($secretos.Ok -and $secretos.Output -match 'JWT_SECRET') {
  Write-Host "    JWT_SECRET ya estaba, no se toca (cambiarlo cerraria las sesiones)"
} else {
  $clave = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
  Invoke-Fly @('secrets', 'set', "JWT_SECRET=$clave", '--app', $AppName, '--stage') "no se pudo guardar JWT_SECRET"
  Write-Host "    JWT_SECRET generado y guardado"
}
Invoke-Fly @('secrets', 'set', "WEB_ORIGIN=https://$AppName.fly.dev", '--app', $AppName, '--stage') "no se pudo guardar WEB_ORIGIN"
Write-Host "    WEB_ORIGIN configurado"

# --------------------------------------------------------------------------
Write-Step "Publicando (la primera vez demora algunos minutos)"
Invoke-Fly @('deploy', '--remote-only', '--app', $AppName) "no se pudo desplegar. Revisa el detalle con: fly logs --app $AppName"

# --------------------------------------------------------------------------
Write-Step "Dejando una sola maquina"
# Con SQLite dos maquinas serian dos copias distintas de los datos.
Invoke-Fly @('scale', 'count', '1', '--app', $AppName, '--yes') "no se pudo ajustar la cantidad de maquinas"

# --------------------------------------------------------------------------
Write-Step "Comprobando que responde"
$url = "https://$AppName.fly.dev"
$ok = $false
foreach ($intento in 1..12) {
  Start-Sleep -Seconds 5
  try {
    $r = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 10
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {
    Write-Host "    Intento $intento..." -ForegroundColor DarkGray
  }
}
if (-not $ok) { Fail "la app quedo publicada pero no respondio. Revisa: fly logs --app $AppName" }

Write-Host ""
Write-Host "======================================================" -ForegroundColor Green
Write-Host " Tu app esta online:" -ForegroundColor Green
Write-Host ""
Write-Host "   $url"
Write-Host ""
Write-Host " Que sigue, en orden:"
Write-Host "   1. Abre esa direccion y crea tu cuenta (la primera no"
Write-Host "      necesita codigo) y despues el hogar."
Write-Host "   2. En Ajustes -> Hogar comparte el QR con la otra persona."
Write-Host "   3. Cuando ambos esten adentro, cierra el registro:"
Write-Host "      fly secrets set ALLOW_SIGNUP=closed --app $AppName"
Write-Host "   4. En el iPhone: abre la direccion en Safari, Compartir,"
Write-Host "      Agregar a pantalla de inicio."
Write-Host ""
Write-Host " Para actualizar mas adelante:  git pull; fly deploy --remote-only"
Write-Host "======================================================" -ForegroundColor Green
