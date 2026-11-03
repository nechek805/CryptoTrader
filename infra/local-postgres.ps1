param(
    [ValidateSet('Start', 'Stop')][string]$Action = 'Start',
    [string]$BinDir = 'C:\Program Files\PostgreSQL\18\bin',
    [ValidateRange(0, 65535)][int]$Port = 0
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskTools = Join-Path $taskRoot '.tools'
$taskData = Join-Path $taskTools 'postgres-fixtures'
$taskPortFile = Join-Path $taskTools 'postgres-fixtures.port'
$taskPgCtl = Join-Path $BinDir 'pg_ctl.exe'
$taskInitDb = Join-Path $BinDir 'initdb.exe'
if (-not (Test-Path -LiteralPath $taskPgCtl)) { throw 'PostgreSQL binaries not found. Supply -BinDir.' }

if ($Action -eq 'Stop') {
    if (Test-Path -LiteralPath (Join-Path $taskData 'PG_VERSION')) {
        & $taskPgCtl -D $taskData -w -m fast stop
        if ($LASTEXITCODE -ne 0) { throw 'Could not stop the project fixture cluster.' }
    }
    return
}

New-Item -ItemType Directory -Path $taskTools -Force | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $taskData 'PG_VERSION'))) {
    & $taskInitDb -D $taskData -U research -A trust --encoding=UTF8 --locale=C
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the project fixture cluster.' }
}
$taskStatus = & $taskPgCtl -D $taskData status 2>&1
if ($LASTEXITCODE -eq 0) {
    if (-not (Test-Path -LiteralPath $taskPortFile)) { throw 'Running fixture cluster has no port record.' }
    $taskSelectedPort = [int](Get-Content -Raw -LiteralPath $taskPortFile).Trim()
} else {
    # Windows may reserve large port ranges. Ask the OS for an available loopback port.
    $taskListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $taskListener.Start()
    $taskSelectedPort = $taskListener.LocalEndpoint.Port
    $taskListener.Stop()
    & $taskPgCtl -D $taskData -l (Join-Path $taskTools 'postgres-fixtures.log') `
        -o "-h 127.0.0.1 -p $taskSelectedPort -c timezone=UTC -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 -c log_error_verbosity=terse" -w start
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the project fixture cluster. Inspect .tools/postgres-fixtures.log.' }
    Set-Content -LiteralPath $taskPortFile -Value $taskSelectedPort
}
if ($taskSelectedPort -lt 1 -or $taskSelectedPort -gt 65535) { throw 'Invalid fixture port record.' }
$env:DATABASE_URL = "postgresql://research@127.0.0.1:$taskSelectedPort/postgres"
$env:TEST_DATABASE_URL = $env:DATABASE_URL
$env:DATABASE_SCHEMA = 'crypto_fixture_local'
Write-Output "Project fixture PostgreSQL is ready on 127.0.0.1:$taskSelectedPort. DATABASE_URL, TEST_DATABASE_URL and DATABASE_SCHEMA are set for this PowerShell session."
